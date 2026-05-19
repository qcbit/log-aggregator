import * as vscode from "vscode";

export interface Sink {
  write(line: string): void;
  clear(): void;
  show(): void;
  dispose(): void;
  /** Fires when the underlying terminal/channel is closed by the USER (not our dispose()). */
  onClosed(listener: () => void): vscode.Disposable;
}

export class OutputChannelSink implements Sink {
  private channel: vscode.OutputChannel;
  // Output channels can't truly be "closed" by the user — they only get hidden.
  // We expose a no-op onClosed so callers don't need to special-case the type.
  private closedEmitter = new vscode.EventEmitter<void>();

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }
  write(line: string) { this.channel.appendLine(line); }
  clear() { this.channel.clear(); }
  show() { this.channel.show(true); }
  dispose() { this.channel.dispose(); this.closedEmitter.dispose(); }
  onClosed(listener: () => void) { return this.closedEmitter.event(listener); }
}

/**
 * Pseudoterminal-backed sink. Renders into a real VS Code Terminal
 * so users can scroll, search (Ctrl+F), and copy lines like any terminal.
 *
 * Detects when the user closes the terminal (X button, "Kill terminal", or by
 * closing the window) and fires `onClosed` so the Aggregator can recreate it
 * lazily the next time a log line needs to be written.
 */
export class TerminalSink implements Sink {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number>();
  private userClosedEmitter = new vscode.EventEmitter<void>();
  private terminal: vscode.Terminal;
  private paused = false;
  private bufferedWhilePaused: string[] = [];
  private disposedByUs = false;
  private terminalCloseListener: vscode.Disposable;

  constructor(name: string) {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {
        this.writeEmitter.fire(`\x1b[36m[Log Aggregator] Ready. Press 'p' to pause/resume, 'c' to clear.\x1b[0m\r\n`);
      },
      close: () => { /* no-op; we react via onDidCloseTerminal below */ },
      handleInput: (data: string) => {
        if (data === "p" || data === "P") {
          this.paused = !this.paused;
          this.writeEmitter.fire(
            this.paused
              ? "\r\n\x1b[33m[paused]\x1b[0m\r\n"
              : "\r\n\x1b[33m[resumed]\x1b[0m\r\n"
          );
          if (!this.paused && this.bufferedWhilePaused.length) {
            const flushed = this.bufferedWhilePaused.join("");
            this.bufferedWhilePaused = [];
            this.writeEmitter.fire(flushed);
          }
        } else if (data === "c" || data === "C") {
          this.clear();
        }
      },
    };
    this.terminal = vscode.window.createTerminal({ name, pty });

    // Detect user-initiated close (X button, kill, window close, etc.).
    this.terminalCloseListener = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal && !this.disposedByUs) {
        this.userClosedEmitter.fire();
      }
    });
  }

  write(line: string) {
    const out = line.replace(/\r?\n/g, "\r\n") + "\r\n";
    if (this.paused) {
      this.bufferedWhilePaused.push(out);
      if (this.bufferedWhilePaused.length > 5000) {
        this.bufferedWhilePaused.splice(0, this.bufferedWhilePaused.length - 5000);
      }
      return;
    }
    this.writeEmitter.fire(out);
  }

  clear() { this.writeEmitter.fire("\x1b[2J\x1b[H"); }
  show() { this.terminal.show(true); }

  dispose() {
    this.disposedByUs = true;
    try { this.closeEmitter.fire(0); } catch { /* noop */ }
    try { this.terminal.dispose(); } catch { /* noop */ }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.userClosedEmitter.dispose();
    this.terminalCloseListener.dispose();
  }

  onClosed(listener: () => void): vscode.Disposable {
    return this.userClosedEmitter.event(listener);
  }
}
