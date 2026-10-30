import * as vscode from "vscode";

type Level = "off" | "error" | "warn" | "info" | "debug";
const ORDER: Record<Level, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

let channel: vscode.OutputChannel | undefined;
let lastWrite = 0;

export function initLogger(ctx: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("网易云音乐");
    ctx.subscriptions.push(channel);
  }
  return channel;
}

export function showLog(): void {
  channel?.show(true);
}

function enabled(level: Exclude<Level, "off">): boolean {
  const configured = (vscode.workspace.getConfiguration("neteaseMusic").get<string>("logLevel") ?? "info") as Level;
  return ORDER[configured] >= ORDER[level];
}

function emit(level: string, message: string, extra?: unknown): void {
  if (!channel) return;
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
  channel.appendLine(line);
  // Avoid unbounded growth when debug logging floods during playback.
  if (now.getTime() - lastWrite > 5000 && channel) lastWrite = now.getTime();
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
