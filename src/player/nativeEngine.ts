import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import type { AudioFormat, ComponentRecord } from "./components";
import { log } from "../util/logger";

export const FRAME_CONTROL = 1;
export const FRAME_PCM = 2;
export const FRAME_END = 3;
export const FRAME_PCM_INT = 4;

export interface EngineDevice {
  id: string;
  name: string;
  backend: string;
  isDefault: boolean;
  formats: AudioFormat[];
}

export interface EngineProbe {
  ok: boolean;
  version?: string;
  protocol?: string;
  backends?: string[];
  devices?: EngineDevice[];
  error?: string;
}

export interface EngineConfigureOptions {
  device?: string;
  sampleRate: number;
  channels: number;
  bits: number;
  sampleFormat: string;
  exclusive: boolean;
  bufferMs: number;
  volume: number;
}

export interface EngineConfigured {
  device: EngineDevice;
  format: AudioFormat;
  bufferFrames: number;
  exclusive: boolean;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class NativeEngineSession extends EventEmitter {
  /** Filled in by `start()` once the device has been opened. */
  configured?: EngineConfigured;
  private readonly pending = new Map<string, Pending[]>();
  private buffer = "";
  private closed = false;
  private ready = false;
  private readonly progressHandler = (data: Buffer) => this.onStdout(data);
  private readonly exitHandler = () => this.handleExit();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly binary: string,
  ) {
    super();
    child.stdout.on("data", this.progressHandler);
    child.stderr.on("data", (data: Buffer) => {
      const line = data.toString("utf8").trim();
      if (!line) return;
      log.warn("native stderr", line);
      this.emit("log", line);
    });
    child.on("exit", this.exitHandler);
    child.on("error", (err) => {
      this.emit("error", err);
      this.rejectAll(new Error(`原生引擎进程错误：${err.message}`));
    });
  }

  static async start(binary: string, options: EngineConfigureOptions, backend?: "wasapi" | "asio"): Promise<NativeEngineSession> {
    const stat = await fs.stat(binary).catch(() => null);
    if (!stat?.isFile()) throw new Error(`原生引擎不存在：${binary}`);
    const args = backend ? ["--serve", "--backend", backend] : ["--serve"];
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const session = new NativeEngineSession(child, binary);
    try {
      await session.waitFor("ready", 3000);
      session.ready = true;
      const configured = await session.request("configured", 3000, {
        cmd: "configure",
        ...options,
      });
      await session.request("started", 3000, { cmd: "start" });
      session.configured = {
        device: configured.device,
        format: configured.format,
        bufferFrames: Number(configured.bufferFrames ?? 0),
        exclusive: Boolean(configured.exclusive),
      };
      return session;
    } catch (err) {
      await session.dispose();
      throw err;
    }
  }

  static async startFile(
    binary: string,
    filePath: string,
    backend: "wasapi" | "asio",
    startMs: number,
    growing = false,
    donePath = "",
    format: { exclusive: boolean; bits: number; device: string } = { exclusive: true, bits: 32, device: "default" },
  ): Promise<NativeEngineSession> {
    const stat = await fs.stat(binary).catch(() => null);
    if (!stat?.isFile()) throw new Error("原生引擎不存在：" + binary);
    const child = spawn(
      binary,
      [
        "--play-file",
        filePath,
        "--start-ms",
        String(Math.max(0, Math.floor(startMs))),
        "--backend",
        backend,
        "--exclusive",
        format.exclusive ? "1" : "0",
        "--bits",
        String(format.bits),
        "--device",
        format.device,
        ...(growing ? ["--growing", "--done", donePath] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
    const session = new NativeEngineSession(child, binary);
    try {
      const readyPromise = session.waitFor("ready", 15000);
      const configuredPromise = new Promise<any>((resolve) => session.once("configured", resolve));
      const startedPromise = new Promise<any>((resolve) => session.once("started", resolve));
      await readyPromise;
      const configured = await configuredPromise;
      await startedPromise;
      session.ready = true;
      session.configured = {
        device: configured.device,
        format: configured.format,
        bufferFrames: Number(configured.bufferFrames ?? 0),
        exclusive: Boolean(configured.exclusive),
      };
      return session;
    } catch (err) {
      await session.dispose();
      throw err;
    }
  }

  private onStdout(data: Buffer): void {
    this.buffer += data.toString("utf8");
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("log", line);
      return;
    }
    const event = String(message.event ?? "");
    if (event === "error") {
      const err = new EngineError(
        String(message.code ?? "ENGINE_ERROR"),
        String(message.message ?? "原生引擎错误"),
        message.supported,
      );
      const waiter = this.pending.get("error")?.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      this.emit("engineError", err);
      return;
    }
    if (event === "progress") {
      this.emit("progress", message);
    } else if (event === "underrun") {
      this.emit("underrun", message);
    } else if (event === "drained") {
      this.emit("drained", message);
    } else if (event === "deviceLost") {
      this.emit("deviceLost", message);
    }
    const waiters = this.pending.get(event);
    if (waiters?.length) {
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    this.emit(event, message);
  }

  private waitFor(event: string, timeoutMs: number): Promise<any> {
    return this.request(event, timeoutMs, null);
  }

  private request(event: string, timeoutMs: number, payload: Record<string, unknown> | null): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.pending.get(event) ?? [];
        this.pending.set(
          event,
          list.filter((p) => p.timer !== timer),
        );
        reject(new Error(`原生引擎事件超时：${event}`));
      }, timeoutMs);
      const list = this.pending.get(event) ?? [];
      list.push({ resolve, reject, timer });
      this.pending.set(event, list);
      if (payload) this.sendControl(payload);
    });
  }

  private sendControl(payload: Record<string, unknown>): void {
    if (this.closed) return;
    const json = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME_CONTROL, 0);
    header.writeUInt32LE(json.length, 1);
    this.child.stdin.write(header);
    this.child.stdin.write(json);
  }

  async writePcm(buffer: Buffer): Promise<void> {
    if (this.closed) throw new Error("原生引擎已关闭");
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME_PCM, 0);
    header.writeUInt32LE(buffer.length, 1);
    await this.writeWithBackpressure(header);
    await this.writeWithBackpressure(buffer);
  }

  async writePcmInt(buffer: Buffer, bits: number): Promise<void> {
    if (this.closed) throw new Error("原生引擎已关闭");
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME_PCM_INT, 0);
    header.writeUInt32LE(buffer.length, 1);
    await this.writeWithBackpressure(header);
    await this.writeWithBackpressure(buffer);
    void bits;
  }

  async drain(): Promise<void> {
    await this.request("drained", 30000, { cmd: "drain" });
  }

  private async writeWithBackpressure(buffer: Buffer): Promise<void> {
    if (this.closed) throw new Error("原生引擎已关闭");
    if (this.child.stdin.write(buffer)) return;
    // `write()` returning false means the stream wants a drain. Attach the
    // listener immediately and re-check the flag: a fast native process can
    // drain between write() and listener registration, which used to deadlock
    // and surface as "PCM 数据写入超时".
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.stdin.off("drain", onDrain);
        reject(new Error("原生引擎 stdin 背压超时"));
      }, 8000);
      const onDrain = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.child.stdin.once("drain", onDrain);
      if (!this.child.stdin.writableNeedDrain) {
        clearTimeout(timer);
        this.child.stdin.off("drain", onDrain);
        resolve();
      }
    });
  }

  async pause(): Promise<void> {
    this.sendControl({ cmd: "pause" });
  }

  async resume(): Promise<void> {
    this.sendControl({ cmd: "resume" });
  }

  async flush(): Promise<void> {
    this.sendControl({ cmd: "flush" });
  }

  setVolume(volume: number): void {
    this.sendControl({ cmd: "volume", value: Math.max(0, Math.min(1, volume)) });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    try {
      this.sendControl({ cmd: "stop" });
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_END, 0);
      header.writeUInt32LE(0, 1);
      this.child.stdin.write(header);
    } catch {
      /* ignore */
    }
  }

  private handleExit(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.rejectAll(new Error("原生引擎进程已退出"));
    this.emit("closed");
  }

  private rejectAll(err: Error): void {
    for (const list of this.pending.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    }
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    // Wait for the OS process to actually die so the audio driver (WASAPI
    // exclusive / ASIO) is released before the next session starts.
    if (this.child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 800)),
      ]);
    }
    this.removeAllListeners();
  }
}

export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly supported?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export async function probeEngine(binary: string, timeoutMs = 15000): Promise<EngineProbe> {
  try {
    const stat = await fs.stat(binary);
    if (!stat.isFile()) return { ok: false, error: "组件入口不是文件" };
  } catch {
    return { ok: false, error: `原生引擎不存在：${binary}` };
  }
  return new Promise<EngineProbe>((resolve) => {
    const child = spawn(binary, ["--probe"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "探测超时" });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1)) as EngineProbe;
          resolve({ ...parsed, ok: parsed.ok !== false });
          return;
        } catch {
          /* fall through */
        }
      }
      resolve({ ok: false, error: `探测失败（exit ${code}）${err.slice(0, 200)}` });
    });
  });
}

export function componentBinary(record: ComponentRecord | undefined): string | undefined {
  return record?.entryPath;
}
