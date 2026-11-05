import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log } from "../util/logger";
import type { MusicConfig } from "../config";

export class LyricsOverlayService {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private lastLine = "";
  private closed = false;

  start(binary: string, config: MusicConfig["lyricsOverlay"]): void {
    if (process.platform !== "win32" || this.child) return;
    try {
      const child = spawn(binary, ["--lyrics"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      child.stdout.on("data", (data: Buffer) => this.onData(data));
      child.stderr.on("data", (data: Buffer) => {
        const line = data.toString("utf8").trim();
        if (line) log.warn("lyrics overlay stderr", line.slice(0, 300));
      });
      child.on("error", (err) => log.warn("lyrics overlay spawn failed", err.message));
      child.on("exit", () => {
        this.child = undefined;
        this.buffer = "";
      });
      this.applyStyle(config);
    } catch (err) {
      log.warn("lyrics overlay start failed", String(err));
    }
  }

  updateStatus(playing: boolean): void {
    if (!this.child || this.closed) return;
    this.write(`P\t${playing ? "play" : "pause"}`);
  }

  update(lines: { current: string; translation: string; next: string }): void {
    if (!this.child || this.closed) return;
    const second = lines.translation || lines.next;
    const payload = `${clean(lines.current)}\t${clean(second)}`;
    if (payload === this.lastLine) return;
    this.lastLine = payload;
    this.write(`L\t${payload}`);
  }

  applyStyle(config: MusicConfig["lyricsOverlay"]): void {
    if (!this.child || this.closed) return;
    const color = config.color.replace("#", "");
    this.write(
      `C\t${clean(config.font)}\t${Math.round(config.size)}\t${color}\t${Math.round(config.opacity)}\t` +
        `${Math.round(config.width)}\t${Math.round(config.height)}\t${config.locked ? 1 : 0}\t` +
        `${Math.round(config.x)}\t${Math.round(config.y)}\t0\t` +
        `${Math.round(config.weight)}\t${clean(config.fontFile)}\t\t0\t\t0` +
        `\t0\t${Math.round(config.borderWidth)}\t${clean(config.borderColor)}`,
    );
  }

  stop(): void {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.lastLine = "";
    if (!child) return;
    try {
      child.stdin.write("Q\n");
      child.stdin.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 500).unref?.();
  }

  get active(): boolean {
    return Boolean(this.child);
  }

  private write(line: string): void {
    try {
      this.child?.stdin.write(`${line}\n`);
    } catch {
      /* child may have exited */
    }
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.startsWith("POS\t")) {
        const [, x, y] = line.split("\t");
        this.onPosition?.(Number(x), Number(y));
      } else if (line.startsWith("CMD\t")) {
        this.onCommand?.(line.slice(4));
      } else if (line.startsWith("STYLE\t")) {
        const [, size, dual] = line.split("\t");
        this.onStyle?.(Number(size), dual === "1");
      } else if (line.startsWith("LOCK\t")) {
        this.onLock?.(line.endsWith("1"));
      }
      index = this.buffer.indexOf("\n");
    }
  }

  onPosition?: (x: number, y: number) => void;
  onCommand?: (command: string) => void;
  onStyle?: (size: number, dual: boolean) => void;
  onLock?: (locked: boolean) => void;
}

function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}
