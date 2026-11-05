import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log } from "../util/logger";
import type { PlayerState } from "../protocol";

export type SmtcAction = "play" | "pause" | "next" | "previous" | "stop";

/**
 * Windows System Media Transport Controls bridge.
 *
 * The native binary runs in `--smtc` mode with a hidden WinRT window. It only
 * owns the system media card; audio still comes from the normal player.
 */
export class SmtcService {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private lastMetadata = "";
  private lastStatus = "";
  private closed = false;
  private readonly onAction: (action: SmtcAction) => void;

  constructor(onAction: (action: SmtcAction) => void) {
    this.onAction = onAction;
  }

  start(binary: string): void {
    if (process.platform !== "win32" || this.child) return;
    try {
      const child = spawn(binary, ["--smtc"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      child.stdout.on("data", (data: Buffer) => this.onData(data));
      child.stderr.on("data", (data: Buffer) => {
        const line = data.toString("utf8").trim();
        if (line) log.warn("smtc stderr", line.slice(0, 300));
      });
      child.on("error", (err) => log.warn("smtc spawn failed", err.message));
      child.on("exit", () => {
        this.child = undefined;
        this.buffer = "";
      });
    } catch (err) {
      log.warn("smtc start failed", String(err));
    }
  }

  update(state: PlayerState): void {
    const child = this.child;
    if (!child || this.closed) return;
    const track = state.track;
    if (!track) return;
    const title = clean(track.name);
    const artist = clean(track.artists.map((item) => item.name).join(" / "));
    const metadata = `${title}\t${artist}`;
    if (metadata !== this.lastMetadata) {
      this.lastMetadata = metadata;
      this.write(`M\t${metadata}`);
    }
    const status = state.playing ? "play" : "pause";
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.write(`S\t${status}`);
    }
  }

  stop(): void {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
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
      if (line.startsWith("B\t")) {
        const action = line.slice(2) as SmtcAction;
        if (["play", "pause", "next", "previous", "stop"].includes(action)) this.onAction(action);
      }
      index = this.buffer.indexOf("\n");
    }
  }
}

function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}
