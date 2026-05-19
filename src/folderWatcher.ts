import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

export interface FolderWatcherOptions {
  /** Extensions to match, e.g. [".log", ".txt"]. Case-insensitive. */
  extensions: string[];
  /** Directory names to skip during scan/watch (basenames only). */
  excludeDirs?: string[];
  /** Substrings (in absolute path) that exclude a file. */
  excludeGlobs?: string[];
  /** Fallback rescan interval (ms) when recursive watch is unavailable or to catch missed events. */
  rescanIntervalMs?: number;
  /** Wait this many ms after a create event before attaching, so the writer can begin. */
  settleMs?: number;
}

/**
 * Watches a folder tree for log files matching a set of extensions.
 *
 *   - Emits 'file' (absolutePath: string) for every matching file discovered,
 *     both during the initial scan and afterward when new files appear.
 *   - Emits 'remove' (absolutePath: string) when a previously-seen file disappears
 *     (caller may choose to stop tailing it; we just notify).
 *   - Emits 'error' (Error) for non-fatal issues.
 *
 * Strategy:
 *   1) Initial recursive scan to seed the known set.
 *   2) Try recursive fs.watch (works on Windows/macOS, Linux on newer kernels).
 *   3) Always run a periodic rescan as a safety net (handles missed events,
 *      networked filesystems, WSL edge cases).
 */
export class FolderWatcher extends EventEmitter {
  readonly root: string;
  private extensions: Set<string>;
  private excludeDirs: Set<string>;
  private excludeGlobs: string[];
  private rescanIntervalMs: number;
  private settleMs: number;

  private known = new Set<string>();
  private pendingSettle = new Map<string, NodeJS.Timeout>();
  private watcher?: fs.FSWatcher;
  private rescanTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(root: string, opts: FolderWatcherOptions) {
    super();
    this.root = path.resolve(root);
    this.extensions = new Set(opts.extensions.map((e) => normExt(e)));
    this.excludeDirs = new Set(opts.excludeDirs ?? ["node_modules", ".git", ".hg", ".svn", "dist", "out", ".next", ".cache"]);
    this.excludeGlobs = opts.excludeGlobs ?? [];
    this.rescanIntervalMs = opts.rescanIntervalMs ?? 5000;
    this.settleMs = opts.settleMs ?? 250;
  }

  async start() {
    await this.scan(this.root, /*emit*/ true);
    this.startWatch();
    this.rescanTimer = setInterval(() => {
      void this.scan(this.root, /*emit*/ true).then(() => this.detectRemovals());
    }, this.rescanIntervalMs);
  }

  /** Update the matched extensions live (re-scans existing tree to pick up newly-included files). */
  setExtensions(exts: string[]) {
    this.extensions = new Set(exts.map(normExt));
    void this.scan(this.root, true);
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { try { this.watcher.close(); } catch { /* noop */ } this.watcher = undefined; }
    if (this.rescanTimer) { clearInterval(this.rescanTimer); this.rescanTimer = undefined; }
    for (const t of this.pendingSettle.values()) clearTimeout(t);
    this.pendingSettle.clear();
  }

  private startWatch() {
    try {
      // Recursive watch; on Linux kernels < 5 this throws ENOSYS — we'll rely on periodic rescan.
      this.watcher = fs.watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (this.stopped || !filename) return;
        const abs = path.resolve(this.root, filename.toString());
        // Schedule a settle, then check whether it should be added.
        this.scheduleSettle(abs);
      });
      this.watcher.on("error", (e) => this.emit("error", e));
    } catch {
      // Recursive watch not supported — periodic rescan handles it.
    }
  }

  private scheduleSettle(abs: string) {
    const prev = this.pendingSettle.get(abs);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pendingSettle.delete(abs);
      this.consider(abs).catch((e) => this.emit("error", e));
    }, this.settleMs);
    this.pendingSettle.set(abs, t);
  }

  /** Examine a path: if it's a matching file, emit 'file' (once). */
  private async consider(abs: string) {
    if (this.stopped) return;
    if (!this.matches(abs)) return;
    if (this.known.has(abs)) return;
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(abs); } catch { return; }
    if (!stat.isFile()) return;
    this.known.add(abs);
    this.emit("file", abs);
  }

  private matches(abs: string): boolean {
    const base = path.basename(abs);
    if (base.startsWith(".")) {
      // allow hidden files only if ext matches and not excluded
    }
    const ext = path.extname(base).toLowerCase();
    if (!this.extensions.has(ext)) return false;
    // Exclude by directory segments
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..")) return false;
    const segs = rel.split(path.sep);
    for (const s of segs.slice(0, -1)) if (this.excludeDirs.has(s)) return false;
    for (const g of this.excludeGlobs) if (abs.includes(g)) return false;
    return true;
  }

  /** Recursive scan: walks the tree and emits 'file' for each match not yet known. */
  private async scan(dir: string, emit: boolean): Promise<void> {
    if (this.stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      // permission denied, etc — ignore
      return;
    }
    for (const e of entries) {
      if (this.stopped) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (this.excludeDirs.has(e.name)) continue;
        await this.scan(abs, emit);
      } else if (e.isFile()) {
        if (emit) await this.consider(abs);
      }
      // symlinks intentionally skipped to avoid loops
    }
  }

  /** After a rescan, check which previously-known files are gone and emit 'remove'. */
  private async detectRemovals() {
    if (this.stopped) return;
    for (const abs of [...this.known]) {
      try {
        const s = await fs.promises.stat(abs);
        if (!s.isFile()) {
          this.known.delete(abs);
          this.emit("remove", abs);
        }
      } catch {
        this.known.delete(abs);
        this.emit("remove", abs);
      }
    }
  }
}

function normExt(e: string): string {
  const x = e.trim().toLowerCase();
  if (!x) return "";
  return x.startsWith(".") ? x : "." + x;
}
