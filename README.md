# Log Aggregator

A Visual Studio Code extension that lets you select multiple log files and aggregate them — live-tailed — into a single VS Code **Output channel** or a **Terminal** you can follow, search, and copy from.

Think `tail -F file1 file2 file3` with per-file colored prefixes, regex filters, and rotation handling, all inside VS Code.

## Features

- **Pick logs five ways**
  - **Right-click in the Explorer** — multi-select files (Ctrl/Shift+click), right-click, choose **Follow with Log Aggregator**
  - **Auto-watch a folder** — right-click any folder → **Auto-Watch Folder for Logs**. Any file matching your configured extensions (`.log`, `.txt` by default) anywhere in the tree, now or in the future, is automatically followed.
  - From the current workspace (auto-discovers `*.log`, `*.out`, `*.err`, `*.txt`)
  - From a native file-open dialog (anywhere on disk)
  - By typing absolute paths (comma/newline separated)
- **Two sinks**
  - **Output channel** — clean, monospace, integrates with VS Code's Output panel
  - **Terminal** — real terminal pane with ANSI colors; press `p` to pause/resume, `c` to clear
- **Live tailing** with `fs.watch` + polling fallback (works on networked / WSL / Docker filesystems)
- **Rotation & truncation aware** — detects shrinking file size and resyncs from offset 0
- **Per-file colored prefix** so interleaved streams stay readable
- **Regex include / exclude filters** applied live
- **Optional timestamps** on each line
- **Status bar item** showing how many files are being followed; click to manage
- **Workspace persistence** — remembers your followed set per workspace
- **Keybinding** — `Ctrl+Alt+L` (`Cmd+Alt+L` on macOS) to start

## Install

```bash
code --install-extension log-aggregator-0.3.0.vsix
```

## Auto-Watch a Folder

Watch mode automatically follows every matching log file under a folder tree — including files that don't exist yet.

**To start:**
- Right-click a folder in the Explorer → **Auto-Watch Folder for Logs**, **or**
- `Ctrl+Shift+P` → **Auto-Watch Folder for Logs** → pick a folder

**What happens:**
1. The folder tree is scanned recursively; every existing `*.log` / `*.txt` (or whatever you configured) is added to the aggregator.
2. The folder is watched live. The moment a new matching file is created — in the root or any subfolder — it's added automatically.
3. New extensions can be configured via **Log Aggregator: Configure Watched Extensions** or the `logAggregator.watchExtensions` setting.

**Defaults:**
- Extensions: `.log`, `.txt`
- Excluded folders: `node_modules`, `.git`, `.hg`, `.svn`, `dist`, `out`, `.next`, `.cache` (configurable via `logAggregator.watchExcludeDirs`)

**Stop watching:** **Log Aggregator: Stop Watching a Folder**, or open the manage menu (status bar) and select the folder.

Watched folders persist per workspace and are restored when you reopen VS Code.

## Right-click in the Explorer

1. In the **Explorer** sidebar, click a file, then **Ctrl/Cmd+click** or **Shift+click** to add more files to the selection.
2. Right-click any of the selected files.
3. Choose **Follow with Log Aggregator** (uses your current sink) or **Follow with Log Aggregator (Terminal)** (forces terminal sink).
4. The aggregated stream appears in the Output channel or Terminal immediately.

Folders are filtered out automatically — only readable files are followed.

## Commands

All available from the Command Palette (`Ctrl+Shift+P`):

| Command | What it does |
|---|---|
| `Log Aggregator: Start Following Logs` | Choose source (workspace / browse / manual) and start |
| `Log Aggregator: Add Log Files` | Add more files to the current session |
| `Log Aggregator: Remove a Followed File` | Stop following one file |
| `Log Aggregator: Stop Following All` | Stop everything and dispose the sink |
| `Log Aggregator: Toggle Output Channel / Terminal` | Switch sinks live |
| `Log Aggregator: Set Include/Exclude Regex Filter` | Update filters |
| `Log Aggregator: Clear Output` | Clear the current sink |
| `Log Aggregator: Manage Followed Files` | Quick-pick menu for everything |
| `Auto-Watch Folder for Logs` | Recursively watch a folder for new log files |
| `Log Aggregator: Stop Watching a Folder` | Pick watched folders to stop |
| `Log Aggregator: Configure Watched Extensions` | Edit the extension list (`.log, .txt, .out`, ...) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `logAggregator.sink` | `output` | `output` or `terminal` |
| `logAggregator.showFilePrefix` | `true` | Prefix lines with the file's basename |
| `logAggregator.showTimestamp` | `false` | Prefix lines with local time |
| `logAggregator.fromBeginning` | `false` | Read existing content instead of just new lines |
| `logAggregator.includeRegex` | `""` | Only show lines matching this regex |
| `logAggregator.excludeRegex` | `""` | Hide lines matching this regex |
| `logAggregator.pollIntervalMs` | `500` | Polling fallback interval |
| `logAggregator.watchExtensions` | `[".log", ".txt"]` | File extensions auto-attached in watched folders |
| `logAggregator.watchExcludeDirs` | `["node_modules", ".git", ...]` | Directory basenames skipped during folder watch |

## Develop & build from source

```bash
npm install
npm run build          # bundles src/extension.ts -> dist/extension.js
npm run package        # produces .vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## How it works (architecture)

- `src/tail.ts` — `FileTail`, an EventEmitter that tracks `lastPos`, watches via `fs.watch`, polls as a fallback, reads only new bytes, splits into lines, handles truncation/rotation.
- `src/sink.ts` — `Sink` interface with two implementations:
  - `OutputChannelSink` wrapping `vscode.OutputChannel`
  - `TerminalSink` wrapping a `vscode.Pseudoterminal` so the user gets a real interactive terminal (search, scroll-back, copy, ANSI colors, pause/resume)
- `src/extension.ts` — `Aggregator` orchestrates a map of `FileTail`s, applies filters/prefixes, manages the active sink, persists state, and registers commands.

## License

MIT
