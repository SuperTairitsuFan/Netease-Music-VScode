import * as vscode from "vscode";

type Level = "off" | "error" | "warn" | "info" | "debug";
const ORDER: Record<Level, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

let channel: vscode.OutputChannel | undefined;
let terminal: vscode.Terminal | undefined;
let logPty: LogPty | undefined;

class LogPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private opened = false;
  private readonly buffer: string[] = [];
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  open(): void {
    this.opened = true;
    this.writeEmitter.fire("\x1b[36m网易云音乐 · 运行日志\x1b[0m\r\n");
    this.writeEmitter.fire("\x1b[90m此终端记录播放、音频宿主、EAPI 与界面操作。听歌时可隐藏。\x1b[0m\r\n\r\n");
    for (const line of this.buffer) this.writeEmitter.fire(line);
    this.buffer.length = 0;
  }

  close(): void {
    this.opened = false;
    this.closeEmitter.fire(0);
  }

  write(line: string): void {
    const text = line.replace(/\r?\n/g, "\r\n") + "\r\n";
    if (this.opened) this.writeEmitter.fire(text);
    else {
      this.buffer.push(text);
      if (this.buffer.length > 2000) this.buffer.shift();
    }
  }
}

/** Create the hidden "网易云音乐日志" terminal; it is shown only on demand. */
export function initLogger(ctx: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("网易云音乐");
    ctx.subscriptions.push(channel);
  }
  if (!terminal) {
    logPty = new LogPty();
    terminal = vscode.window.createTerminal({
      name: "网易云音乐日志",
      pty: logPty,
      iconPath: new vscode.ThemeIcon("music"),
    });
    ctx.subscriptions.push(terminal);
  }
  return channel;
}

/** Show logs in the integrated terminal panel (the terminal tab stays hidden otherwise). */
export function showLog(): void {
  if (terminal) terminal.show(true);
  else channel?.show(true);
}

function enabled(level: Exclude<Level, "off">): boolean {
  const configured = (vscode.workspace.getConfiguration("neteaseMusic").get<string>("logLevel") ?? "info") as Level;
  return ORDER[configured] >= ORDER[level];
}

function emit(level: string, message: string, extra?: unknown): void {
  const now = new Date();
  const stamp = now.toISOString().slice(11, 23);
  let line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra !== undefined) {
    try {
      line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
    } catch {
      line += " [unserializable]";
    }
  }
  channel?.appendLine(line);
  const color = level === "ERROR" ? "\x1b[31m" : level === "WARN" ? "\x1b[33m" : level === "DEBUG" ? "\x1b[90m" : "\x1b[36m";
  logPty?.write(`${color}${line}\x1b[0m`);
}

export const log = {
  debug(message: string, extra?: unknown): void {
    if (enabled("debug")) emit("debug", message, extra);
  },
  info(message: string, extra?: unknown): void {
    if (enabled("info")) emit("info", message, extra);
  },
  warn(message: string, extra?: unknown): void {
    if (enabled("warn")) emit("warn", message, extra);
  },
  error(message: string, extra?: unknown): void {
    if (enabled("error")) emit("error", message, extra);
  },
};
