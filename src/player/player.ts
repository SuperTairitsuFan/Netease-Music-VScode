import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionManager } from "../auth/session";
import type { MusicConfig, PlayMode, Quality } from "../config";
import { QUALITY_LABELS } from "../config";
import type { LyricPayload, SongUrlResult, Track } from "../api/types";
import type { HostMessage, LoadRequest, NativeFormatView, OutputView, PlaybackSource, PlayerState, WebviewMessage } from "../protocol";
import { downloadToFile, downloadToGrowingFile } from "../download/fetcher";
import { log } from "../util/logger";
import type { AudioFormat, ComponentStore } from "./components";
import { EngineError, NativeEngineSession } from "./nativeEngine";

interface CachedUrl {
  value: SongUrlResult;
  expiresAt: number;
}

const QUEUE_KEY = "neteaseMusic.queue.v1";
const PLAYBACK_KEY = "neteaseMusic.playback.v1";
const RECENT_KEY = "neteaseMusic.recent.v1";
const LIKED_KEY = "neteaseMusic.liked.v1";
const RECENT_LIMIT = 100;

interface PersistedPlayback {
  volume?: number;
  mode?: PlayMode;
  ids?: number[];
  index?: number;
}

export class PlayerService implements vscode.Disposable {
  private queue: Track[] = [];
  private queueSources: Array<PlaybackSource | null> = [];
  private index = -1;
  private queueDirty = false;
  private playing = false;
  private loading = false;
  private mediaLoaded = false;
  private lastTimeAt = 0;
  private stallTimer?: NodeJS.Timeout;
  private stallRetried = false;
  private forceWebAudio = false;
  private position = 0;
  private duration = 0;
  private buffered = 0;
  private volume = 0.8;
  private rate = 1;
  private mode: PlayMode = "order";
  private error: string | null = null;
  private output: OutputView = { kind: "none", label: "未开始播放", detail: "等待播放" };
  private preparing = 0;
  private actualQuality = "";
  private currentSong: Track | null = null;
  private currentResolved: SongUrlResult | null = null;
  private trialEnd = 0;
  private playToken = 0;
  private readonly urlCache = new Map<string, CachedUrl>();
  private readonly lyricCache = new Map<number, LyricPayload>();
  private readonly likedIds = new Set<number>();
  private recentTracks: Track[] = [];
  private nativeSession?: NativeEngineSession;
  private nativeRate = 0;
  private nativeStartPosition = 0;
  private nativeReceivedFrames = 0;
  private nativeExpectedFrames = 0;
  private nativeSongId = 0;
  private nativeWriteChain: Promise<void> = Promise.resolve();
  private nativeBeginChain: Promise<void> = Promise.resolve();
  private nativeBeginToken = 0;
  private nativeRetry = 0;
  private streamNative = false;
  private preload?: { songId: number; quality: string; filePath: string; resolved: SongUrlResult };
  private preloadPromise?: Promise<void>;
  private preloadingSongId = 0;
  private growing?: { finalPath: string; partPath: string; donePath: string; promise: Promise<void> };
  private keepGrowing = false;
  private cachedWebAudio = false;
  private webAudioRetried = false;
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private finishedNative = false;

  private readonly emitter = new vscode.EventEmitter<PlayerState>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: SessionManager,
    private readonly components: ComponentStore,
    private readonly getConfig: () => MusicConfig,
  ) {
    void this.pruneCacheNow();
  }

  async pruneCacheNow(): Promise<void> {
    const cfg = this.getConfig();
    const dir = cfg.cache.enabled
      ? cfg.cache.dir || path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio")
      : path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio");
    await this.pruneCache(dir, Math.max(64, cfg.cache.maxSizeMB) * 1024 * 1024);
  }

  private postFn?: (msg: HostMessage) => void;
  private resourceUriFn?: (filePath: string) => string;

  attach(post: (msg: HostMessage) => void, resourceUri: (filePath: string) => string): void {
    this.postFn = post;
    this.resourceUriFn = resourceUri;
  }

  private post(msg: HostMessage): void {
    this.postFn?.(msg);
  }

  // ------------------------------------------------------------- state

  get current(): Track | null {
    return this.currentSong;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  getQueue(): Track[] {
    return this.queue;
  }

  getQueueSources(): Array<PlaybackSource | null> {
    return this.queueSources;
  }

  getRecent(): Track[] {
    return this.recentTracks;
  }

  isLiked(songId: number): boolean {
    return this.likedIds.has(songId);
  }

  lyricText(): string {
    return this.currentSong ? this.lyricCache.get(this.currentSong.id)?.lrc ?? "" : "";
  }

  sendCurrentLyric(): void {
    const song = this.currentSong;
    if (!song) return;
    const cached = this.lyricCache.get(song.id);
    if (cached) {
      this.post({ type: "lyric", songId: song.id, lrc: cached.lrc, translation: cached.translation });
    } else {
      void this.loadLyric(song);
    }
  }

  state(): PlayerState {
    const cfg = this.getConfig();
    return {
      track: this.currentSong,
      playing: this.playing,
      loading: this.loading,
      position: this.position,
      duration: this.duration || (this.currentSong ? this.currentSong.duration / 1000 : 0),
      buffered: this.buffered,
      rate: this.rate,
      volume: this.volume,
      mode: this.mode,
      quality: cfg.quality,
      actualQuality: this.actualQuality,
      liked: this.currentSong ? this.likedIds.has(this.currentSong.id) : false,
      likedIds: [...this.likedIds],
      error: this.error,
      output: this.output,
      queueLength: this.queue.length,
      index: this.index,
      queueSources: this.queueSources,
      preparing: this.preparing,
    };
  }

  emit(force = true): void {
    if (force) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer);
        this.emitTimer = undefined;
      }
      this.lastEmit = Date.now();
      this.emitter.fire(this.state());
      this.post({ type: "state", state: this.state() });
      return;
    }
    if (Date.now() - this.lastEmit < 200) {
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = undefined;
          this.emit(true);
        }, 200);
      }
      return;
    }
    this.emit(true);
  }

  // ------------------------------------------------------------ restore

  async restore(): Promise<void> {
    const cfg = this.getConfig();
    this.forceWebAudio = this.ctx.globalState.get<boolean>("neteaseMusic.forceWebAudio") ?? false;
    const saved = this.ctx.globalState.get<PersistedPlayback>(PLAYBACK_KEY);
    if (saved?.volume !== undefined) this.volume = Math.max(0, Math.min(1, saved.volume));
    else this.volume = Math.max(0, Math.min(1, cfg.playback.volume / 100));
    if (saved?.mode) this.mode = saved.mode;
    const recent = this.ctx.globalState.get<Track[]>(RECENT_KEY);
    if (Array.isArray(recent)) this.recentTracks = recent.slice(0, RECENT_LIMIT);
    const liked = this.ctx.globalState.get<number[]>(LIKED_KEY);
    if (Array.isArray(liked)) for (const id of liked) this.likedIds.add(Number(id));
    await this.refreshOutput();
    this.emit();

    const ids = saved?.ids ?? [];
    const index = saved?.index ?? -1;
    if (cfg.playback.rememberQueue && ids.length && index >= 0 && index < ids.length) {
      try {
        const tracks = await this.session.client.songDetail(ids);
        if (tracks.length) {
          this.queue = tracks;
          this.index = Math.min(index, tracks.length - 1);
          this.currentSong = this.queue[this.index] ?? null;
          this.duration = this.currentSong ? this.currentSong.duration / 1000 : 0;
          this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
          this.emit();
          if (cfg.playback.autoPlay && this.currentSong) void this.start(this.currentSong, 0);
        }
      } catch (err) {
        log.warn("failed to restore queue", String(err));
      }
    }
  }

  // ------------------------------------------------------------- output

  async refreshOutput(): Promise<void> {
    const cfg = this.getConfig();
    const record = await this.components.nativeRecord();
    const ready = record?.status === "ready";
    const wantNative = cfg.output.bitPerfect || cfg.output.mode === "native";
    if (this.nativeSession && !wantNative) {
      const song = this.currentSong;
      const resumeAt = this.position;
      const wasPlaying = this.playing;
      await this.stopNative();
      this.mediaLoaded = false;
      this.playing = false;
      if (song && wasPlaying) void this.start(song, resumeAt);
    }
    if (this.nativeSession) {
      this.emit();
      return;
    }
    const webAudioEnabled = await this.components.isEnabled("core.player");
    const bitPerfect = cfg.output.bitPerfect;
    const preferWebAudio = !bitPerfect && cfg.output.mode !== "native";
    if (bitPerfect) {
      this.output = ready
        ? {
            kind: "native",
            label: `Native Engine · ${record?.backend ?? "系统音频"}`,
            detail: "Bit-perfect · Exclusive · 源采样率/位深",
            backend: record?.backend,
          }
        : {
            kind: "none",
            label: "Bit-perfect 不可用",
            detail: "Bit-perfect 需要原生引擎；当前原生引擎未就绪",
            unavailableReason: record?.reason ?? "native engine not ready",
          };
    } else if (preferWebAudio) {
      this.output = webAudioEnabled
        ? {
            kind: "webaudio",
            label: "WebAudio（优先）",
            detail: "自动模式优先 WebAudio · 48 kHz 共享模式",
          }
        : ready
          ? {
              kind: "native",
              label: `Native Engine · ${record?.backend ?? "系统音频"}`,
              detail: cfg.output.exclusive ? "独占模式（就绪）" : "共享模式（就绪）",
              backend: record?.backend,
              unavailableReason: undefined,
            }
          : {
              kind: "none",
              label: "播放器组件已禁用",
              detail: "请启用「播放器（WebAudio 兜底）」或安装原生音频引擎",
              unavailableReason: "core.player 已禁用",
            };
    } else if (ready) {
      this.output = {
        kind: "native",
        label: `Native Engine · ${record?.backend ?? "系统音频"}`,
        detail: cfg.output.exclusive ? "独占模式（就绪）" : "共享模式（就绪）",
        backend: record?.backend,
        unavailableReason: undefined,
      };
    } else if (!webAudioEnabled) {
      this.output = {
        kind: "none",
        label: "播放器组件已禁用",
        detail: "启用「播放器（WebAudio 兜底）」组件，或安装原生音频引擎",
        unavailableReason: "core.player 已禁用",
      };
    } else {
      this.output = {
        kind: "webaudio",
        label: "WebAudio（兜底）",
        detail:
          cfg.output.mode === "native"
            ? "原生引擎未就绪，已回退 WebAudio"
            : "原生引擎未安装/未启用，使用 WebAudio",
        unavailableReason: record?.reason ?? "未安装 Native Audio Output Engine",
      };
    }
    this.emit();
  }

  private async shouldUseNative(): Promise<boolean> {
    const cfg = this.getConfig();
    const record = await this.components.nativeRecord();
    if (cfg.output.bitPerfect) return record?.status === "ready";
    if (cfg.output.mode !== "native") return false;
    if (this.forceWebAudio) return false;
    return record?.status === "ready";
  }

  private markNativeFailure(reason: string): void {
    if (this.forceWebAudio) return;
    this.forceWebAudio = true;
    log.warn("native output disabled for this profile after failure", reason);
    void this.ctx.globalState.update("neteaseMusic.forceWebAudio", true);
  }

  private nativeStrict(): boolean {
    const cfg = this.getConfig();
    return cfg.output.mode === "native" || cfg.output.bitPerfect;
  }

  // ------------------------------------------------------------ playback

  async setQueueAndPlay(tracks: Track[], startIndex: number, autoplay = true, source?: PlaybackSource | null): Promise<void> {
    if (!tracks.length) return;
    this.queue = tracks;
    this.queueSources = tracks.map(() => source ?? null);
    this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    const song = this.queue[this.index];
    if (song) {
      if (autoplay) await this.start(song, 0);
      else {
        this.currentSong = song;
        this.duration = song.duration / 1000;
        this.emit();
      }
    }
  }

  async playTrack(track: Track, list?: Track[], listIndex?: number, source?: PlaybackSource | null): Promise<void> {
    let targetIndex = this.queue.findIndex((t) => t.id === track.id);
    if (list && list.length) {
      const idx = listIndex ?? list.findIndex((t) => t.id === track.id);
      this.queue = list;
      this.queueSources = list.map(() => source ?? null);
      targetIndex = Math.max(0, idx);
    } else if (targetIndex < 0) {
      this.queue = [track];
      this.queueSources = [source ?? null];
      targetIndex = 0;
    } else if (source) {
      this.queueSources[targetIndex] = source;
    }
    this.index = targetIndex;
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    await this.start(track, 0);
  }

  async playAt(index: number): Promise<void> {
    if (index < 0 || index >= this.queue.length) return;
    this.index = index;
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    await this.start(this.queue[index], 0);
  }

  /** Play a local file through the WebAudio bridge (no EAPI URL resolution). */
  async playLocal(track: Track, uri: string): Promise<void> {
    await this.stopNative();
    this.currentSong = track;
    this.duration = 0;
    this.position = 0;
    this.buffered = 0;
    this.loading = false;
    this.playing = true;
    this.mediaLoaded = true;
    this.armStallWatch();
    this.error = null;
    this.actualQuality = "local";
    this.trialEnd = 0;
    this.recordRecent(track);
    this.queue = [track];
    this.index = 0;
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.post({
      type: "load",
      request: {
        song: track,
        url: uri,
        native: false,
        local: true,
        position: 0,
        volume: this.volume,
        duration: 0,
      },
    });
    this.emit();
  }

  /** Insert a track immediately after the current one ("下一首播放"). */
  playNext(track: Track, source?: PlaybackSource | null): void {
    const at = this.index >= 0 ? this.index + 1 : this.queue.length;
    const insertAt = Math.min(at, this.queue.length);
    this.queue.splice(insertAt, 0, track);
    this.queueSources.splice(insertAt, 0, source ?? null);
    if (this.index < 0) this.index = 0;
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    this.emit();
  }

  markLiked(songIds: number[]): void {
    let changed = false;
    for (const id of songIds) {
      if (!this.likedIds.has(id)) {
        this.likedIds.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistLiked();
      this.emit();
    }
  }

  async toggleLike(songId: number): Promise<boolean> {    if (!this.session.loggedIn) throw new Error("请先登录后再收藏");
    const next = !this.likedIds.has(songId);
    await this.session.client.like(songId, next);
    if (next) this.likedIds.add(songId);
    else this.likedIds.delete(songId);
    this.persistLiked();
    this.emit();
    return next;
  }

  async toggle(): Promise<void> {
    if (this.loading) return;
    if (!this.currentSong) {
      if (this.queue.length) await this.playAt(Math.max(0, this.index));
      return;
    }
    if (!this.mediaLoaded) {
      await this.start(this.currentSong, this.position || 0);
      return;
    }
    if (this.playing) {
      this.playing = false;
      this.post({ type: "control", action: "pause" });
      this.nativeSession?.pause().catch(() => undefined);
      this.emit();
      return;
    }
    if (this.nativeSession) {
      this.nativeSession.resume().catch(() => undefined);
      this.playing = true;
      this.emit();
      return;
    }
    if (this.position >= this.duration - 0.3) {
      await this.start(this.currentSong, 0);
      return;
    }
    this.playing = true;
    this.post({ type: "control", action: "play" });
    this.emit();
  }

  /** Pause without toggling back on (used when background playback is off). */
  async sleepStop(): Promise<void> {
    this.post({ type: "control", action: "pause" });
    if (this.nativeSession) await this.stopNative();
    this.playing = false;
    this.emit();
  }

  async pause(): Promise<void> {
    this.playing = false;
    this.post({ type: "control", action: "pause" });
    if (this.nativeSession) await this.nativeSession.pause().catch(() => undefined);
    this.emit();
  }

  async stop(): Promise<void> {
    this.post({ type: "control", action: "stop" });
    await this.stopNative();
    this.playing = false;
    this.loading = false;
    this.mediaLoaded = false;
    this.position = 0;
    this.buffered = 0;
    this.emit();
  }

  async seek(seconds: number): Promise<void> {
    if (!this.currentSong) return;
    const target = Math.max(0, Math.min(seconds, this.duration || seconds));
    this.position = target;
    if (this.nativeSession) {
      // Seeking inside a still-downloading stream needs the bytes at the target.
      // Wait for the download to finish (UI shows preparing %) instead of
      // starting a second download that would delete the growing file.
      if (this.growing) {
        this.loading = true;
        this.emit();
        const done = await fs.readFile(this.growing.donePath, "utf8").catch(() => "");
        if (done.trim() === "done") {
          this.finalizeGrowing();
        } else {
          this.keepGrowing = true;
        }
      }
      await this.startNativePlayback(this.currentSong, target);
      return;
    }
    this.post({ type: "control", action: "seek", value: target });
    this.emit();
  }

  private armStallWatch(): void {
    if (this.output.kind === "native" || this.nativeSession) return;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const token = this.playToken;
    this.stallTimer = setTimeout(() => {
      if (token !== this.playToken || !this.playing || !this.mediaLoaded || !this.currentSong) return;
      if (Date.now() - this.lastTimeAt < 5500) return;
      if (this.stallRetried) return;
      this.stallRetried = true;
      log.warn("playback stalled before first time update, retrying once", String(this.currentSong.id));
      void this.start(this.currentSong, this.position, true).catch((err) => log.warn("stalled playback retry failed", String(err)));
    }, 6500);
  }

  async setVolume(volume: number): Promise<void> {
    if (this.getConfig().output.bitPerfect) {
      this.volume = 1;
      this.post({ type: "control", action: "volume", value: 1 });
      this.emit();
      return;
    }
    this.volume = Math.max(0, Math.min(1, volume));
    this.post({ type: "control", action: "volume", value: this.volume });
    this.nativeSession?.setVolume(this.volume);
    this.emit();
    this.scheduleSave();
  }

  async setRate(rate: number): Promise<void> {
    this.rate = Math.max(0.5, Math.min(3, rate));
    this.post({ type: "control", action: "rate", value: this.rate });
    this.emit();
    this.scheduleSave();
  }

  async setMode(mode: PlayMode): Promise<void> {
    this.mode = mode;
    this.emit();
    this.scheduleSave();
  }

  async setQuality(quality: Quality): Promise<void> {
    await vscode.workspace.getConfiguration("neteaseMusic").update("quality", quality, vscode.ConfigurationTarget.Global);
    this.urlCache.clear();
    this.emit();
    if (this.currentSong && this.playing) await this.start(this.currentSong, this.position);
  }

  /** Re-resolve and restart the current track (used after output format changes). */
  async restartCurrent(): Promise<void> {
    if (!this.currentSong) return;
    await this.start(this.currentSong, this.position);
  }

  async likeCurrent(): Promise<boolean> {
    if (!this.currentSong) return false;
    return this.toggleLike(this.currentSong.id);
  }

  async next(userInitiated = false): Promise<void> {
    if (!this.queue.length) return;
    if (this.queue.length === 1 && !userInitiated) {
      await this.stop();
      return;
    }
    let nextIndex: number;
    if (this.mode === "shuffle") {
      if (this.queue.length === 1) nextIndex = 0;
      else {
        do {
          nextIndex = Math.floor(Math.random() * this.queue.length);
        } while (nextIndex === this.index);
      }
    } else if (this.mode === "repeatOne" && !userInitiated) {
      nextIndex = this.index;
    } else {
      nextIndex = (this.index + 1) % this.queue.length;
    }
    await this.playAt(nextIndex);
  }

  async previous(): Promise<void> {
    if (!this.queue.length) return;
    const prev = this.index <= 0 ? this.queue.length - 1 : this.index - 1;
    await this.playAt(prev);
  }

  addToQueue(track: Track, source?: PlaybackSource | null): void {
    this.queue.push(track);
    this.queueSources.push(source ?? null);
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    this.emit();
  }

  addManyToQueue(tracks: Track[], source?: PlaybackSource | null): void {
    this.queue.push(...tracks);
    for (let i = 0; i < tracks.length; i += 1) this.queueSources.push(source ?? null);
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    this.emit();
  }

  removeFromQueue(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    this.queueSources.splice(index, 1);
    if (index < this.index) this.index -= 1;
    else if (index === this.index) this.index = Math.min(this.index, this.queue.length - 1);
    this.post({ type: "queue", tracks: this.queue, index: this.index, sources: this.queueSources });
    this.persistQueue();
    this.emit();
  }

  clearQueue(): void {
    void this.stop();
    this.queue = [];
    this.queueSources = [];
    this.index = -1;
    this.currentSong = null;
    this.post({ type: "queue", tracks: [], index: -1 });
    this.persistQueue();
    this.emit();
  }

  // ------------------------------------------------------------- engine

  private async startNativePlayback(song: Track, position: number): Promise<void> {
    await this.start(song, position);
  }

  private async start(song: Track, position: number, keepStallRetry = false): Promise<void> {
    log.info("player start", { id: song.id, name: song.name, local: Boolean(song.localPath), output: this.output.kind, position });
    if (this.output.kind === "none") throw new Error(this.output.detail);
    const token = ++this.playToken;
    await this.stopNative();
    this.currentSong = song;
    this.duration = song.duration / 1000;
    this.position = position;
    this.loading = true;
    this.mediaLoaded = false;
    this.playing = false;
    this.lastTimeAt = Date.now();
    if (!keepStallRetry) this.stallRetried = false;
    this.error = null;
    this.cachedWebAudio = false;
    this.webAudioRetried = false;
    this.preparing = 0;
    this.actualQuality = "";
    this.trialEnd = 0;
    this.recordRecent(song);
    this.emit();

    if (song.localPath) {
      const localUri = this.resourceUriFn?.(song.localPath) ?? "";
      if (!localUri) throw new Error("无法读取本地音乐文件");
      this.currentResolved = null;
      this.actualQuality = "local";
      this.output = { kind: "webaudio", label: "本地文件", detail: "本地音乐 · WebAudio" };
      this.loading = false;
      this.playing = true;
      this.mediaLoaded = true;
    this.armStallWatch();
      this.post({
        type: "load",
        request: {
          song,
          url: localUri,
          native: false,
          local: true,
          position,
          volume: this.volume,
          duration: 0,
        },
      });
      this.emit();
      return;
    }

    void this.loadLyric(song);

    const timingStart = Date.now();
    try {
      const cachedAudio = await this.findCachedAudio(song);
      if (cachedAudio) {
        const useNativeCached = await this.shouldUseNative();
        this.currentResolved = null;
        this.actualQuality = `${QUALITY_LABELS[this.getConfig().quality] ?? this.getConfig().quality}（缓存）`;
        if (useNativeCached) {
          const record = await this.components.nativeRecord();
          if (!record?.entryPath) throw new Error("原生引擎组件不存在");
          const backendName = this.getConfig().output.backend === "asio" ? "asio" : "wasapi";
          this.loading = false;
          this.playing = true;
          this.mediaLoaded = true;
          await this.startStreamNative(record.entryPath, cachedAudio, backendName, position);
          log.info("startup timing", { resolve: 0, total: Date.now() - timingStart, cached: true });
          return;
        }
        // WebAudio 不使用本地缓存：部分 webview 的 <audio> 不支持本地
        // FLAC/高采样率容器，继续走 EAPI 远程流更可靠。
      }
      if (this.preloadingSongId === song.id && this.preloadPromise) await this.preloadPromise;
      const cachedPreload =
        this.preload && this.preload.songId === song.id && this.preload.quality === this.getConfig().quality
          ? this.preload
          : undefined;
      const resolved = cachedPreload?.resolved ?? (await this.resolveUrl(song));
      if (token !== this.playToken) return;
      if (!resolved.url) throw new Error(resolved.code === 404 ? "该歌曲无版权或已下架" : "无法获取播放地址");
      this.currentResolved = resolved;
      this.actualQuality = resolved.level ?? "";
      this.trialEnd = resolved.freeTrialInfo?.end ?? 0;
      if (resolved.sampleRate) this.duration = this.duration || song.duration / 1000;

      const resolvedAt = Date.now();
      const useNative = await this.shouldUseNative();
      if (token !== this.playToken) return;
      if (useNative) {
        try {
          const filePath = cachedPreload
            ? cachedPreload.filePath
            : await this.ensureStreamingFile(song, resolved, token);
          if (cachedPreload) this.preload = undefined;
          if (token !== this.playToken) return;
          const backendName = this.getConfig().output.backend === "asio" ? "asio" : "wasapi";
          if (this.getConfig().output.streaming) {
            try {
              const streamRecord = await this.components.nativeRecord();
              if (!streamRecord?.entryPath) throw new Error("原生引擎组件不存在");
              const growing = Boolean(this.growing && filePath.endsWith(".part"));
              const donePath = growing ? this.growing?.donePath ?? "" : "";
              await this.startStreamNative(streamRecord.entryPath, filePath, backendName, position, growing, donePath);
              log.info("startup timing", { resolve: resolvedAt - timingStart, total: Date.now() - timingStart, preloaded: Boolean(cachedPreload) });
              return;
            } catch (err) {
              log.warn("native streaming failed, using webview decode", (err as Error).message);
            }
          }
          const localUri = this.resourceUriFn?.(filePath) ?? "";
          const request: LoadRequest = {
            song,
            url: resolved.url,
            localUri,
            native: true,
            position,
            volume: this.volume,
            duration: this.duration,
            gain: resolved.gain,
            trialEnd: this.trialEnd,
            sourceSampleRate: resolved.sampleRate,
            sourceBits: this.getConfig().output.backend === "asio" ? 32 : this.sourceBits(resolved),
            integerPcm: this.getConfig().output.bitPerfect,
          };
          this.mediaLoaded = true;
    this.armStallWatch();
          this.post({ type: "load", request });
          this.loading = false;
          this.emit();
          return;
        } catch (err) {
          if (token !== this.playToken) return;
          if (this.nativeStrict()) {
            throw new Error(`原生输出准备失败：${(err as Error).message}`);
          }
          log.warn("native preparation failed, falling back to WebAudio", String(err));
          this.post({
            type: "toast",
            kind: "error",
            message: `原生引擎不可用，已回退 WebAudio：${(err as Error).message}`,
          });
        }
      }

      const request: LoadRequest = {
        song,
        url: resolved.url,
        native: false,
        position,
        volume: this.volume,
        duration: this.duration,
        gain: resolved.gain,
        trialEnd: this.trialEnd,
        sourceSampleRate: resolved.sampleRate,
        sourceBits: this.getConfig().output.backend === "asio" ? 32 : this.sourceBits(resolved),
        integerPcm: this.getConfig().output.bitPerfect,
      };
      this.mediaLoaded = true;
    this.armStallWatch();
          this.post({ type: "load", request });
      this.loading = false;
      this.output = {
        kind: "webaudio",
        label: "WebAudio（Chromium 共享模式）",
        detail: "48 kHz 重采样 · 非独占",
      };
      this.emit();
    } catch (err) {
      if (token !== this.playToken) return;
      this.loading = false;
      this.playing = false;
      this.error = (err as Error).message;
      this.emit();
      this.post({ type: "playerError", message: this.error });
    }
  }

  private sourceBits(resolved: SongUrlResult): number {
    if (!resolved.type || !/flac|wave|wav/i.test(resolved.type)) return 16;
    const rate = resolved.sampleRate ?? 44100;
    const inferred = resolved.br ? Math.round(resolved.br / (rate * 2)) : 0;
    if (inferred >= 20) return 24;
    if (/hires|jymaster/i.test(resolved.level ?? "")) return 24;
    return 16;
  }

  private async resolveUrl(song: Track, force = false): Promise<SongUrlResult> {
    const cfg = this.getConfig();
    const key = `${song.id}:${cfg.quality}`;
    if (force) this.urlCache.delete(key);
    const cached = this.urlCache.get(key);
    if (cached && cached.expiresAt > Date.now() && cached.value.url) return cached.value;
    const value = await this.session.client.songUrl(song.id, cfg.quality);
    const ttl = Math.max(30, (value.expi ?? 1200) - 10);
    this.urlCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return value;
  }

  private async findCachedAudio(song: Track): Promise<string | undefined> {
    const cfg = this.getConfig();
    const dir = cfg.cache.enabled
      ? cfg.cache.dir || path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio")
      : path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio");
    const prefix = `${song.id}-${cfg.quality}-`;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      if (name.endsWith(".part") || name.endsWith(".done")) continue;
      if (!/\.(flac|mp3)$/i.test(name)) continue;
      const full = path.join(dir, name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat?.isFile() && stat.size > 1024) return full;
    }
    return undefined;
  }

  private async pruneCache(dir: string, maxBytes: number, keep?: string): Promise<void> {
    try {
      const names = await fs.readdir(dir);
      const entries: Array<{ path: string; size: number; at: number }> = [];
      for (const name of names) {
        if (!/\.(flac|mp3)$/i.test(name)) continue;
        const full = path.join(dir, name);
        if (keep && path.resolve(full) === path.resolve(keep)) continue;
        const stat = await fs.stat(full).catch(() => null);
        if (stat?.isFile()) entries.push({ path: full, size: stat.size, at: stat.mtimeMs });
      }
      let total = entries.reduce((sum, item) => sum + item.size, 0);
      entries.sort((a, b) => a.at - b.at);
      for (const item of entries) {
        if (total <= maxBytes) break;
        await fs.rm(item.path, { force: true }).catch(() => undefined);
        total -= item.size;
      }
    } catch {
      /* cache directory missing */
    }
  }

  private async ensureAudioFile(
    song: Track,
    resolved: SongUrlResult,
    token: number,
    background = false,
  ): Promise<string> {
    if (!resolved.url) throw new Error("播放地址为空");
    const cfg = this.getConfig();
    const ext = resolved.type === "flac" ? "flac" : "mp3";
    const dir = cfg.cache.enabled
      ? cfg.cache.dir || path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio")
      : path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio");
    const file = path.join(dir, `${song.id}-${cfg.quality}-${resolved.br}.${ext}`);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile() && stat.size > 1024) return file;
    if (!background) {
      this.preparing = 1;
      this.emit();
    }
    let last = 0;
    await downloadToFile(resolved.url, file, {
      onProgress: (p) => {
        if (background || token !== this.playToken) return;
        const now = Date.now();
        if (now - last > 200) {
          last = now;
          this.preparing = p.total ? Math.min(99, Math.round((p.received / p.total) * 100)) : 1;
          this.emit(false);
        }
      },
    });
    this.preparing = 100;
    this.emit();
    const maxBytes = Math.max(64, this.getConfig().cache.maxSizeMB) * 1024 * 1024;
    void this.pruneCache(path.dirname(file), maxBytes, file);
    return file;
  }

  private async loadLyric(song: Track): Promise<void> {
    try {
      let payload = this.lyricCache.get(song.id);
      if (!payload) {
        payload = await this.session.client.lyric(song.id);
        this.lyricCache.set(song.id, payload);
      }
      if (this.currentSong?.id === song.id) {
        this.post({ type: "lyric", songId: song.id, lrc: payload.lrc, translation: payload.translation });
      }
    } catch (err) {
      log.debug("lyric unavailable", String(err));
      this.post({ type: "lyric", songId: song.id, lrc: "", translation: "" });
    }
  }

  // --------------------------------------------------------- native path

  private async startStreamNative(
    entryPath: string,
    filePath: string,
    backend: "wasapi" | "asio",
    position: number,
    growing = false,
    donePath = "",
  ): Promise<void> {
    const growingState = this.growing;
    this.growing = undefined;
    await this.stopNative();
    this.growing = growingState;
    const cfg = this.getConfig();
    const exclusive = backend === "asio" ? true : cfg.output.bitPerfect || cfg.output.exclusive;
    const bits = backend === "asio" ? 32 : exclusive ? 32 : 16;
    const device = backend === "asio" ? "default" : cfg.output.device || "default";
    const session = await NativeEngineSession.startFile(
      entryPath,
      filePath,
      backend,
      position * 1000,
      growing,
      donePath,
      { exclusive, bits, device },
    );
    this.streamNative = true;
    this.keepGrowing = false;
    this.nativeSession = session;
    const streamFormat = session.configured?.format;
    this.nativeRate = Number(streamFormat?.sampleRate ?? 0);
    if (streamFormat) {
      this.output = {
        kind: "native",
        label: `Native Engine · ${streamFormat.sampleRate} Hz / ${streamFormat.bits} bit`,
        detail: `${backend === "asio" ? "ASIO" : "WASAPI"} 流式解码 · ${streamFormat.sampleFormat}`,
        backend,
      };
    }
    this.nativeStartPosition = position;
    this.nativeSongId = this.currentSong?.id ?? 0;
    this.nativeExpectedFrames = 0;
    this.finishedNative = false;
    this.mediaLoaded = true;
    this.loading = false;
    this.preparing = 100;
    this.playing = true;
    this.position = position;
    this.nativeWriteChain = Promise.resolve();
    session.on("log", (line) => log.warn("native stderr", line));
    session.on("engineError", (err: Error) => log.warn("native engine error", err.message));
    session.on("progress", (p: any) => {
      if (this.nativeSession !== session) return;
      this.onNativeProgress(p);
    });
    session.on("drained", () => {
      if (this.nativeSession !== session) return;
      void this.finishNative();
    });
    session.on("closed", () => {
      if (this.nativeSession === session) this.nativeSession = undefined;
    });
    this.emit();
    void this.maybePreloadNext(true);
  }

  private cachePaths(song: Track, resolved: SongUrlResult): { finalPath: string; partPath: string; donePath: string } {
    const cfg = this.getConfig();
    const ext = resolved.type === "flac" ? "flac" : "mp3";
    const dir = cfg.cache.enabled
      ? cfg.cache.dir || path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio")
      : path.join(this.ctx.globalStorageUri.fsPath, "cache", "audio");
    const finalPath = path.join(dir, `${song.id}-${cfg.quality}-${resolved.br}.${ext}`);
    return { finalPath, partPath: finalPath + ".part", donePath: finalPath + ".done" };
  }

  private async ensureStreamingFile(song: Track, resolved: SongUrlResult, token: number): Promise<string> {
    const { finalPath, partPath, donePath } = this.cachePaths(song, resolved);
    const stat = await fs.stat(finalPath).catch(() => null);
    if (this.growing && this.growing.partPath === partPath) return partPath;
    if (stat?.isFile() && stat.size > 1024) return finalPath;
    if (resolved.type !== "flac") return this.ensureAudioFile(song, resolved, token);
    await fs.rm(donePath, { force: true }).catch(() => undefined);
    await fs.rm(partPath, { force: true }).catch(() => undefined);
    const promise = downloadToGrowingFile(resolved.url!, partPath, donePath, {
      onProgress: (p) => {
        if (token !== this.playToken) return;
        this.preparing = p.total ? Math.min(99, Math.round((p.received / p.total) * 100)) : 0;
        this.emit(false);
      },
    })
      .then(() => undefined)
      .catch((err) => log.warn("growing download failed", (err as Error).message));
    this.growing = { finalPath, partPath, donePath, promise };
    for (let i = 0; i < 150; i += 1) {
      const size = await fs.stat(partPath).then((s) => s.size).catch(() => 0);
      if (size > 256 * 1024) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const doneState = await fs.readFile(donePath, "utf8").catch(() => "");
    if (doneState.trim() === "error") throw new Error("缓存下载失败");
    return partPath;
  }

  private finalizeGrowing(): void {
    const g = this.growing;
    if (!g) return;
    this.growing = undefined;
    void (async () => {
      const done = await fs.readFile(g.donePath, "utf8").catch(() => "");
      if (done.trim() === "done") {
        await fs.rename(g.partPath, g.finalPath).catch(() => undefined);
        const maxBytes = Math.max(64, this.getConfig().cache.maxSizeMB) * 1024 * 1024;
        void this.pruneCache(path.dirname(g.finalPath), maxBytes, g.finalPath);
      }
      await fs.rm(g.donePath, { force: true }).catch(() => undefined);
    })();
  }

  private peekNextIndex(): number {
    if (!this.queue.length) return -1;
    if (this.mode === "shuffle" || this.mode === "repeatOne") return -1;
    let next = this.index + 1;
    if (next >= this.queue.length) {
      if (this.mode === "repeat") next = 0;
      else return -1;
    }
    return next;
  }

  private maybePreloadNext(force = false): void {
    if (!this.duration || this.loading) return;
    if (!force && this.duration - this.position > 20) return;
    if (this.preload || this.preloadPromise) return;
    const nextIndex = this.peekNextIndex();
    if (nextIndex < 0 || nextIndex === this.index) return;
    const song = this.queue[nextIndex];
    if (!song || song.localPath) return;
    const quality = this.getConfig().quality;
    this.preloadingSongId = song.id;
    this.preloadPromise = (async () => {
      const resolved = await this.resolveUrl(song);
      if (!resolved.url) return;
      const filePath = await this.ensureAudioFile(song, resolved, this.playToken, true);
      this.preload = { songId: song.id, quality, filePath, resolved };
      log.info("preloaded next", { id: song.id, file: filePath });
    })()
      .catch((err) => log.warn("preload failed", (err as Error).message))
      .finally(() => {
        this.preloadPromise = undefined;
        this.preloadingSongId = 0;
      });
  }

  private async handleNativeBegin(
    msg: Extract<WebviewMessage, { type: "nativeBegin" }>,
    token: number,
  ): Promise<void> {
    const cfg = this.getConfig();
    const record = await this.components.nativeRecord();
    if (!record?.entryPath) throw new Error("原生引擎组件不存在");
    const bitPerfect = cfg.output.bitPerfect;
    const requestedRate =
      bitPerfect || cfg.output.sampleRate === "auto" ? msg.sampleRate : Number(cfg.output.sampleRate);
    if (requestedRate !== msg.sampleRate) {
      const message =
        `输出采样率 ${requestedRate} Hz 与音源 ${msg.sampleRate} Hz 不一致；` +
        "引擎不做重采样，请把 output.sampleRate 设为 auto 或与音源一致的采样率";
      if (!this.nativeStrict()) {
        this.error = message;
        this.emit();
        this.post({ type: "nativeFallback", songId: msg.songId, reason: message });
        this.post({ type: "toast", kind: "error", message: `原生输出未启用：${message}` });
        return;
      }
      this.loading = false;
      this.playing = false;
      this.error = message;
      this.emit();
      this.post({ type: "playerError", message });
      return;
    }
    const rate = requestedRate;
    const exclusive = bitPerfect || cfg.output.exclusive || rate > 48000;
    // WASAPI shared mode often rejects 32-bit WAVEFORMATEXTENSIBLE even when
    // the device advertises it; 16-bit is universally accepted by the mixer.
    const bits = bitPerfect
      ? Math.max(16, Math.min(32, Number(msg.bits || 16)))
      : exclusive
        ? (cfg.output.bitDepth === "auto" ? 32 : Number(cfg.output.bitDepth))
        : 16;
    const sampleFormat = bitPerfect
      ? (bits === 16 ? "s16le" : bits === 24 ? "s24le" : "s32le")
      : exclusive
        ? (cfg.output.sampleFormat === "auto" ? "f32le" : cfg.output.sampleFormat)
        : "s16le";
    await this.stopNative();
    if (token !== this.nativeBeginToken) return;
    this.nativeSongId = msg.songId;
    this.nativeReceivedFrames = 0;
    this.nativeExpectedFrames = msg.length;
    this.nativeStartPosition = this.position;
    this.finishedNative = false;
    const backend = cfg.output.backend === "asio" ? "asio" : "wasapi";
    const device = backend === "asio" ? "default" : cfg.output.device || "default";
    log.info("native configure", { backend, device, rate, bits, sampleFormat, exclusive, bufferMs: Math.max(40, cfg.output.bufferMs), volume: this.volume });
    const options = {
      device,
      sampleRate: rate,
      channels: msg.channels,
      bits,
      sampleFormat,
      // WASAPI shared mode cannot open 96k/192k on many devices. High-rate
      // native playback must use exclusive mode; otherwise configure fails
      // before PCM starts.
      exclusive,
      bufferMs: Math.max(40, cfg.output.bufferMs),
      volume: bitPerfect ? 1 : this.volume,
    };
    try {
      let session: NativeEngineSession;
      try {
        session = await NativeEngineSession.start(record.entryPath, options, backend);
      } catch (err) {
        // If ASIO cannot start (driver busy / occupied), immediately retry
        // WASAPI so the user still gets sound without a browser gesture.
        if (backend !== "asio") throw err;
        log.warn("native asio failed, retrying wasapi", (err as Error).message);
        session = await NativeEngineSession.start(
          record.entryPath,
          { ...options, device: cfg.output.device || "default" },
          "wasapi",
        );
      }
      if (token !== this.nativeBeginToken) {
        await session.dispose();
        return;
      }
      this.nativeWriteChain = Promise.resolve();
      this.nativeRetry = 0;
      this.nativeSession = session;
      session.on("log", (line) => log.warn("native stderr", line));
      session.on("engineError", (err) => log.warn("native engine error", err.message));
      const event = session.configured;
      log.info("native device", { name: event?.device?.name ?? event?.device?.id ?? "default", backend: event?.device?.backend ?? "wasapi", bufferFrames: event?.bufferFrames });
      const format: AudioFormat =
        event?.format ?? ({ sampleRate: rate, channels: msg.channels, bits, sampleFormat } as AudioFormat);
      this.nativeRate = format.sampleRate;
      session.on("progress", (p: any) => this.onNativeProgress(p));
      session.on("drained", () => void this.finishNative());
      session.on("closed", () => {
        if (this.nativeSession === session) this.nativeSession = undefined;
      });
      session.on("engineError", (err: EngineError) => {
        this.error = err.message;
        this.emit();
        this.post({ type: "playerError", message: err.message });
      });
      this.output = {
        kind: "native",
        label: `Native Engine · ${format.sampleRate} Hz / ${format.bits} bit`,
        detail: `${cfg.output.exclusive ? "独占" : "共享"} · ${format.channels} 声道 · ${cfg.output.bufferMs} ms 缓冲`,
        backend: record.backend,
        format: {
          sampleRate: format.sampleRate,
          bits: format.bits,
          channels: format.channels,
          sampleFormat: format.sampleFormat,
        },
        deviceName: event?.device?.name,
      };
      this.playing = true;
      this.loading = false;
      this.emit();
      this.post({
        type: "nativeReady",
        songId: msg.songId,
        format: this.output.format as NativeFormatView,
        maxChunkFrames: Math.max(1024, Math.min(16384, Number(event?.bufferFrames ?? 4096) * 2)),
      });
    } catch (err) {
      const message = (err as Error).message;
      const supported = err instanceof EngineError ? err.supported : undefined;
      if (!this.nativeStrict()) {
        this.markNativeFailure(message);
        this.post({ type: "nativeFallback", songId: msg.songId, reason: message });
        this.post({ type: "toast", kind: "error", message: `原生引擎启动失败，已回退 WebAudio：${message}` });
        this.output = {
          kind: "webaudio",
          label: "WebAudio（兜底）",
          detail: `原生引擎启动失败：${message}`,
          unavailableReason: message,
        };
        this.emit();
        return;
      }
      this.error = supported
        ? `${message}；设备支持的格式：${JSON.stringify(supported)}`
        : message;
      this.loading = false;
      this.playing = false;
      this.emit();
      this.post({ type: "playerError", message: this.error });
    }
  }

  private onNativeProgress(progress: { frames?: number; playedFrames?: number }): void {
    const frames = Number(progress.playedFrames ?? progress.frames ?? 0);
    if (!this.nativeRate) return;
    this.nativeReceivedFrames = frames;
    this.position = this.nativeStartPosition + frames / this.nativeRate;
    if (this.duration && this.position > this.duration) this.position = this.duration;
    void this.maybePreloadNext();
    if (this.nativeExpectedFrames && frames >= this.nativeExpectedFrames) {
      void this.finishNative();
      return;
    }
    this.emit(false);
  }

  private async finishNative(): Promise<void> {
    if (this.finishedNative) return;
    if (this.nativeReceivedFrames === 0 && this.duration > 2 && this.position < this.duration - 1) {
      log.warn("native ended without frames", { id: this.nativeSongId });
      this.finishedNative = true;
      await this.stopNative();
      this.playing = false;
      this.loading = false;
      this.error = "原生输出没有产生音频帧";
      this.emit();
      return;
    }
    this.finishedNative = true;
    await this.stopNative();
    this.playing = false;
    this.position = this.duration;
    this.emit();
    await this.next();
  }

  private async stopNative(): Promise<void> {
    if (!this.keepGrowing) this.finalizeGrowing();
    this.streamNative = false;
    const session = this.nativeSession;
    this.nativeSession = undefined;
    this.nativeRate = 0;
    this.nativeExpectedFrames = 0;
    if (session) {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------- messages

  async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.emit();
        break;
      case "time":
        this.lastTimeAt = Date.now();
        this.position = msg.position;
        this.buffered = Math.max(this.position, msg.buffered ?? 0);
        if (msg.duration) this.duration = msg.duration;
        if (!this.playing && !this.loading) this.playing = true;
        void this.maybePreloadNext();
        this.emit(false);
        break;
      case "ended":
        this.playing = false;
        this.mediaLoaded = false;
        this.emit();
        await this.next();
        break;
      case "loadError": {
        log.warn("audio load error", msg.message);
        if (!this.webAudioRetried && this.currentSong) {
          this.webAudioRetried = true;
          try {
            const resolved = await this.resolveUrl(this.currentSong, true);
            if (resolved.url) {
              log.info("webaudio retry with fresh url", { type: resolved.type });
              this.loading = true;
              this.playing = true;
              this.emit();
              this.post({
                type: "load",
                request: {
                  song: this.currentSong,
                  url: resolved.url,
                  native: false,
                  position: this.position,
                  volume: this.volume,
                  duration: this.duration,
                },
              });
              break;
            }
          } catch (err) {
            log.warn("webaudio fresh url failed", (err as Error).message);
          }
        }
        this.mediaLoaded = false;
        this.loading = false;
        this.playing = false;
        this.error = msg.message;
        this.emit();
        break;
      }
      case "decodeError":
        if (this.nativeSession) break;
        this.post({ type: "playerError", message: msg.message });
        this.error = msg.message;
        this.emit();
        break;
      case "nativeFallbackLocal": {
        log.warn("native decode failed", msg.reason);
        await this.stopNative();
        this.loading = false;
        this.playing = true;
        if (this.currentSong && this.nativeRetry < 2) {
          this.nativeRetry += 1;
          log.info("native retry", { attempt: this.nativeRetry, reason: msg.reason });
          void this.start(this.currentSong, this.position);
          break;
        }
        this.output = {
          kind: "native",
          label: "原生输出不可用",
          detail: "原生路径失败：" + msg.reason,
          unavailableReason: msg.reason,
        };
        this.error = msg.reason;
        this.emit();
        this.post({ type: "toast", kind: "error", message: "原生输出仍不可用：" + msg.reason });
        break;
      }
      case "nativeBegin": {
        const token = ++this.nativeBeginToken;
        this.nativeBeginChain = this.nativeBeginChain
          .then(async () => {
            if (token !== this.nativeBeginToken) return;
            await this.handleNativeBegin(msg, token);
          })
          .catch((err) => log.warn("native begin failed", (err as Error).message));
        break;
      }
      case "pcm": {
        const buffer = Buffer.from(msg.data, "base64");
        this.nativeWriteChain = this.nativeWriteChain
          .then(async () => {
            const session = this.nativeSession;
            if (!session) return;
            await session.writePcm(buffer);
            this.post({ type: "nativePcmAck", seq: msg.seq });
          })
          .catch((err) => {
            const message = (err as Error).message;
            this.error = message;
            log.warn("native pcm write failed", message);
            this.post({ type: "nativeFallback", songId: this.nativeSongId ?? 0, reason: message });
            this.emit();
          });
        break;
      }
      case "pcmInt": {
        const buffer = Buffer.from(msg.data, "base64");
        if (msg.seq <= 2 || msg.seq % 60 === 0) {
          log.info("native pcm int", { seq: msg.seq, bytes: buffer.length, bits: msg.bits, frames: msg.frames });
        }
        this.nativeWriteChain = this.nativeWriteChain
          .then(async () => {
            const session = this.nativeSession;
            if (!session) return;
            await session.writePcmInt(buffer, msg.bits);
            this.post({ type: "nativePcmAck", seq: msg.seq });
          })
          .catch((err) => {
            const message = (err as Error).message;
            this.error = message;
            log.warn("native pcm write failed", message);
            this.post({ type: "nativeFallback", songId: this.nativeSongId ?? 0, reason: message });
            this.emit();
          });
        break;
      }
      case "pcmDone":
        this.nativeExpectedFrames = msg.totalFrames || this.nativeExpectedFrames;
        if (this.getConfig().output.bitPerfect) {
          void this.nativeSession?.drain().catch((err) => {
            this.error = (err as Error).message;
            this.emit();
          });
        }
        break;
    }
  }

  // ------------------------------------------------------------ persist

  private persistQueue(): void {
    this.queueDirty = true;
    this.scheduleSave();
  }

  private recordRecent(song: Track): void {
    this.recentTracks = [song, ...this.recentTracks.filter((item) => item.id !== song.id)].slice(0, RECENT_LIMIT);
    void this.ctx.globalState.update(RECENT_KEY, this.recentTracks);
  }

  private persistLiked(): void {
    void this.ctx.globalState.update(LIKED_KEY, [...this.likedIds]);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const payload: PersistedPlayback = {
        volume: this.volume,
        mode: this.mode,
        ids: this.queue.map((t) => t.id),
        index: this.index,
      };
      void this.ctx.globalState.update(PLAYBACK_KEY, payload);
      this.queueDirty = false;
    }, 600);
  }

  dispose(): void {
    void this.stopNative();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.emitter.dispose();
  }
}
