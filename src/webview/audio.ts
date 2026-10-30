import type { HostMessage, LoadRequest, WebviewMessage } from "../protocol";

type Send = (msg: WebviewMessage) => void;

const MEDIA_ERRORS: Record<number, string> = {
  1: "播放被中止",
  2: "网络错误，无法加载音频",
  3: "音频解码失败",
  4: "音频格式不支持或地址已过期",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class AudioEngine {
  private readonly audio = new Audio();
  private current?: LoadRequest;
  private chunkFrames = 8192;
  private seq = 0;
  private readonly ackWaiters = new Map<number, () => void>();
  private nativeAbort = false;
  private nativeWaiter?: {
    songId: number;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private lastTimeSent = 0;
  private rate = 1;

  constructor(private readonly send: Send) {
    this.audio.preload = "auto";
    this.audio.addEventListener("timeupdate", () => this.onTimeUpdate());
    this.audio.addEventListener("progress", () => this.onTimeUpdate());
    this.audio.addEventListener("play", () => this.onTimeUpdate());
    this.audio.addEventListener("ended", () => {
      if (this.current?.native) return;
      this.send({ type: "ended" });
    });
    this.audio.addEventListener("error", () => {
      const code = this.audio.error?.code ?? 0;
      this.send({ type: "loadError", message: MEDIA_ERRORS[code] ?? `音频播放失败（${code}）` });
    });
  }

  async load(request: LoadRequest): Promise<void> {
    this.stopInternal();
    this.current = request;
    this.seq = 0;
    if (request.native && request.localUri) {
      this.audio.pause();
      void this.loadNative(request);
      return;
    }
    this.playElement(request);
  }

  control(action: "play" | "pause" | "stop" | "seek" | "volume" | "rate", value?: number): void {
    switch (action) {
      case "pause":
        this.audio.pause();
        break;
      case "play":
        void this.audio.play().catch((err: Error) => {
          this.send({ type: "loadError", message: `无法恢复播放：${err.message}` });
        });
        break;
      case "stop":
        this.stopInternal();
        break;
      case "seek":
        if (!this.current?.native && typeof value === "number") {
          this.audio.currentTime = clamp(value, 0, this.audio.duration || value);
        }
        break;
      case "volume":
        if (typeof value === "number") this.audio.volume = clamp(value, 0, 1);
        break;
      case "rate":
        if (typeof value === "number") {
          this.rate = clamp(value, 0.5, 3);
          this.audio.playbackRate = this.rate;
        }
        break;
    }
  }

  onNativeReady(msg: Extract<HostMessage, { type: "nativeReady" }>): void {
    const waiter = this.nativeWaiter;
    if (!waiter || waiter.songId !== msg.songId) return;
    clearTimeout(waiter.timer);
    this.nativeWaiter = undefined;
    this.chunkFrames = Math.max(1024, Math.min(32768, msg.maxChunkFrames || 8192));
    waiter.resolve();
  }

  onHostFallback(songId: number, reason: string): void {
    const waiter = this.nativeWaiter;
    if (waiter && waiter.songId === songId) {
      clearTimeout(waiter.timer);
      this.nativeWaiter = undefined;
      waiter.reject(new Error(reason));
    }
  }

  onPlayerError(): void {
    const waiter = this.nativeWaiter;
    if (waiter) {
      clearTimeout(waiter.timer);
      this.nativeWaiter = undefined;
      waiter.reject(new Error("原生引擎错误"));
    }
  }

  onAck(seq: number): void {
    const resolve = this.ackWaiters.get(seq);
    if (resolve) {
      this.ackWaiters.delete(seq);
      resolve();
    }
  }

  get native(): boolean {
    return Boolean(this.current?.native);
  }

  // ------------------------------------------------------------- internals

  private playElement(request: LoadRequest): void {
    if (!request.url) {
      this.send({ type: "loadError", message: "缺少播放地址" });
      return;
    }
    this.audio.src = request.url;
    this.audio.volume = clamp(request.volume, 0, 1);
    this.audio.playbackRate = this.rate;
    const apply = () => {
      try {
        this.audio.currentTime = clamp(request.position, 0, Math.max(0, this.audio.duration || request.duration));
      } catch {
        /* metadata not ready yet */
      }
    };
    if (this.audio.readyState >= 1) apply();
    else this.audio.addEventListener("loadedmetadata", apply, { once: true });
    void this.audio.play().catch((err: Error) => {
      if (err.name === "NotAllowedError") {
        this.send({ type: "loadError", message: "浏览器阻止了自动播放，请点击播放按钮继续" });
      } else {
        this.send({ type: "loadError", message: `无法开始播放：${err.message}` });
      }
    });
  }

  private async loadNative(request: LoadRequest): Promise<void> {
    this.nativeAbort = false;
    try {
      const res = await fetch(request.localUri!);
      if (!res.ok) throw new Error(`读取本地缓存失败（HTTP ${res.status}）`);
      const buffer = await res.arrayBuffer();
      if (!buffer.byteLength) throw new Error("本地音频缓存为空");
      const rate = this.pickSampleRate(request.sourceSampleRate);
      let decoded: AudioBuffer;
      const ctx = new OfflineAudioContext(2, 1, rate);
      try {
        decoded = await ctx.decodeAudioData(buffer.slice(0));
      } catch (err) {
        throw new Error(`无法在 ${rate} Hz 下解码：${(err as Error).message}`);
      }
      if (decoded.sampleRate !== rate) {
        throw new Error(`解码采样率为 ${decoded.sampleRate} Hz，与请求的 ${rate} Hz 不一致`);
      }
      if (this.nativeAbort || this.current !== request) return;
      const start = clamp(Math.floor(request.position * decoded.sampleRate), 0, decoded.length);
      const end = request.trialEnd
        ? Math.min(decoded.length, Math.max(start, Math.floor(request.trialEnd * decoded.sampleRate)))
        : decoded.length;
      const totalFrames = end - start;
      if (totalFrames <= 0) throw new Error("音频总长度为零");
      this.send({
        type: "nativeBegin",
        songId: request.song.id,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        length: totalFrames,
      });
      await this.waitNativeReady(request.song.id, 15000);

      const channels = decoded.numberOfChannels;
      let seq = 0;
      for (let offset = start; offset < end; offset += this.chunkFrames) {
        if (this.nativeAbort || this.current !== request) return;
        const frames = Math.min(this.chunkFrames, end - offset);
        const interleaved = new Float32Array(frames * channels);
        for (let c = 0; c < channels; c += 1) {
          const source = decoded.getChannelData(c);
          for (let i = 0; i < frames; i += 1) {
            interleaved[i * channels + c] = source[offset + i] ?? 0;
          }
        }
        seq += 1;
        this.send({
          type: "pcm",
          seq,
          data: toBase64(new Uint8Array(interleaved.buffer)),
          frames,
        });
        await this.waitAck(seq, 20000);
      }
      this.send({ type: "pcmDone", songId: request.song.id, totalFrames });
    } catch (err) {
      if (this.nativeAbort || this.current !== request) return;
      const message = (err as Error).message;
      this.send({ type: "nativeFallbackLocal", reason: message });
      this.playElement({ ...request, native: false });
    }
  }

  private pickSampleRate(value?: number): number {
    if (!value || !Number.isFinite(value)) return 44100;
    const rate = Math.round(value);
    if (rate < 8000 || rate > 384000) return 44100;
    return rate;
  }

  private waitNativeReady(songId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.nativeWaiter = undefined;
        reject(new Error("原生引擎未在预期时间内就绪"));
      }, timeoutMs);
      this.nativeWaiter = { songId, resolve, reject, timer };
    });
  }

  private waitAck(seq: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(seq);
        reject(new Error("PCM 数据写入超时"));
      }, timeoutMs);
      this.ackWaiters.set(seq, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onTimeUpdate(): void {
    if (!this.current || this.current.native) return;
    const now = Date.now();
    if (now - this.lastTimeSent < 180) return;
    this.lastTimeSent = now;
    const position = this.audio.currentTime;
    const trialEnd = this.current.trialEnd ?? 0;
    if (trialEnd && position >= trialEnd) {
      this.audio.pause();
      this.send({ type: "time", position: trialEnd, duration: trialEnd, buffered: trialEnd });
      this.send({ type: "ended" });
      return;
    }
    this.send({
      type: "time",
      position,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : this.current.duration,
      buffered: this.bufferedEnd(),
    });
  }

  private bufferedEnd(): number {
    try {
      const ranges = this.audio.buffered;
      if (!ranges.length) return 0;
      return ranges.end(ranges.length - 1);
    } catch {
      return 0;
    }
  }

  private stopInternal(): void {
    this.nativeAbort = true;
    const waiter = this.nativeWaiter;
    if (waiter) {
      clearTimeout(waiter.timer);
      this.nativeWaiter = undefined;
      waiter.reject(new Error("cancelled"));
    }
    for (const resolve of this.ackWaiters.values()) resolve();
    this.ackWaiters.clear();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.current = undefined;
  }
}
