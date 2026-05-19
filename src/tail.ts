import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

export interface TailOptions {
  fromBeginning?: boolean;
  pollIntervalMs?: number;
}

/**
 * Tails a single file. Emits 'line' for each newline-terminated chunk,
 * 'error' on read errors, and 'rotate' when the file is truncated/rotated.
 *
 * Strategy:
 *   - On start, seek to end (or 0 if fromBeginning).
 *   - Use fs.watch for change events; fall back to polling stat at pollIntervalMs.
 *   - On each change, stat the file:
 *       * if size < lastPos -> file was truncated/rotated, reset to 0
 *       * if size > lastPos -> read [lastPos, size) and split into lines
 *   - Buffer partial lines (no trailing newline) until more data arrives.
 */
export class FileTail extends EventEmitter {
  readonly filePath: string;
  private lastPos = 0;
  private buffer = "";
  private watcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private reading = false;
  private pending = false;
  private stopped = false;
  private readonly pollIntervalMs: number;

  constructor(filePath: string, opts: TailOptions = {}) {
    super();
    this.filePath = path.resolve(filePath);
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.init(opts.fromBeginning ?? false);
  }

  private init(fromBeginning: boolean) {
    fs.stat(this.filePath, (err, stat) => {
      if (this.stopped) return;
      if (err) {
        this.emit("error", err);
        // still try to watch in case the file appears later
        this.lastPos = 0;
      } else {
        this.lastPos = fromBeginning ? 0 : stat.size;
      }
      this.startWatching();
      // initial read if we want history
      if (fromBeginning) this.scheduleRead();
    });
  }

  private startWatching() {
    try {
      this.watcher = fs.watch(this.filePath, { persistent: false }, () => {
        this.scheduleRead();
      });
      this.watcher.on("error", (e) => this.emit("error", e));
    } catch (e) {
      // fs.watch can throw on some FS; we'll rely on polling
    }
    // Polling fallback (also catches missed events on networked FS)
    this.pollTimer = setInterval(() => this.scheduleRead(), this.pollIntervalMs);
  }

  private scheduleRead() {
    if (this.stopped) return;
    if (this.reading) {
      this.pending = true;
      return;
    }
    this.reading = true;
    this.readNew()
      .catch((e) => this.emit("error", e))
      .finally(() => {
        this.reading = false;
        if (this.pending && !this.stopped) {
          this.pending = false;
          this.scheduleRead();
        }
      });
  }

  private async readNew(): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.filePath);
    } catch (e: any) {
      // file may have been removed during rotation; wait for next event
      return;
    }
    if (stat.size < this.lastPos) {
      // truncated or rotated
      this.emit("rotate");
      this.lastPos = 0;
      this.buffer = "";
    }
    if (stat.size === this.lastPos) return;

    const fd = await fs.promises.open(this.filePath, "r");
    try {
      const length = stat.size - this.lastPos;
      const chunk = Buffer.alloc(Math.min(length, 1024 * 1024));
      let pos = this.lastPos;
      while (pos < stat.size) {
        const toRead = Math.min(chunk.length, stat.size - pos);
        const { bytesRead } = await fd.read(chunk, 0, toRead, pos);
        if (bytesRead <= 0) break;
        this.buffer += chunk.slice(0, bytesRead).toString("utf8");
        pos += bytesRead;
        this.flushLines(false);
      }
      this.lastPos = pos;
    } finally {
      await fd.close();
    }
  }

  private flushLines(final: boolean) {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(idx + 1);
      this.emit("line", line);
    }
    if (final && this.buffer.length > 0) {
      this.emit("line", this.buffer);
      this.buffer = "";
    }
  }

  stop() {
    this.stopped = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.flushLines(true);
  }
}
