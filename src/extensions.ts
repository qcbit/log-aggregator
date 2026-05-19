import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FileTail } from "./tail";
import { OutputChannelSink, Sink, TerminalSink } from "./sink";
import { FolderWatcher } from "./folderWatcher";

const STATE_FOLLOWED = "logAggregator.followedFiles";
const STATE_WATCHED = "logAggregator.watchedFolders";

// ANSI color cycle for per-file prefixes (terminal sink only; output channel ignores ANSI).
const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[32m", "\x1b[35m", "\x1b[34m", "\x1b[31m", "\x1b[37m"];
const RESET = "\x1b[0m";

interface Followed {
  tail: FileTail;
  label: string;
  color: string;
}

interface WatchedFolder {
  root: string;
  watcher: FolderWatcher;
}

class Aggregator {
  private followed = new Map<string, Followed>();
  private watched = new Map<string, WatchedFolder>();
  private sink: Sink | undefined;
  private sinkKind: "output" | "terminal" = "output";
  private status: vscode.StatusBarItem;
  private include?: RegExp;
  private exclude?: RegExp;
  private showPrefix = true;
  private showTimestamp = false;
  private watchExtensions: string[] = [".log", ".txt"];
  private watchExcludeDirs: string[] = ["node_modules", ".git", ".hg", ".svn", "dist", "out", ".next", ".cache"];

  constructor(private context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "logAggregator.manage";
    this.status.tooltip = "Log Aggregator — click to manage followed files";
    context.subscriptions.push(this.status);
    this.refreshConfig();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("logAggregator")) this.refreshConfig();
      })
    );
    this.updateStatus();
  }

  private refreshConfig() {
    const cfg = vscode.workspace.getConfiguration("logAggregator");
    const newSink = cfg.get<"output" | "terminal">("sink", "output");
    if (newSink !== this.sinkKind) {
      this.sinkKind = newSink;
      this.recreateSink();
    }
    this.showPrefix = cfg.get<boolean>("showFilePrefix", true);
    this.showTimestamp = cfg.get<boolean>("showTimestamp", false);
    const inc = cfg.get<string>("includeRegex", "") || "";
    const exc = cfg.get<string>("excludeRegex", "") || "";
    this.include = inc ? safeRegex(inc) : undefined;
    this.exclude = exc ? safeRegex(exc) : undefined;
    const exts = cfg.get<string[]>("watchExtensions", [".log", ".txt"]);
    this.watchExtensions = (exts && exts.length ? exts : [".log", ".txt"]).map((e) => e.trim()).filter(Boolean);
    const exdirs = cfg.get<string[]>("watchExcludeDirs", []);
    if (exdirs && exdirs.length) this.watchExcludeDirs = exdirs;
    // Push extension changes to live watchers
    for (const w of this.watched.values()) w.watcher.setExtensions(this.watchExtensions);
  }

  private ensureSink(): Sink {
    if (!this.sink) {
      const fresh =
        this.sinkKind === "terminal"
          ? new TerminalSink("Log Aggregator")
          : new OutputChannelSink("Log Aggregator");
      // If the user closes the terminal manually, drop our reference so the
      // next write/show recreates a brand-new terminal automatically.
      fresh.onClosed(() => {
        if (this.sink === fresh) {
          this.sink = undefined;
          // Don't re-show right away; the next onLine() will lazily call ensureSink()
          // which will build a new terminal AND call show() on it below.
        }
      });
      this.sink = fresh;
      // Auto-show only on first creation OR after a recreate. Cheap and idempotent.
      fresh.show();
    }
    return this.sink;
  }

  private recreateSink() {
    if (this.sink) {
      this.sink.dispose();
      this.sink = undefined;
    }
    if (this.followed.size > 0) {
      this.ensureSink().show();
    }
  }

  async addFiles(uris: vscode.Uri[]) {
    const cfg = vscode.workspace.getConfiguration("logAggregator");
    const fromBeginning = cfg.get<boolean>("fromBeginning", false);
    const pollIntervalMs = cfg.get<number>("pollIntervalMs", 500);

    let added = 0;
    for (const uri of uris) {
      const fp = uri.fsPath;
      if (this.followed.has(fp)) continue;
      try {
        await fs.promises.access(fp, fs.constants.R_OK);
      } catch {
        vscode.window.showWarningMessage(`Cannot read: ${fp}`);
        continue;
      }
      const label = path.basename(fp);
      const color = COLORS[this.followed.size % COLORS.length];
      const tail = new FileTail(fp, { fromBeginning, pollIntervalMs });
      const entry: Followed = { tail, label, color };
      tail.on("line", (line: string) => this.onLine(entry, line));
      tail.on("rotate", () => this.onSystem(entry, "[file rotated/truncated]"));
      tail.on("error", (e: Error) => this.onSystem(entry, `[error] ${e.message}`));
      this.followed.set(fp, entry);
      added++;
    }
    if (added > 0) {
      this.ensureSink().show();
      this.persist();
      this.updateStatus();
    }
  }

  removeFile(fp: string) {
    const f = this.followed.get(fp);
    if (!f) return;
    f.tail.stop();
    this.followed.delete(fp);
    this.persist();
    this.updateStatus();
  }

  stopAll() {
    for (const f of this.followed.values()) f.tail.stop();
    this.followed.clear();
    for (const w of this.watched.values()) w.watcher.stop();
    this.watched.clear();
    if (this.sink) {
      this.sink.dispose();
      this.sink = undefined;
    }
    this.persist();
    this.persistWatched();
    this.updateStatus();
  }

  /** Begin watching a folder for files matching the configured extensions. */
  async watchFolder(root: string) {
    const abs = path.resolve(root);
    if (this.watched.has(abs)) {
      // Already watching — but the user may have closed the terminal/output.
      // Re-show the sink (creating one if needed) and re-emit existing followed
      // files so the user sees activity immediately instead of nothing.
      const sink = this.ensureSink();
      sink.show();
      vscode.window.setStatusBarMessage(
        `Log Aggregator: already watching ${abs} — reattached output`,
        4000
      );
      return;
    }
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isDirectory()) {
        vscode.window.showWarningMessage(`Not a folder: ${abs}`);
        return;
      }
    } catch {
      vscode.window.showWarningMessage(`Cannot access: ${abs}`);
      return;
    }
    const watcher = new FolderWatcher(abs, {
      extensions: this.watchExtensions,
      excludeDirs: this.watchExcludeDirs,
    });
    watcher.on("file", (filePath: string) => {
      // Auto-add discovered file to the aggregator
      void this.addFiles([vscode.Uri.file(filePath)]);
    });
    watcher.on("error", (e: Error) => {
      // Non-fatal: surface in the sink so the user knows
      const sink = this.ensureSink();
      sink.write(`[watcher:${path.basename(abs)}] error: ${e.message}`);
    });
    this.watched.set(abs, { root: abs, watcher });
    await watcher.start();
    this.persistWatched();
    this.updateStatus();
    vscode.window.setStatusBarMessage(
      `Log Aggregator: watching ${abs} for ${this.watchExtensions.join(", ")}`,
      4000
    );
  }

  unwatchFolder(root: string) {
    const w = this.watched.get(path.resolve(root));
    if (!w) return;
    w.watcher.stop();
    this.watched.delete(w.root);
    this.persistWatched();
    this.updateStatus();
  }

  listWatched(): string[] { return [...this.watched.keys()]; }

  toggleSink() {
    this.sinkKind = this.sinkKind === "output" ? "terminal" : "output";
    void vscode.workspace
      .getConfiguration("logAggregator")
      .update("sink", this.sinkKind, vscode.ConfigurationTarget.Workspace);
    this.recreateSink();
    vscode.window.showInformationMessage(`Log Aggregator sink: ${this.sinkKind}`);
  }

  clearOutput() { this.sink?.clear(); }

  list(): { path: string; label: string }[] {
    return [...this.followed.entries()].map(([p, v]) => ({ path: p, label: v.label }));
  }

  private onLine(entry: Followed, line: string) {
    if (this.include && !this.include.test(line)) return;
    if (this.exclude && this.exclude.test(line)) return;
    const sink = this.ensureSink();
    const parts: string[] = [];
    if (this.showTimestamp) {
      const d = new Date();
      parts.push(`[${d.toLocaleTimeString()}]`);
    }
    if (this.showPrefix) {
      if (this.sinkKind === "terminal") {
        parts.push(`${entry.color}[${entry.label}]${RESET}`);
      } else {
        parts.push(`[${entry.label}]`);
      }
    }
    parts.push(line);
    sink.write(parts.join(" "));
  }

  private onSystem(entry: Followed, msg: string) {
    const sink = this.ensureSink();
    if (this.sinkKind === "terminal") {
      sink.write(`${entry.color}[${entry.label}]${RESET} \x1b[90m${msg}${RESET}`);
    } else {
      sink.write(`[${entry.label}] ${msg}`);
    }
  }

  private persist() {
    const paths = [...this.followed.keys()];
    void this.context.workspaceState.update(STATE_FOLLOWED, paths);
  }

  private persistWatched() {
    void this.context.workspaceState.update(STATE_WATCHED, [...this.watched.keys()]);
  }

  async restore() {
    const saved = this.context.workspaceState.get<string[]>(STATE_FOLLOWED, []);
    const existing: vscode.Uri[] = [];
    for (const p of saved) {
      try {
        await fs.promises.access(p, fs.constants.R_OK);
        existing.push(vscode.Uri.file(p));
      } catch { /* drop missing */ }
    }
    if (existing.length) await this.addFiles(existing);

    const watched = this.context.workspaceState.get<string[]>(STATE_WATCHED, []);
    for (const root of watched) {
      try {
        const s = await fs.promises.stat(root);
        if (s.isDirectory()) await this.watchFolder(root);
      } catch { /* drop missing */ }
    }
  }

  private updateStatus() {
    const n = this.followed.size;
    const w = this.watched.size;
    if (n === 0 && w === 0) {
      this.status.hide();
      return;
    }
    const parts: string[] = [];
    if (n > 0) parts.push(`$(eye) Logs: ${n}`);
    if (w > 0) parts.push(`$(folder-active) ${w}`);
    this.status.text = parts.join(" ");
    this.status.tooltip = `Log Aggregator — ${n} file(s) followed, ${w} folder(s) auto-watched. Click to manage.`;
    this.status.show();
  }

  dispose() { this.stopAll(); this.status.dispose(); }
}

function safeRegex(src: string): RegExp | undefined {
  try { return new RegExp(src); } catch { return undefined; }
}

async function pickWorkspaceLogFiles(): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles(
    "**/*.{log,out,err,txt}",
    "**/node_modules/**",
    500
  );
  if (found.length === 0) return [];
  const items = found.map((u) => ({
    label: path.basename(u.fsPath),
    description: vscode.workspace.asRelativePath(u),
    uri: u,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Select log files to follow",
    placeHolder: "Choose one or more log files in the workspace",
  });
  return picked ? picked.map((p) => p.uri) : [];
}

async function pickAnyFiles(): Promise<vscode.Uri[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "Follow",
    title: "Select log files to follow",
  });
  return uris ?? [];
}

async function chooseSourceAndAdd(agg: Aggregator) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(search) Pick from workspace", id: "ws" },
      { label: "$(folder-opened) Browse filesystem...", id: "fs" },
      { label: "$(edit) Enter path manually...", id: "manual" },
    ],
    { title: "Add log files", placeHolder: "Where are the logs?" }
  );
  if (!choice) return;
  let uris: vscode.Uri[] = [];
  if (choice.id === "ws") uris = await pickWorkspaceLogFiles();
  else if (choice.id === "fs") uris = await pickAnyFiles();
  else if (choice.id === "manual") {
    const input = await vscode.window.showInputBox({
      prompt: "Absolute path to log file (or comma/newline-separated list)",
      ignoreFocusOut: true,
    });
    if (input) {
      uris = input
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => vscode.Uri.file(p));
    }
  }
  if (uris.length) await agg.addFiles(uris);
  else vscode.window.showInformationMessage("No files selected.");
}

export function activate(context: vscode.ExtensionContext) {
  const agg = new Aggregator(context);
  context.subscriptions.push({ dispose: () => agg.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("logAggregator.start", () => chooseSourceAndAdd(agg)),
    vscode.commands.registerCommand("logAggregator.addFiles", () => chooseSourceAndAdd(agg)),

    // Explorer right-click handlers.
    // VS Code passes (clickedUri, allSelectedUris) when invoked from explorer/context.
    vscode.commands.registerCommand(
      "logAggregator.followSelected",
      (clicked?: vscode.Uri, selected?: vscode.Uri[]) =>
        followFromExplorer(agg, clicked, selected, "keep")
    ),
    vscode.commands.registerCommand(
      "logAggregator.followSelectedInTerminal",
      (clicked?: vscode.Uri, selected?: vscode.Uri[]) =>
        followFromExplorer(agg, clicked, selected, "terminal")
    ),

    // Folder auto-watch commands.
    vscode.commands.registerCommand(
      "logAggregator.watchFolder",
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const folders = await resolveFolderUris(clicked, selected);
        if (folders.length === 0) {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: "Watch",
            title: "Select folder(s) to auto-watch for log files",
          });
          if (!picked) return;
          for (const u of picked) await agg.watchFolder(u.fsPath);
        } else {
          for (const u of folders) await agg.watchFolder(u.fsPath);
        }
      }
    ),
    vscode.commands.registerCommand("logAggregator.unwatchFolder", async () => {
      const items = agg.listWatched();
      if (items.length === 0) {
        vscode.window.showInformationMessage("No folders are being watched.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        items.map((p) => ({ label: path.basename(p), description: p, path: p })),
        { title: "Stop watching which folder?", canPickMany: true }
      );
      if (Array.isArray(pick)) for (const p of pick) agg.unwatchFolder(p.path);
    }),
    vscode.commands.registerCommand("logAggregator.configureWatchExtensions", async () => {
      const cfg = vscode.workspace.getConfiguration("logAggregator");
      const current = cfg.get<string[]>("watchExtensions", [".log", ".txt"]).join(", ");
      const input = await vscode.window.showInputBox({
        prompt: "File extensions to auto-watch (comma-separated, e.g. .log, .txt, .out)",
        value: current,
        ignoreFocusOut: true,
      });
      if (input === undefined) return;
      const list = input.split(",").map((s) => s.trim()).filter(Boolean)
        .map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase());
      await cfg.update("watchExtensions", list, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Log Aggregator now watches: ${list.join(", ")}`);
    }),
    vscode.commands.registerCommand("logAggregator.stop", () => agg.stopAll()),
    vscode.commands.registerCommand("logAggregator.toggleSink", () => agg.toggleSink()),
    vscode.commands.registerCommand("logAggregator.clear", () => agg.clearOutput()),
    vscode.commands.registerCommand("logAggregator.removeFile", async () => {
      const items = agg.list();
      if (!items.length) {
        vscode.window.showInformationMessage("No files are being followed.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        items.map((i) => ({ label: i.label, description: i.path, path: i.path })),
        { title: "Stop following which file?" }
      );
      if (pick) agg.removeFile(pick.path);
    }),
    vscode.commands.registerCommand("logAggregator.manage", async () => {
      const items = agg.list();
      const watched = agg.listWatched();
      const actions: vscode.QuickPickItem[] = [
        { label: "$(add) Add files...", description: "Pick more logs to follow" },
        { label: "$(folder-active) Watch folder...", description: "Auto-detect new log files in a folder tree" },
        { label: "$(folder) Stop watching folder...", description: `${watched.length} watched` },
        { label: "$(settings-gear) Configure watch extensions", description: "e.g. .log, .txt, .out" },
        { label: "$(circle-slash) Stop all", description: `${items.length} followed, ${watched.length} watched` },
        { label: "$(arrow-swap) Toggle sink (output/terminal)" },
        { label: "$(filter) Set include/exclude regex" },
        { label: "$(clear-all) Clear output" },
        { kind: vscode.QuickPickItemKind.Separator, label: "Followed files" },
        ...items.map((i) => ({ label: `$(close) ${i.label}`, description: i.path })),
        ...(watched.length
          ? [
              { kind: vscode.QuickPickItemKind.Separator, label: "Watched folders" } as vscode.QuickPickItem,
              ...watched.map((p) => ({ label: `$(folder-active) ${path.basename(p)}`, description: p })),
            ]
          : []),
      ];
      const pick = await vscode.window.showQuickPick(actions, { title: "Log Aggregator" });
      if (!pick) return;
      if (pick.label.startsWith("$(add)")) return chooseSourceAndAdd(agg);
      if (pick.label.startsWith("$(folder-active) Watch")) return vscode.commands.executeCommand("logAggregator.watchFolder");
      if (pick.label.startsWith("$(folder) Stop")) return vscode.commands.executeCommand("logAggregator.unwatchFolder");
      if (pick.label.startsWith("$(settings-gear)")) return vscode.commands.executeCommand("logAggregator.configureWatchExtensions");
      if (pick.label.startsWith("$(circle-slash)")) return agg.stopAll();
      if (pick.label.startsWith("$(arrow-swap)")) return agg.toggleSink();
      if (pick.label.startsWith("$(filter)")) return vscode.commands.executeCommand("logAggregator.setFilter");
      if (pick.label.startsWith("$(clear-all)")) return agg.clearOutput();
      if (pick.label.startsWith("$(close)") && pick.description) agg.removeFile(pick.description);
      if (pick.label.startsWith("$(folder-active) ") && pick.description) {
        // Item from the "Watched folders" section — offer to unwatch.
        const yes = await vscode.window.showWarningMessage(
          `Stop watching ${pick.description}?`,
          { modal: true },
          "Stop watching"
        );
        if (yes === "Stop watching") agg.unwatchFolder(pick.description);
      }
    }),
    vscode.commands.registerCommand("logAggregator.setFilter", async () => {
      const cfg = vscode.workspace.getConfiguration("logAggregator");
      const inc = await vscode.window.showInputBox({
        prompt: "Include regex (only show matching lines, blank to disable)",
        value: cfg.get<string>("includeRegex", ""),
        ignoreFocusOut: true,
      });
      if (inc === undefined) return;
      const exc = await vscode.window.showInputBox({
        prompt: "Exclude regex (hide matching lines, blank to disable)",
        value: cfg.get<string>("excludeRegex", ""),
        ignoreFocusOut: true,
      });
      if (exc === undefined) return;
      await cfg.update("includeRegex", inc, vscode.ConfigurationTarget.Workspace);
      await cfg.update("excludeRegex", exc, vscode.ConfigurationTarget.Workspace);
    })
  );

  // Restore previously followed files for this workspace.
  void agg.restore();
}

/** Filter a (clicked, selected) pair from the Explorer down to folder URIs. */
async function resolveFolderUris(
  clicked: vscode.Uri | undefined,
  selected: vscode.Uri[] | undefined
): Promise<vscode.Uri[]> {
  const candidates: vscode.Uri[] = [];
  if (Array.isArray(selected) && selected.length > 0) candidates.push(...selected);
  else if (clicked) candidates.push(clicked);
  const out: vscode.Uri[] = [];
  for (const u of candidates) {
    if (u.scheme !== "file") continue;
    try {
      const s = await vscode.workspace.fs.stat(u);
      if (s.type === vscode.FileType.Directory) out.push(u);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Handle invocation from the Explorer right-click menu.
 * VS Code passes the clicked Uri as the first arg and the full selection as the second.
 * If the user multi-selected files and right-clicked one of them, `selected` contains all of them.
 */
async function followFromExplorer(
  agg: Aggregator,
  clicked: vscode.Uri | undefined,
  selected: vscode.Uri[] | undefined,
  sinkPref: "keep" | "terminal" | "output"
) {
  let uris: vscode.Uri[] = [];
  if (Array.isArray(selected) && selected.length > 0) {
    uris = selected;
  } else if (clicked) {
    uris = [clicked];
  }
  // Filter to files only (skip folders, schemes we can't read).
  const fileUris: vscode.Uri[] = [];
  for (const u of uris) {
    if (u.scheme !== "file") continue;
    try {
      const stat = await vscode.workspace.fs.stat(u);
      if (stat.type === vscode.FileType.File) fileUris.push(u);
    } catch { /* skip unreadable */ }
  }
  if (fileUris.length === 0) {
    vscode.window.showWarningMessage("Log Aggregator: no readable files in the selection.");
    return;
  }
  if (sinkPref === "terminal") {
    await vscode.workspace
      .getConfiguration("logAggregator")
      .update("sink", "terminal", vscode.ConfigurationTarget.Workspace);
  } else if (sinkPref === "output") {
    await vscode.workspace
      .getConfiguration("logAggregator")
      .update("sink", "output", vscode.ConfigurationTarget.Workspace);
  }
  await agg.addFiles(fileUris);
  vscode.window.setStatusBarMessage(
    `Log Aggregator: following ${fileUris.length} file${fileUris.length === 1 ? "" : "s"}`,
    3000
  );
}

export function deactivate() { /* subscriptions handle cleanup */ }
