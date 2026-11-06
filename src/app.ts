import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
function safeDirStats(dir: string, exts?: RegExp): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  try {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = safeDirStats(full, exts);
        bytes += nested.bytes;
        files += nested.files;
      } else if (entry.isFile()) {
        if (exts && !exts.test(entry.name)) continue;
        bytes += fsSync.statSync(full).size;
        files += 1;
      }
    }
  } catch {
    /* missing directory */
  }
  return { bytes, files };
}

import * as QRCode from "qrcode";
import { SessionManager } from "./auth/session";
import { commentResource } from "./api/client";
import type {
  Account,
  Comment,
  AlbumDetail,
  ArtistDetail,
  ArtistRef,
  DjRadio,
  HomeFeed,
  PlaylistDetail,
  PlaylistRef,
  Toplist,
  Track,
  UserPlaylist,
  UserPage,
} from "./api/types";
import {
  defaultCacheDir,
  defaultNativeBackend,
  getConfig,
  normalizeNativeBackend,
  QUALITY_LABELS,
  QUALITY_OPTIONS,
  type NativeBackend,
  type Quality,
} from "./config";
import { DownloadManager } from "./download/downloader";
import { ComponentStore, type ComponentRecord } from "./player/components";
import { probeEngine, type EngineProbe } from "./player/nativeEngine";
import { PlayerService } from "./player/player";
import { SmtcService } from "./player/smtc";
import { LyricsOverlayService } from "./player/lyricsOverlay";
import type {
  CommentsView,
  ComponentView,
  HostMessage,
  InitState,
  ListenTogetherView,
  LocalTrackView,
  NativeStatusView,
  PageView,
  SearchKind,
  SettingsState,
  SettingsView,
  SidebarState,
  SubscribersView,
  WebviewCommand,
  WebviewMessage,
} from "./protocol";
import { log, showLog } from "./util/logger";
import { MainPanelProvider } from "./views/mainPanel";
import { SettingsPanelProvider } from "./views/settingsPanel";
import { SidebarViewProvider } from "./views/sidebarView";
import type { WebviewSurface } from "./views/surface";

const PANELS_KEY = "neteaseMusic.panels.v1";
const PLAYLIST_ORDER_KEY = "neteaseMusic.playlistOrder.v1";
const AUDIO_EXTS = new Set([".mp3", ".flac", ".m4a", ".wav", ".ogg", ".ape"]);

interface ProbeCache {
  path: string;
  probe: EngineProbe;
  at: number;
}

interface CommentsTarget {
  resource: string;
  id: number;
  kind: "playlist" | "song" | "album" | "artist";
}

const SHORTCUT_DEFS = [
  { id: "playPause", label: "播放/暂停", command: "neteaseMusic.playPause", local: "Alt+Shift+P", global: "Ctrl+Alt+Shift+P" },
  { id: "previous", label: "上一首", command: "neteaseMusic.previous", local: "Alt+Shift+Left", global: "Ctrl+Alt+Shift+Left" },
  { id: "next", label: "下一首", command: "neteaseMusic.next", local: "Alt+Shift+Right", global: "Ctrl+Alt+Shift+Right" },
  { id: "volumeUp", label: "音量加", command: "neteaseMusic.volumeUp", local: "Alt+Shift+Up", global: "Ctrl+Alt+Shift+Up" },
  { id: "volumeDown", label: "音量减", command: "neteaseMusic.volumeDown", local: "Alt+Shift+Down", global: "Ctrl+Alt+Shift+Down" },
  { id: "lyrics", label: "歌词悬浮窗", command: "neteaseMusic.toggleLyrics", local: "Alt+Shift+K", global: "Ctrl+Alt+Shift+K" },
  { id: "like", label: "喜欢歌曲", command: "neteaseMusic.like", local: "Alt+Shift+L", global: "Ctrl+Alt+Shift+L" },
] as const;

export class App implements vscode.Disposable {
  readonly session: SessionManager;
  readonly components: ComponentStore;
  readonly player: PlayerService;
  readonly downloads: DownloadManager;
  readonly sidebar: SidebarViewProvider;
  readonly mainPanel: MainPanelProvider;
  readonly settingsPanel: SettingsPanelProvider;

  private readonly status = {
    lyrics: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 119.5),
    buffer: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 119),
    like: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 118),
    favorite: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 117),
    mode: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 116),
    previous: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 115),
    play: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 114),
    next: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 113),
    title: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 120),
    quality: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105),
    sleep: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104.5),
    volume: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104),
    now: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103),
    queue: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 112),
    settings: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 111),
    idle: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
  };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusItems: vscode.StatusBarItem[];

  private userPlaylists: UserPlaylist[] = [];
  private smtc?: SmtcService;
  private lyricsOverlay?: LyricsOverlayService;
  private systemFonts: string[] = ["Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "SimSun"];
  private fontsLoaded = false;
  private playlistsLoaded = false;
  private activeNav = "recommend";
  private listen: ListenTogetherView = { status: "idle" };
  private listenPoll?: NodeJS.Timeout;
  private listenRoomId = "";
  private listenTrack?: Track;
  private listenBase?: { trackId: number; progress: number; at: number; playing: boolean };
  private listenCommand?: { targetSongId: number; formerSongId: number; clientSeq: number };
  private listenList: number[] = [];
  private listenQueue: Track[] = [];
  private listenListKey = "";
  private listenVersions: Array<{ userId: number; version: number }> = [];
  private listenPlayMode = "ORDER_LOOP";
  private listenForceSeek = false;
  private listenLastProgress?: number;
  private currentPage: PageView = { kind: "recommend", title: "推荐", loading: true };
  private pageHistory: PageView[] = [];
  private followingSong = false;
  private immersiveSidebarHidden = false;
  private navigatingBack = false;
  private settingsTab = "account";
  private lastOutputKind = "";
  private activePlaylist?: PlaylistDetail;
  private readonly playlistCache = new Map<number, PlaylistDetail>();
  private commentsTarget?: CommentsTarget;
  private commentsView?: CommentsView;
  private subscribersView?: SubscribersView;
  private commentsOffset = 0;
  private subscribersOffset = 0;
  private localTracks: LocalTrackView[] = [];
  private playlistOrder: number[] = [];
  private likedHydrated = false;
  private audioOwner: "sidebar" | "main" = "sidebar";
  private localCount = 0;
  private cloudTracks: Track[] = [];
  private qrTimer?: NodeJS.Timeout;
  private friendPoll?: NodeJS.Timeout;
  private probeCache?: ProbeCache;
  private autoConfiguring = false;
  private outputAutoInitialized = false;
  private probing = false;
  private outputProbeAt = 0;
  private lastVolume = 0.8;
  private pendingLogin = false;
  private pendingQueuePopup = false;
  private marqueeOffset = 0;
  private marqueeTimer?: NodeJS.Timeout;
  private lastTitle = "";
  private lastStatusKey = "";
  private sleepTimer?: NodeJS.Timeout;
  private sleepTicker?: NodeJS.Timeout;
  private sleepUntil?: number;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.session = new SessionManager(ctx, getConfig);
    this.components = new ComponentStore(ctx, getConfig);
    this.player = new PlayerService(ctx, this.session, this.components, getConfig);
    this.downloads = new DownloadManager(ctx, this.session, getConfig);
    this.statusItems = Object.values(this.status);
    for (const key of ["quality", "volume", "now"] as const) {
      const item = this.status[key];
      item.hide();
      (item as any).show = () => undefined;
    }

    const hostDeps = {
      handleCommand: (cmd: string, payload?: unknown, surface?: WebviewSurface) =>
        this.handleCommand(cmd, payload, surface),
    };
    this.sidebar = new SidebarViewProvider(ctx, {
      ...hostDeps,
      onAudio: (msg: WebviewMessage) => void this.player.onMessage(msg),
      onVisibility: () => undefined,
    });
    this.mainPanel = new MainPanelProvider(ctx, {
      ...hostDeps,
      onAudio: (msg: WebviewMessage) => void this.player.onMessage(msg),
      onVisibility: () => undefined,
    });
    this.settingsPanel = new SettingsPanelProvider(ctx, hostDeps);

    this.configureStatusBar();
    void this.applyShortcuts();
    void this.startSmtc();
  }

  private async loadSystemFonts(): Promise<void> {
    if (this.fontsLoaded || process.platform !== "win32") return;
    this.fontsLoaded = true;
    const record = await this.components.nativeRecord().catch(() => undefined);
    if (!record?.entryPath) return;
    try {
      const child = spawn(record.entryPath, ["--fonts"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      child.stdout.on("data", (data: Buffer) => { output += data.toString("utf8"); });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
        child.on("exit", () => { clearTimeout(timer); resolve(); });
        child.on("error", () => { clearTimeout(timer); resolve(); });
      });
      const found = output.split(/\r?\n/).map((line) => line.startsWith("FONT\t") ? line.slice(5).trim() : "").filter((name) => Boolean(name) && !name.startsWith("@"));
      if (found.length) {
        this.systemFonts = [...new Set(found)].sort((a, b) => a.localeCompare(b, "zh-CN"));
        this.pushSettings();
      }
    } catch {
      /* keep fallback fonts */
    }
  }

  private async startLyricsOverlay(): Promise<void> {
    if (process.platform !== "win32") return;
    if (!getConfig().lyricsOverlay.enabled) {
      this.lyricsOverlay?.stop();
      this.lyricsOverlay = undefined;
      return;
    }
    if (this.lyricsOverlay) return;
    const record = await this.components.nativeRecord().catch(() => undefined);
    if (!record?.entryPath || record.status !== "ready") return;
    const service = new LyricsOverlayService();
    service.onPosition = (x, y) => {
      void vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.x", x, vscode.ConfigurationTarget.Global);
      void vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.y", y, vscode.ConfigurationTarget.Global);
    };
    service.onCommand = (command) => {
      if (command === "previous") void this.player.previous();
      else if (command === "next") void this.player.next(true);
      else if (command === "playPause") {
        if (this.player.state().playing) void this.player.pause();
        else void this.player.toggle();
      } else if (command === "queue") this.openQueue();
      else if (command === "close") {
        void vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.enabled", false, vscode.ConfigurationTarget.Global);
        this.lyricsOverlay?.stop();
        this.lyricsOverlay = undefined;
        this.updateStatus();
      }
    };
    service.onStyle = (size, dual) => {
      void vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.size", size, vscode.ConfigurationTarget.Global);
      void vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.dual", dual, vscode.ConfigurationTarget.Global);
    };
    service.onLock = (locked) => {
      void vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.locked", locked, vscode.ConfigurationTarget.Global);
    };
    this.lyricsOverlay = service;
    service.start(record.entryPath, getConfig().lyricsOverlay);
    service.update(this.player.currentLyricLines());
    service.updateStatus(this.player.state().playing);
    this.updateStatus();
  }

  private async toggleLyrics(): Promise<void> {
    const enabled = !getConfig().lyricsOverlay.enabled;
    await vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.enabled", enabled, vscode.ConfigurationTarget.Global);
    if (enabled) await this.startLyricsOverlay();
    else {
      this.lyricsOverlay?.stop();
      this.lyricsOverlay = undefined;
    }
    this.updateStatus();
  }

  private async startSmtc(): Promise<void> {
    if (process.platform !== "win32") return;
    const record = await this.components.nativeRecord().catch(() => undefined);
    if (!record?.entryPath || record.status !== "ready") return;
    this.smtc = new SmtcService((action) => {
      const playing = this.player.state().playing;
      if (action === "play") {
        if (!playing) void this.player.toggle();
      } else if (action === "pause" || action === "stop") {
        if (playing) void this.player.pause();
      } else if (action === "next") {
        void this.player.next(true);
      } else if (action === "previous") {
        void this.player.previous();
      }
    });
    this.smtc.start(record.entryPath);
    this.smtc.update(this.player.state());
  }

  async activate(): Promise<void> {
    this.registerViews();
    this.registerCommands();
    this.wireEvents();

    this.player.attach(
      (msg: HostMessage) => this.routePlayerMessage(msg),
      (file: string) => this.sidebar.resourceUri(file),
    );

    this.playlistOrder = this.ctx.globalState.get<number[]>(PLAYLIST_ORDER_KEY) ?? [];
    try {
      await this.session.init();
    } catch (err) {
      log.error("session init failed", String(err));
    }
    try {
      await this.components.rescan();
    } catch (err) {
      log.warn("component scan failed", String(err));
    }
    void this.sidebar.ensureReady().catch(() => false);
    try {
      await this.player.restore();
    } catch (err) {
      log.warn("playback restore failed", String(err));
    }
    this.updateStatus();
    if (getConfig().ui.autoOpen) {
      this.mainPanel.createOrShow();
      void this.openRecommend().catch((err) => log.warn("recommend failed", String(err)));
    }
    void this.refreshUserPlaylists().catch(() => undefined);
    void this.pushComponents();
    void this.ensureNative()
      .then(() => {
        const cfg = getConfig();
        if (cfg.lyricsOverlay.enabled && cfg.lyricsOverlay.startOnLaunch) void this.startLyricsOverlay();
      })
      .catch((err) => log.warn("ensureNative failed", String(err)));
  }

  private registerViews(): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider("neteaseMusic.sidebar", this.sidebar, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
  }

  private wireEvents(): void {
    this.disposables.push(
      this.session.onDidChange((snapshot) => {
        this.broadcast({ type: "account", account: snapshot.account });
        this.pushSidebar();
        this.pushSettings();
        this.updateStatus();
        void this.refreshUserPlaylists().catch(() => undefined);
        if (snapshot.loggedIn) void this.openRecommend().catch(() => undefined);
      }),
      this.components.onDidChange(() => void this.pushComponents()),
      this.downloads.onDidChange(() => {
        const tasks = this.downloads.toViews();
        this.broadcast({ type: "downloads", tasks });
        this.pushSidebar();
      }),
      this.player.onDidChange(() => {
        const outputKind = this.player.state().output.kind;
        if (outputKind !== this.lastOutputKind) {
          this.lastOutputKind = outputKind;
          this.pushSettings();
        }
        this.updateStatus();
        this.smtc?.update(this.player.state());
        this.lyricsOverlay?.update(this.player.currentLyricLines());
        this.lyricsOverlay?.updateStatus(this.player.state().playing);
      }),
      vscode.window.onDidChangeActiveColorTheme((theme) =>
        this.broadcast({ type: "theme", kind: String(theme.kind) }),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("neteaseMusic.lyricsOverlay")) {
          void this.loadSystemFonts();
          if (event.affectsConfiguration("neteaseMusic.lyricsOverlay.enabled")) {
            void this.startLyricsOverlay();
          } else {
            this.lyricsOverlay?.applyStyle(getConfig().lyricsOverlay);
          }
        }
        if (event.affectsConfiguration("neteaseMusic.output.backend") && !this.autoConfiguring && !this.probing) {
          this.probing = true;
          void this.probeAudio(false).catch(() => undefined).finally(() => { this.probing = false; });
        }
        if (!event.affectsConfiguration("neteaseMusic")) return;
        this.pushSettings();
        if (event.affectsConfiguration("neteaseMusic.output")) void this.player.refreshOutput();
        if (event.affectsConfiguration("neteaseMusic.ui")) this.pushTheme();
        this.updateStatus();
      }),
    );
  }

  // ------------------------------------------------------------ webview glue

  private routePlayerMessage(msg: HostMessage): void {
    if (msg.type === "load") {
      // WebAudio must live in the editor webview when it is visible so the
      // click that started playback still counts as a user gesture. Native
      // output stays in the persistent sidebar host.
      if (!msg.request.native && this.mainPanel.isReady) {
        this.audioOwner = "main";
        this.mainPanel.post(msg);
      } else {
        this.audioOwner = "sidebar";
        this.sidebar.post(msg);
      }
      return;
    }
    if (
      msg.type === "control" ||
      msg.type === "nativeReady" ||
      msg.type === "nativePcmAck" ||
      msg.type === "nativeFallback"
    ) {
      const target = this.audioOwner === "main" && this.mainPanel.isReady ? this.mainPanel : this.sidebar;
      target.post(msg);
      return;
    }
    if (msg.type === "spectrum") {
      if (this.mainPanel.isReady) this.mainPanel.post(msg);
      return;
    }
    if (msg.type === "playerError" || msg.type === "toast") {
      if (msg.type === "playerError") log.warn("player error", msg.message);
      else if (msg.kind === "error") log.warn("player toast", msg.message);
      this.broadcast(msg);
      return;
    }
    this.broadcast(msg);
  }

  private broadcast(msg: HostMessage): void {
    this.mainPanel.post(msg);
    this.sidebar.post(msg);
    this.settingsPanel.post(msg);
  }

  private toast(message: string, kind: "info" | "error" | "success" = "info"): void {
    this.broadcast({ type: "toast", kind, message });
  }

  private pushTheme(): void {
    const kind = String(vscode.window.activeColorTheme.kind);
    this.broadcast({ type: "theme", kind });
  }

  async handleCommand(cmd: string, payload?: unknown, surface: WebviewSurface = "main"): Promise<void> {
    if (cmd !== "ready" && cmd !== "setVolume" && cmd !== "seek") log.info("command", { cmd, surface, id: (payload as any)?.id ?? (payload as any)?.track?.id });
    try {
      if (cmd === "ready") {
        await this.sendInit(surface);
        return;
      }
      if (cmd === "audio") {
        await this.player.onMessage(payload as WebviewMessage);
        return;
      }
      await this.dispatch(cmd as WebviewCommand, payload ?? {}, surface);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      log.error(`command failed: ${cmd}`, String(err));
      this.toast(message, "error");
    }
  }

  private async sendInit(surface: WebviewSurface): Promise<void> {
    if (surface === "sidebar") {
      await this.refreshUserPlaylists().catch(() => undefined);
      this.sidebar.post({ type: "sidebarInit", state: this.sidebarState() });
      this.sidebar.post({ type: "state", state: this.player.state() });
      return;
    }
    if (surface === "settings") {
      this.settingsPanel.post({ type: "settingsInit", state: await this.settingsState() });
      if (this.pendingLogin) {
        this.pendingLogin = false;
        this.settingsPanel.post({ type: "openLogin" });
      }
      return;
    }
    this.mainPanel.post({ type: "init", state: await this.initState() });
    this.player.sendCurrentLyric();
    if (this.pendingQueuePopup) {
      this.pendingQueuePopup = false;
      this.mainPanel.post({ type: "queuePopup", open: true });
    }
    if (this.currentPage.loading) void this.openRecommend().catch(() => undefined);
  }

  private async initState(): Promise<InitState> {
    const cfg = getConfig();
    return {
      player: this.player.state(),
      account: this.session.accountInfo,
      queue: this.player.getQueue(),
      queueSources: this.player.getQueueSources(),
      settings: this.settingsView(),
      page: this.currentPage,
      panels: {
        ...(this.ctx.globalState.get<Record<string, boolean>>(PANELS_KEY) ?? {}),
        ...cfg.ui.panels,
      },
      components: (await this.components.list()).map((record) => this.components.toView(record)),
      native: await this.nativeStatus(),
      downloads: this.downloads.toViews(),
      showLyrics: cfg.ui.showLyrics,
      compact: cfg.ui.compact,
      theme: String(vscode.window.activeColorTheme.kind),
      version: String(this.ctx.extension.packageJSON.version ?? "0.0.0"),
      platform: process.platform,
      arch: process.arch,
    };
  }

  private async settingsState(): Promise<SettingsState> {
    if (!this.probing && this.player.state().output.kind !== "native" && Date.now() - this.outputProbeAt > 5000) {
      this.outputProbeAt = Date.now();
      this.probing = true;
      void this.probeAudio(false).catch(() => undefined).finally(() => { this.probing = false; });
    }
    return {
      account: this.session.accountInfo,
      settings: this.settingsView(),
      qualityOptions: QUALITY_OPTIONS,
      components: (await this.components.list()).map((record) => this.components.toView(record)),
      native: await this.nativeStatus(),
      activeTab: this.settingsTab,
      version: String(this.ctx.extension.packageJSON.version ?? "0.0.0"),
      platform: process.platform,
      arch: process.arch,
      loggedIn: this.session.loggedIn,
      vip: this.session.vip,
    };
  }

  private resourceStats() {
    const cfg = getConfig();
    const extension = safeDirStats(this.ctx.extensionPath);
    const cache = safeDirStats(cfg.cache.dir || defaultCacheDir(this.ctx), /\.(flac|mp3|part)$/i);
    const download = safeDirStats(this.downloads.dir, /\.(flac|mp3|m4a|wav|ogg)$/i);
    const coverDir = cfg.cover.dir || path.join(this.downloads.dir, "covers");
    const cover = safeDirStats(coverDir, /\.(png|jpe?g|webp|gif)$/i);
    const local = safeDirStats(cfg.localMusic.dir || this.downloads.dir, /\.(flac|mp3|m4a|wav|ogg|ape)$/i);
    const cpu = process.cpuUsage();
    const hostCpu = (cpu.user + cpu.system) / 1e6 / Math.max(1, process.uptime()) * 100;
    return {
      extensionPath: this.ctx.extensionPath,
      extensionBytes: extension.bytes,
      cacheBytes: cache.bytes,
      cacheFiles: cache.files,
      downloadBytes: download.bytes,
      downloadFiles: download.files,
      coverBytes: cover.bytes,
      coverFiles: cover.files,
      localBytes: local.bytes,
      localFiles: local.files,
      hostRss: process.memoryUsage().rss,
      hostCpu: Math.min(100, Math.round(hostCpu * 10) / 10),
    };
  }

  private settingsView(): SettingsView {
    const cfg = getConfig();
    return {
      version: String(this.ctx.extension.packageJSON.version ?? "0.0.0"),
      stats: this.resourceStats(),
      showTitle: cfg.status.showTitle,
      showLyricsButton: cfg.status.showLyrics,
      showLike: cfg.status.showLike,
      showFavorite: cfg.status.showFavorite,
      showMode: cfg.status.showMode,
      showNavigation: cfg.status.showNavigation,
      showBuffer: cfg.status.showBuffer,
      showQueue: cfg.status.showQueue,
      lyricsEnabled: cfg.lyricsOverlay.enabled,
      lyricsStartOnLaunch: cfg.lyricsOverlay.startOnLaunch,
      lyricsFont: cfg.lyricsOverlay.font,
      lyricsSize: cfg.lyricsOverlay.size,
      lyricsColor: cfg.lyricsOverlay.color,
      lyricsOpacity: cfg.lyricsOverlay.opacity,
      lyricsWidth: cfg.lyricsOverlay.width,
      lyricsHeight: cfg.lyricsOverlay.height,
      lyricsLocked: cfg.lyricsOverlay.locked,
      lyricsX: cfg.lyricsOverlay.x,
      lyricsY: cfg.lyricsOverlay.y,
      lyricsWeight: cfg.lyricsOverlay.weight,
      lyricsFontFile: cfg.lyricsOverlay.fontFile,
      lyricsBorderWidth: cfg.lyricsOverlay.borderWidth,
      lyricsBorderColor: cfg.lyricsOverlay.borderColor,
      fonts: this.systemFonts,
      shortcuts: this.shortcutValues(),
      quality: cfg.quality,
      downloadQuality: cfg.download.quality === "auto" ? "auto" : QUALITY_LABELS[cfg.download.quality] ?? cfg.download.quality,
      downloadDir: this.downloads.dir,
      coverDir: cfg.cover.dir || path.join(this.downloads.dir, "covers"),
      coverFilenameTemplate: cfg.cover.filenameTemplate,
      cacheDir: cfg.cache.dir || defaultCacheDir(this.ctx),
      cacheLocked: this.player.state().output.kind === "native",
      localMusicDir: cfg.localMusic.dir || this.downloads.dir,
      componentsDir: this.components.rootDir,
      outputMode: cfg.output.mode,
      device: cfg.output.device,
      sampleRate: cfg.output.sampleRate,
      bitDepth: cfg.output.bitDepth,
      sampleFormat: cfg.output.sampleFormat,
      exclusive: cfg.output.exclusive,
      bitPerfect: cfg.output.bitPerfect,
      persistentSeek: cfg.output.persistentSeek,
      hrtf: cfg.output.hrtf,
      nativeBackend: cfg.output.backend,
      bufferMs: cfg.output.bufferMs,
      volume: Math.round(cfg.playback.volume),
      mode: cfg.playback.mode,
      backgroundPlay: cfg.playback.backgroundPlay,
      autoPlay: cfg.playback.autoPlay,
      startOnLaunch: cfg.playback.startOnLaunch,
      rememberQueue: cfg.playback.rememberQueue,
      themeMode: cfg.ui.theme,
      compact: cfg.ui.compact,
      showLyrics: cfg.ui.showLyrics,
      autoOpen: cfg.ui.autoOpen,
      nativeEnginePath: cfg.components.nativeEnginePath,
      verifyHash: cfg.components.verifyHash,
      autoDownload: cfg.components.autoDownload,
      downloadUrl: cfg.components.downloadUrl,
      filenameTemplate: cfg.download.filenameTemplate,
      downloadConcurrent: cfg.download.concurrent,
      writeMetadata: cfg.download.writeMetadata,
      saveLyric: cfg.download.saveLyric,
      cacheEnabled: cfg.cache.enabled,
      cacheMaxSizeMB: cfg.cache.maxSizeMB,
    };
  }

  private pushSettings(): void {
    this.settingsPanel.post({ type: "settings", settings: this.settingsView() });
  }

  private async pushComponents(): Promise<void> {
    const items: ComponentView[] = (await this.components.list()).map((record) => this.components.toView(record));
    const native = await this.nativeStatus();
    this.broadcast({ type: "components", items, native });
    this.settingsPanel.post({ type: "components", items, native });
  }

  private sidebarState(): SidebarState {
    const account = this.session.accountInfo;
    const likedItem = this.userPlaylists.find((playlist) => playlist.specialType === 5) ?? null;
    const liked = likedItem ? this.toPlaylistRef(likedItem) : null;
    const created = this.userPlaylists
      .filter((playlist) => playlist.specialType !== 5 && !playlist.subscribed)
      .sort((a, b) => {
        const ai = this.playlistOrder.indexOf(a.id);
        const bi = this.playlistOrder.indexOf(b.id);
        if (ai < 0 && bi < 0) return 0;
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      })
      .map((playlist) => this.toPlaylistRef(playlist));
    const subscribed = this.userPlaylists
      .filter((playlist) => playlist.specialType !== 5 && playlist.subscribed)
      .map((playlist) => this.toPlaylistRef(playlist));
    const activeDownloads = this.downloads
      .toViews()
      .filter((task) => task.status === "downloading" || task.status === "queued").length;
    return {
      account,
      liked,
      created,
      subscribed,
      counts: {
        liked: liked?.trackCount ?? 0,
        recent: this.player.getRecent().length,
        downloads: activeDownloads,
        local: this.localCount,
        cloud: this.cloudTracks.length,
      },
      active: this.activeNav,
      collapsed: getConfig().ui.panels,
      version: String(this.ctx.extension.packageJSON.version ?? "0.0.0"),
      listen: this.listen,
    };
  }

  private toPlaylistRef(playlist: UserPlaylist): PlaylistRef {
    return {
      id: playlist.id,
      name: playlist.name,
      coverImgUrl: playlist.coverImgUrl,
      trackCount: playlist.trackCount,
      playCount: playlist.playCount,
      subscribed: playlist.subscribed,
      creator: { userId: playlist.creatorId, nickname: "" },
      specialType: playlist.specialType,
    };
  }

  private pushSidebar(): void {
    this.sidebar.post({ type: "sidebar", state: this.sidebarState() });
  }

  // --------------------------------------------------------------- dispatch

  private async dispatch(cmd: WebviewCommand, payload: any, surface: WebviewSurface): Promise<void> {
    switch (cmd) {
      case "nav": {
        const nav = String(payload.nav ?? "recommend");
        this.activeNav = nav;
        this.pushSidebar();
        if (nav === "recommend") await this.openRecommend();
        else if (nav === "featured") await this.openFeatured();
        else if (nav === "podcast") await this.openPodcast();
        else if (nav === "roam") await this.openRoam();
        else if (nav === "following") await this.openFollowing();
        else if (nav === "friends") await this.openFriends();
        else if (nav === "recent") await this.openRecent();
        else if (nav === "collections") await this.openCollections();
        else if (nav === "downloads") await this.openDownloads();
        else if (nav === "local") await this.openLocal();
        else if (nav === "cloud") await this.openCloud();
        else if (nav === "liked") await this.openLiked();
        break;
      }
      case "openMain":
        this.openMain();
        break;
      case "back":
        await this.goBack();
        break;
      case "openSettings":
        await this.openSettings(String(payload.tab ?? this.settingsTab));
        break;
      case "createPlaylist":
        await this.createPlaylist();
        break;
      case "resetLyricsSettings": {
        const config = vscode.workspace.getConfiguration("neteaseMusic");
        const defaults: Record<string, unknown> = {
          "lyricsOverlay.font": "Microsoft YaHei UI",
          "lyricsOverlay.size": 30,
          "lyricsOverlay.color": "#ffffff",
          "lyricsOverlay.weight": 600,
          "lyricsOverlay.borderWidth": 1,
          "lyricsOverlay.borderColor": "#ffffff",
          "lyricsOverlay.opacity": 85,
          "lyricsOverlay.width": 900,
          "lyricsOverlay.height": 220,
          "lyricsOverlay.locked": false,
          "lyricsOverlay.x": -1,
          "lyricsOverlay.y": -1,
          "lyricsOverlay.fontFile": "",
        };
        for (const [key, value] of Object.entries(defaults)) {
          await config.update(key, value, vscode.ConfigurationTarget.Global);
        }
        this.lyricsOverlay?.applyStyle(getConfig().lyricsOverlay);
        this.pushSettings();
        break;
      }
      case "chooseFontFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 字体: ["ttf", "otf", "ttc"] },
          openLabel: "选择字体文件",
        });
        if (picked?.[0]) {
          await vscode.workspace.getConfiguration("neteaseMusic").update("lyricsOverlay.fontFile", picked[0].fsPath, vscode.ConfigurationTarget.Global);
          this.pushSettings();
        }
        break;
      }
      case "choosePlaylistCover": {
        const id = Number(payload.id ?? 0);
        if (!id) return;
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 图片: ["png", "jpg", "jpeg", "webp"] },
          openLabel: "设为歌单封面",
        });
        if (!picked?.[0]) return;
        await this.session.client.updatePlaylistCover(id, picked[0].fsPath);
        this.toast("歌单封面已更新", "success");
        if (this.activePlaylist?.playlist.id === id) await this.openPlaylist(id);
        break;
      }
      case "deletePlaylist":
        await this.deletePlaylist(Number(payload.id));
        break;
      case "movePlaylist":
        await this.movePlaylist(Number(payload.id), Number(payload.direction ?? 0));
        break;
      case "openNow":
        await this.openNow();
        break;
      case "openSongDetail":
        await this.openSongDetail(Number(payload.id));
        break;
      case "followSongDetail":
        this.followingSong = true;
        try {
          await this.openSongDetail(Number(payload.id));
        } finally {
          this.followingSong = false;
        }
        break;
      case "immersive": {
        const active = Boolean(payload.active);
        try {
          if (active && !this.immersiveSidebarHidden) {
            await vscode.commands.executeCommand("workbench.action.closeSidebar");
            this.immersiveSidebarHidden = true;
          } else if (!active && this.immersiveSidebarHidden) {
            await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
            this.immersiveSidebarHidden = false;
          }
        } catch {
          /* sidebar command unavailable in some builds */
        }
        break;
      }
      case "openSongComments": {
        const id = Number(payload.id ?? this.currentPage.song?.track.id ?? 0);
        if (id) await this.openComments({ resource: commentResource("song", id), id, offset: 0 });
        break;
      }
      case "postComment": {
        const id = Number(payload.id ?? this.currentPage.song?.track.id ?? 0);
        if (id) await this.postSongComment(id, String(payload.content ?? ""));
        break;
      }
      case "loadCommentReplies": {
        const parentId = Number(payload.parentId ?? 0);
        const resource = String(payload.resource ?? this.commentsTarget?.resource ?? "");
        const id = Number(payload.id ?? this.commentsTarget?.id ?? 0);
        if (!parentId || !resource || !id) break;
        try {
          const result = await this.session.client.commentReplies(resource, id, parentId, 30, 0);
          this.mainPanel.post({ type: "commentReplies", parentId, comments: result.comments, total: result.total, more: result.comments.length < result.total });
        } catch (err) {
          this.mainPanel.post({ type: "commentReplies", parentId, comments: [], total: 0, more: false, error: (err as Error).message });
        }
        break;
      }
      case "likeComment": {
        const commentId = Number(payload.commentId ?? 0);
        const resource = String(payload.resource ?? this.commentsTarget?.resource ?? "");
        const id = Number(payload.id ?? this.commentsTarget?.id ?? 0);
        if (!commentId || !resource || !id) break;
        const like = !Boolean(payload.liked);
        const current = Number(payload.likedCount ?? 0);
        await this.session.client.likeComment(resource, commentId, like);
        this.mainPanel.post({ type: "commentLike", commentId, liked: like, likedCount: Math.max(0, current + (like ? 1 : -1)) });
        break;
      }
      case "replyComment": {
        const parentId = Number(payload.parentId ?? 0);
        const resource = String(payload.resource ?? this.commentsTarget?.resource ?? "");
        const id = Number(payload.id ?? this.commentsTarget?.id ?? 0);
        const content = String(payload.content ?? "").trim();
        if (!parentId || !resource || !id || !content) break;
        await this.session.client.addComment(resource, content, parentId);
        this.toast("回复已发送", "success");
        await this.openComments({ resource, id, offset: 0 });
        break;
      }
      case "openFriendChat":
        await this.openFriendChat(Number(payload.uid));
        break;
      case "sendFriendMessage":
        await this.sendFriendMessage(String(payload.content ?? ""));
        break;
      case "copyText":
        await vscode.env.clipboard.writeText(String(payload.text ?? ""));
        this.toast("链接已复制", "success");
        break;
      case "openUser":
        await this.openUser(Number(payload.uid));
        break;
      case "openMyProfile":
        await this.openMyProfile();
        break;
      case "openArtistByName":
        await this.openArtistByName(String(payload.name ?? ""));
        break;
      case "fixSampleRate":
        await this.fixSampleRate();
        break;
      case "openQueue":
        this.openQueue();
        break;
      case "openRecent":
        await this.openRecent();
        break;
      case "openCollections":
        await this.openCollections();
        break;
      case "openDownloads":
        await this.openDownloads();
        break;
      case "openLocal":
        await this.openLocal();
        break;
      case "openCloud":
        await this.openCloud();
        break;
      case "openLiked":
        await this.openLiked();
        break;
      case "openPlaylist":
        await this.openPlaylist(Number(payload.id));
        break;
      case "openAlbum":
        await this.openAlbum(Number(payload.id));
        break;
      case "openArtist":
        await this.openArtist(Number(payload.id));
        break;
      case "openRadio": {
        const radio = payload.radio as DjRadio | undefined;
        if (radio?.id) await this.openRadio(radio);
        break;
      }
      case "openArtistSongs":
        await this.openArtistSongs(Number(payload.id), String(payload.name ?? "歌手"));
        break;
      case "loadMoreArtistSongs":
        await this.loadMoreArtistSongs();
        break;
      case "playTrack": {
        await this.ensureAudioHost();
        const track = payload.track as Track | undefined;
        if (!track) return;
        if (await this.playInListenRoom(track)) break;
        const list = Array.isArray(payload.list) && payload.list.length ? (payload.list as Track[]) : undefined;
        const index = Number.isFinite(payload.index) ? Number(payload.index) : undefined;
        await this.player.playTrack(track, list, index, payload.source as any);
        if (this.player.state().error) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          await this.ensureAudioHost();
          await this.player.playTrack(track, list, index);
        }
        break;
      }
      case "playQueueIndex":
        await this.ensureAudioHost();
        await this.player.playAt(Number(payload.index));
        break;
      case "playAll": {
        const tracks = Array.isArray(payload.tracks) ? (payload.tracks as Track[]) : [];
        if (!tracks.length) return;
        await this.ensureAudioHost();
        await this.player.setQueueAndPlay(tracks, Number(payload.index ?? 0), true, payload.source as any);
        break;
      }
      case "playNext":
        if (payload.track) this.player.playNext(payload.track as Track, payload.source as any);
        break;
      case "playPause":
        if (await this.localListenControl("toggle")) break;
        await this.ensureAudioHost();
        await this.player.toggle();
        break;
      case "setVolume":
        await this.player.setVolume(Math.max(0, Math.min(100, Number(payload.value ?? 80))) / 100);
        break;
      case "next":
        if (await this.localListenControl("next")) break;
        await this.player.next(true);
        break;
      case "previous":
        if (await this.localListenControl("previous")) break;
        await this.player.previous();
        break;
      case "seek": {
        const target = Number(payload.value);
        if (this.listen.status === "connected") {
          const sent = await this.sendListenPlayCommand("PROGRESS", undefined, Math.round(target * 1000));
          if (sent) {
            this.listenBase = {
              trackId: this.player.current?.id ?? 0,
              progress: target,
              at: Date.now(),
              playing: this.player.state().playing,
            };
            this.listenLastProgress = target;
          }
        }
        await this.player.seek(target);
        break;
      }
      case "volume":
        await this.player.setVolume(Number(payload.value));
        break;
      case "mode":
        await this.player.setMode(payload.mode);
        break;
      case "quality":
        await this.setPlaybackQuality(payload.quality as Quality);
        break;
      case "playlistSubscribe": {
        const id = Number(payload.id ?? this.currentPage.playlist?.playlist.id ?? 0);
        if (!id) return;
        await this.session.client.playlistSubscribe(id, true);
        this.toast("已收藏歌单", "success");
        await this.refreshUserPlaylists();
        break;
      }
      case "downloadQuality":
        await this.setDownloadQuality(payload.quality);
        break;
      case "enqueueTrack":
        if (payload.track) this.player.addToQueue(payload.track as Track, payload.source as any);
        break;
      case "enqueuePlaylist": {
        const view = await this.ensurePlaylist(Number(payload.id));
        if (view) {
          this.player.addManyToQueue(view.tracks, { id: view.playlist.id, name: view.playlist.name, kind: "playlist" });
          this.toast(`已加入队列：${view.tracks.length} 首`, "success");
        }
        break;
      }
      case "removeFromQueue":
        this.player.removeFromQueue(Number(payload.index));
        break;
      case "clearQueue":
        this.player.clearQueue();
        break;
      case "search":
        await this.openSearch(String(payload.query ?? ""), (payload.kind as SearchKind) ?? "all");
        break;
      case "searchKind":
        await this.openSearch(String(payload.query ?? this.currentPage.search?.query ?? ""), (payload.kind as SearchKind) ?? "song");
        break;
      case "likeTrack": {
        const id = Number(payload.id);
        if (!id) return;
        if (id < 0) throw new Error("本地音乐没有关联的网易云歌曲，无法喜欢");
        const liked = await this.player.toggleLike(id);
        this.settingsPanel.post({ type: "toast", kind: "success", message: liked ? "已添加到喜欢的音乐" : "已取消喜欢" });
        this.mainPanel.post({ type: "toast", kind: "success", message: liked ? "已添加到喜欢的音乐" : "已取消喜欢" });
        break;
      }
      case "openFavorite":
        await this.openFavorite(Number(payload.id));
        break;
      case "favoriteTo":
        await this.addFavorite(Number(payload.playlistId), Number(payload.trackId));
        break;
      case "removeFromPlaylist": {
        const playlistId = Number(payload.playlistId);
        const trackId = Number(payload.trackId);
        if (!playlistId || !trackId) return;
        this.playlistCache.delete(playlistId);
    await this.session.client.removeTrackFromPlaylist(playlistId, trackId);
        this.toast("已从歌单删除", "success");
        await this.openPlaylist(playlistId);
        break;
      }
      case "qualityPicker":
        await vscode.commands.executeCommand("neteaseMusic.qualityPicker");
        break;
      case "joinListen":
        await this.joinListenTogether(String(payload.input ?? ""));
        break;
      case "leaveListen":
        this.leaveListenTogether();
        break;
      case "sleepTimer":
        await this.pickSleepTimer();
        break;
      case "setSleepTimer":
        this.setSleepTimer(Number(payload.minutes ?? 0));
        break;
      case "setPlaybackRate":
        await this.player.setRate(Number(payload.value ?? 1));
        break;
      case "playbackRate":
        await this.pickPlaybackRate();
        break;
      case "downloadTrack": {
        const track = payload.track as Track | undefined;
        if (!track) return;
        await this.downloads.enqueue(track);
        this.toast(`开始下载：${track.name}`);
        break;
      }
      case "downloadCurrent": {
        const track = this.player.current;
        if (!track) throw new Error("当前没有播放歌曲");
        await this.downloads.enqueue(track);
        this.toast(`开始下载：${track.name}`);
        break;
      }
      case "cancelDownload":
        this.downloads.cancel(String(payload.id));
        break;
      case "clearDownloads":
        this.downloads.clearFinished();
        break;
      case "openDownloadDir": {
        const dir = path.resolve(this.downloads.dir);
        await fs.mkdir(dir, { recursive: true });
        await this.openInFileManager(dir);
        break;
      }
      case "downloadCover": {
        await this.downloadCover(payload);
        break;
      }
      case "playLocal": {
        const file = String(payload.path ?? "");
        const index = this.localTracks.findIndex((entry) => entry.path === file);
        const item = index >= 0 ? this.localTracks[index] : undefined;
        if (!item) throw new Error("本地文件不存在或不在本地音乐目录中");
        const ok = await this.sidebar.ensureReady();
        if (!ok) throw new Error("播放本地音乐需要打开网易云音乐侧边栏（音频宿主）");
        const tracks = this.localTracks.map((entry) => this.localTrackViewToTrack(entry));
        await this.player.playTrack(tracks[index], tracks, index);
        break;
      }
      case "tab":
        if (surface === "settings") {
          this.settingsTab = String(payload.tab ?? "account");
          break;
        }
        await this.setPageTab(String(payload.tab ?? "songs"));
        break;
      case "loadComments":
        await this.openComments(payload);
        break;
      case "loadSubscribers":
        await this.openSubscribers(Number(payload.id), Number(payload.offset ?? 0));
        break;
      case "copy":
        await vscode.env.clipboard.writeText(String(payload.text ?? ""));
        this.toast("已复制到剪贴板", "success");
        break;
      case "openLink": {
        const url = new URL(String(payload.url ?? ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许打开 HTTP(S) 链接");
        await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
        break;
      }
      case "login":
        await this.openLogin();
        break;
      case "qrStop":
        this.stopQr();
        break;
      case "qrStart":
        await this.startQrLogin();
        break;
      case "sendCaptcha":
        await this.session.client.captchaSent(String(payload.phone ?? ""));
        this.toast("验证码已发送", "success");
        break;
      case "phoneLogin":
        await this.loginWithPhone(payload);
        break;
      case "emailLogin":
        await this.loginWithEmail(payload);
        break;
      case "logout":
        this.stopQr();
        await this.session.logout();
        this.userPlaylists = [];
        this.pushSidebar();
        this.broadcast({ type: "account", account: null });
        this.pushSettings();
        this.toast("已退出登录", "success");
        this.updateStatus();
        break;
      case "refreshAccount":
        await this.session.refreshAccount();
        this.broadcast({ type: "account", account: this.session.accountInfo });
        await this.refreshUserPlaylists();
        this.toast("账户信息已刷新", "success");
        break;
      case "refreshPage":
        if (surface === "sidebar") {
          await this.refreshUserPlaylists();
          this.toast("歌单已刷新", "success");
        } else {
          await this.refreshCurrentPage();
        }
        break;
      case "resetShortcuts":
        await this.ctx.globalState.update("neteaseMusic.shortcuts", undefined);
        await this.applyShortcuts();
        this.pushSettings();
        break;
      case "setShortcut":
        await this.setShortcut(String(payload.id ?? ""), String(payload.value ?? ""));
        break;
      case "setConfig": {
        const key = String(payload.key ?? "");
        if (!key) return;
        await vscode.workspace
          .getConfiguration("neteaseMusic")
          .update(key, payload.value, vscode.ConfigurationTarget.Global);
        if (key === "output.exclusive" && payload.value === false) {
          const configuration = vscode.workspace.getConfiguration("neteaseMusic");
          if (configuration.get<boolean>("output.bitPerfect")) {
            await configuration.update("output.bitPerfect", false, vscode.ConfigurationTarget.Global);
            this.toast("关闭独占模式时已同时关闭 Bit-perfect；Bit-perfect 会强制 Exclusive。", "info");
          }
        }
        if (key === "output.bitPerfect" && payload.value === true) {
          await vscode.workspace.getConfiguration("neteaseMusic").update("output.exclusive", true, vscode.ConfigurationTarget.Global);
        }
        if (key === "output.hrtf" && payload.value === true) {
          await vscode.workspace.getConfiguration("neteaseMusic").update("output.bitPerfect", false, vscode.ConfigurationTarget.Global);
        }
        if (key === "output.bitPerfect" && payload.value === true) {
          await vscode.workspace.getConfiguration("neteaseMusic").update("output.hrtf", false, vscode.ConfigurationTarget.Global);
        }
        if (key === "output.bitPerfect" && payload.value === true) {
          void vscode.window.showWarningMessage(
            "启用 Bit-perfect 后，PC 端音量将固定为 100%。请先调整好您的前端（小尾巴/大尾巴/解码器/放大器）音量！",
            { modal: true },
            "知道了",
          );
        }
        if (key === "cache.maxSizeMB" || key === "cache.dir" || key === "cache.enabled") {
          await this.player.pruneCacheNow();
        }
        if (key === "playback.volume") {
          await this.player.setVolume(Number(payload.value) / 100);
        } else if (key === "playback.mode") {
          await this.player.setMode(payload.value as any);
        }
        this.pushSettings();
        this.pushSidebar();
        if (key === "lyricsOverlay.enabled") await this.startLyricsOverlay();
        else if (key.startsWith("lyricsOverlay.")) this.lyricsOverlay?.applyStyle(getConfig().lyricsOverlay);
        if ((key === "output.exclusive" || key === "output.bitPerfect") && payload.value === false) {
          await this.player.releaseNativeOutput();
        }
        if (key.startsWith("output.")) await this.player.refreshOutput();
        if ((key === "output.hrtf" || key === "output.bitPerfect" || key === "output.exclusive" || key === "output.backend" || key === "output.device") && this.player.isPlaying) {
          await this.player.restartCurrent();
        }
        this.updateStatus();
        break;
      }
      case "chooseDir": {
        const key = String(payload.key ?? "");
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择目录",
          title: "选择网易云音乐目录",
        });
        if (!picked?.[0]) return;
        const nextDir = picked[0].fsPath;
        const previous = this.directoryForSetting(key);
        if (previous && path.resolve(previous) !== path.resolve(nextDir)) {
          await this.migrateDirectory(previous, nextDir, key);
        }
        await vscode.workspace
          .getConfiguration("neteaseMusic")
          .update(key, nextDir, vscode.ConfigurationTarget.Global);
        await fs.mkdir(nextDir, { recursive: true }).catch(() => undefined);
        this.pushSettings();
        this.toast("目录已更新并迁移数据", "success");
        break;
      }
      case "openConfigFile":
        await vscode.commands.executeCommand("workbench.action.openSettingsJson");
        break;
      case "openVscodeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:AICis.netease-music-vscode");
        break;
      case "openDocs":
        await this.openDocs();
        break;
      case "showLog":
        showLog();
        break;
      case "refreshComponents":
        await this.components.rescan();
        await this.pushComponents();
        break;
      case "installComponent":
        await this.installComponent();
        break;
      case "enableComponent":
        await this.components.setEnabled(String(payload.id), true);
        await this.pushComponents();
        await this.player.refreshOutput();
        break;
      case "disableComponent":
        await this.components.setEnabled(String(payload.id), false);
        await this.pushComponents();
        await this.player.refreshOutput();
        break;
      case "removeComponent":
        await this.removeComponent(String(payload.id));
        break;
      case "verifyComponent": {
        const result = await this.components.verify(String(payload.id));
        this.toast(result.message, result.ok ? "success" : "error");
        break;
      }
      case "locateComponent":
        await this.locateComponent(String(payload.id));
        break;
      case "restoreBundled": {
        const record = await this.components.restoreBundledNative();
        await this.pushComponents();
        await this.player.refreshOutput();
        this.toast(`已恢复随包原生引擎 ${record.version}`, "success");
        break;
      }
      case "openComponentDir":
        await this.openComponentDir(String(payload.id));
        break;
      case "probeAudio":
        await this.probeAudio(true);
        break;
      case "restartApp":
        this.restartApp();
        break;
      case "clearCache": {
        const cfg = getConfig();
        const dir = cfg.cache.dir || defaultCacheDir(this.ctx);
        await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
        let removed = 0;
        let failed = 0;
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          try {
            await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
            removed += 1;
          } catch {
            failed += 1;
          }
        }
        this.pushSettings();
        this.toast(failed ? `缓存已清除 ${removed} 项，${failed} 项正在使用` : "缓存已清除", failed ? "info" : "success");
        break;
      }
      case "openDir": {
        const kind = String(payload.dir ?? "");
        const cfg = getConfig();
        const map: Record<string, string> = {
          cache: cfg.cache.dir || defaultCacheDir(this.ctx),
          download: this.downloads.dir,
          cover: cfg.cover.dir || path.join(this.downloads.dir, "covers"),
          local: cfg.localMusic.dir || this.downloads.dir,
          extension: this.ctx.extensionPath,
        };
        const target = map[kind];
        if (target) {
          await fs.mkdir(target, { recursive: true }).catch(() => undefined);
          const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
          try {
            const child = spawn(command, [target], { detached: true, stdio: "ignore" });
            child.unref();
          } catch {
            await vscode.env.openExternal(vscode.Uri.file(target)).then(undefined, () => undefined);
          }
        }
        break;
      }
      case "selectDevice":
        await this.selectDevice();
        break;
      case "setPanel": {
        const panels = { ...getConfig().ui.panels };
        panels[String(payload.key)] = Boolean(payload.open);
        await vscode.workspace
          .getConfiguration("neteaseMusic")
          .update("ui.panels", panels, vscode.ConfigurationTarget.Global);
        break;
      }
      case "extras":
        break;
      default:
        log.debug("unhandled webview command", { cmd, surface });
        break;
    }
  }

  // ------------------------------------------------------------------ pages

  private setPage(page: PageView): void {
    const previous = this.currentPage;
    if (!this.navigatingBack && !this.followingSong && previous && !previous.loading && pageKey(previous) !== pageKey(page)) {
      this.pageHistory.push(previous);
      if (this.pageHistory.length > 50) this.pageHistory.shift();
    }
    this.currentPage = page;
    this.mainPanel.post({ type: "page", page });
  }

  private async goBack(): Promise<void> {
    const previous = this.pageHistory.pop();
    if (!previous) {
      this.toast("没有可返回的页面");
      return;
    }
    this.navigatingBack = true;
    try {
      this.currentPage = previous;
      this.mainPanel.createOrShow();
      this.mainPanel.post({ type: "page", page: previous });
      this.activeNav = navForPage(previous);
      this.pushSidebar();
    } finally {
      this.navigatingBack = false;
    }
  }

  private async openMain(): Promise<void> {
    this.mainPanel.createOrShow();
    if (this.currentPage.loading || !this.currentPage.kind) await this.openRecommend();
  }

  private async openRecommend(): Promise<void> {
    this.activeNav = "recommend";
    this.pushSidebar();
    this.setPage({ kind: "recommend", title: "推荐", loading: true });
    this.mainPanel.createOrShow();
    const [personalized, newSongs, dailySongs, toplists, radios, roamSongs, followedArtists] =
      await Promise.all([
        this.session.client.personalizedPlaylists(12).catch(() => []),
        this.session.client.newSongs(12).catch(() => []),
        this.session.client.dailySongs(30).catch(() => []),
        this.session.client.toplists().catch(() => []),
        this.session.client.djRadios(8).catch(() => []),
        this.session.client.roamSongs().catch(() => []),
        this.session.client.followedArtists(20).catch(() => []),
      ]);
    const home: HomeFeed = {
      personalized: personalized as PlaylistRef[],
      newSongs,
      dailySongs,
      toplists: toplists as Toplist[],
      radios: radios as DjRadio[],
      roamSongs: roamSongs as Track[],
      followedArtists: followedArtists as ArtistRef[],
    };
    if (this.activeNav !== "recommend") return;
    this.setPage({ kind: "recommend", title: "推荐", home });
    this.localCount = this.localTracks.length;
  }

  private async openFeatured(): Promise<void> {
    this.activeNav = "featured";
    this.pushSidebar();
    this.setPage({ kind: "featured", title: "精选", loading: true });
    this.mainPanel.createOrShow();
    const [toplists, personalized] = await Promise.all([
      this.session.client.toplists().catch(() => []),
      this.session.client.personalizedPlaylists(18).catch(() => []),
    ]);
    if (this.activeNav !== "featured") return;
    this.setPage({
      kind: "featured",
      title: "精选",
      home: {
        personalized: personalized as PlaylistRef[],
        newSongs: [],
        dailySongs: [],
        toplists: toplists as Toplist[],
        radios: [],
        roamSongs: [],
        followedArtists: [],
      },
    });
  }

  private async openPodcast(): Promise<void> {
    this.activeNav = "podcast";
    this.pushSidebar();
    this.setPage({ kind: "podcast", title: "播客", loading: true });
    this.mainPanel.createOrShow();
    const radios = await this.session.client.djRadios(30).catch(() => []);
    if (this.activeNav !== "podcast") return;
    this.setPage({
      kind: "podcast",
      title: "播客",
      home: {
        personalized: [],
        newSongs: [],
        dailySongs: [],
        toplists: [],
        radios: radios as DjRadio[],
        roamSongs: [],
        followedArtists: [],
      },
    });
  }

  private async openRadio(radio: DjRadio): Promise<void> {
    this.activeNav = "podcast";
    this.pushSidebar();
    this.setPage({ kind: "radioDetail", title: radio.name, loading: true, radio });
    this.mainPanel.createOrShow();
    const programs = await this.session.client.radioPrograms(radio.id).catch(() => []);
    this.setPage({ kind: "radioDetail", title: radio.name, radio, radioPrograms: programs });
  }

  private async openRoam(): Promise<void> {
    this.activeNav = "roam";
    this.pushSidebar();
    this.setPage({ kind: "roam", title: "漫游", loading: true });
    this.mainPanel.createOrShow();
    const tracks = await this.session.client.roamSongs().catch(() => []);
    if (this.activeNav !== "roam") return;
    this.setPage({ kind: "roam", title: "漫游", roam: tracks });
  }

  private async openFollowing(): Promise<void> {
    this.activeNav = "following";
    this.pushSidebar();
    this.setPage({ kind: "following", title: "关注", loading: true });
    this.mainPanel.createOrShow();
    const artists = await this.session.client.followedArtists(100, 0).catch(() => []);
    if (this.activeNav !== "following") return;
    this.setPage({ kind: "following", title: "关注", following: artists });
  }

  private async openFriends(): Promise<void> {
    if (this.friendPoll) clearInterval(this.friendPoll);
    this.friendPoll = undefined;
    this.activeNav = "friends";
    this.pushSidebar();
    this.setPage({ kind: "friends", title: "好友", loading: true, friends: { friends: [], messages: [] } });
    this.mainPanel.createOrShow();
    const [conversations, follows] = await Promise.all([
      this.session.client.privateConversations(100).catch(() => []),
      this.session.client.friends(100).catch(() => []),
    ]);
    if (this.activeNav !== "friends") return;
    const order = new Map(conversations.map((friend, index) => [friend.userId, index]));
    const list = [...follows].sort((a, b) => (order.get(a.userId) ?? 9999) - (order.get(b.userId) ?? 9999));
    this.setPage({ kind: "friends", title: "好友", friends: { friends: list, messages: [] } });
  }

  private async openFriendChat(userId: number): Promise<void> {
    const page = this.currentPage;
    if (page.kind !== "friends" || !page.friends || !userId) return;
    const friend = page.friends.friends.find((item) => item.userId === userId);
    if (!friend) return;
    this.setPage({
      ...page,
      friends: { ...page.friends, activeId: userId, messages: [], loading: true, error: undefined },
    });
    try {
      const messages = await this.session.client.privateHistory(userId, 100);
      this.setPage({
        ...this.currentPage,
        friends: { ...(this.currentPage.friends ?? page.friends), activeId: userId, messages, loading: false },
      });
      this.scheduleFriendPoll(userId);
    } catch (err) {
      this.setPage({
        ...this.currentPage,
        friends: { ...(this.currentPage.friends ?? page.friends), activeId: userId, loading: false, error: (err as Error).message },
      });
    }
  }

  private scheduleFriendPoll(userId: number): void {
    if (this.friendPoll) clearInterval(this.friendPoll);
    this.friendPoll = setInterval(async () => {
      const page = this.currentPage;
      if (page.kind !== "friends" || page.friends?.activeId !== userId || page.friends.loading) return;
      try {
        const messages = await this.session.client.privateHistory(userId, 100);
        if (this.currentPage.kind !== "friends" || this.currentPage.friends?.activeId !== userId) return;
        const current = this.currentPage;
        this.currentPage = {
          ...current,
          friends: { ...(current.friends ?? page.friends!), messages },
        };
        this.mainPanel.post({ type: "friendMessages", activeId: userId, messages });
      } catch {
        /* keep existing messages */
      }
    }, 2000);
  }

  private async sendFriendMessage(content: string): Promise<void> {
    const page = this.currentPage;
    const activeId = page.kind === "friends" ? page.friends?.activeId : undefined;
    const text = content.trim();
    if (!activeId || !text) return;
    try {
      await this.session.client.sendPrivateMessage(activeId, text);
      await this.openFriendChat(activeId);
    } catch (err) {
      this.toast(`发送私信失败：${(err as Error).message}`, "error");
    }
  }

  private async openRecent(): Promise<void> {
    this.activeNav = "recent";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({ kind: "recent", title: "最近播放", recent: this.player.getRecent() });
  }

  private async openCollections(): Promise<void> {
    this.activeNav = "collections";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    const collections = this.userPlaylists
      .filter((playlist) => playlist.specialType !== 5 && playlist.subscribed)
      .map((playlist) => this.toPlaylistRef(playlist));
    this.setPage({ kind: "collections", title: "我的收藏", collections });
  }

  private async openDownloads(): Promise<void> {
    this.activeNav = "downloads";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({ kind: "downloads", title: "下载管理" });
    this.broadcast({ type: "downloads", tasks: this.downloads.toViews() });
  }

  private async openLocal(): Promise<void> {
    this.activeNav = "local";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({ kind: "local", title: "本地音乐", loading: true });
    this.localTracks = await this.scanLocalMusic();
    this.localCount = this.localTracks.length;
    this.pushSidebar();
    this.setPage({ kind: "local", title: "本地音乐", local: this.localTracks });
  }

  private async openCloud(): Promise<void> {
    this.activeNav = "cloud";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({ kind: "cloud", title: "我的音乐网盘", loading: true });
    this.cloudTracks = await this.session.client.cloudSongs(100, 0).catch(() => []);
    this.pushSidebar();
    this.setPage({ kind: "cloud", title: "我的音乐网盘", cloud: this.cloudTracks });
  }

  private async openLiked(): Promise<void> {
    const liked = this.userPlaylists.find((playlist) => playlist.specialType === 5);
    if (!liked) {
      await this.openLogin();
      return;
    }
    await this.openPlaylist(liked.id);
  }

  private async openPlaylist(id: number): Promise<void> {
    if (!Number.isFinite(id) || id <= 0) throw new Error("无效的歌单 ID");
    const liked = this.userPlaylists.find((playlist) => playlist.specialType === 5);
    const cached = this.playlistCache.get(id);
    if (cached) {
      this.activePlaylist = cached;
      this.activeNav = liked?.id === id ? "liked" : `playlist:${id}`;
      this.pushSidebar();
      this.mainPanel.createOrShow();
      this.commentsTarget = { resource: commentResource("playlist", id), id, kind: "playlist" };
      this.commentsView = undefined;
      this.subscribersView = undefined;
      this.setPage({ kind: "playlist", title: cached.playlist.name, playlist: cached, activeTab: "songs" });
      return;
    }
    this.activeNav = liked?.id === id ? "liked" : `playlist:${id}`;
    this.pushSidebar();
    this.setPage({ kind: "playlist", title: "正在加载…", loading: true });
    this.mainPanel.createOrShow();
    let detail: PlaylistDetail;
    try {
      detail = await this.session.client.playlistDetail(id);
    } catch (err) {
      this.setPage({ kind: "playlist", title: "歌单加载失败", loading: false, error: (err as Error).message });
      throw err;
    }
    this.activePlaylist = detail;
    this.playlistCache.set(id, detail);
    if (this.playlistCache.size > 3) {
      const oldest = this.playlistCache.keys().next().value;
      if (oldest !== undefined) this.playlistCache.delete(oldest);
    }
    if (detail.playlist.specialType === 5 || liked?.id === id) {
      this.player.markLiked(detail.tracks.map((track) => track.id));
    }
    this.activeNav = liked?.id === id ? "liked" : `playlist:${id}`;
    this.pushSidebar();
    this.commentsTarget = { resource: commentResource("playlist", id), id, kind: "playlist" };
    this.commentsView = undefined;
    this.subscribersView = undefined;
    this.setPage({
      kind: "playlist",
      title: detail.playlist.name,
      playlist: detail,
      activeTab: "songs",
    });
  }

  private async ensurePlaylist(id: number): Promise<PlaylistDetail | null> {
    if (this.activePlaylist?.playlist.id === id && this.activePlaylist.tracks.length) return this.activePlaylist;
    const detail = await this.session.client.playlistDetail(id);
    this.activePlaylist = detail;
    return detail;
  }

  private async openSongDetail(id: number): Promise<void> {
    let track =
      this.player.getQueue().find((item) => item.id === id) ??
      this.player.getRecent().find((item) => item.id === id) ??
      (this.player.current?.id === id ? this.player.current : undefined) ??
      (() => {
        const local = this.localTracks.find((item) => item.id === id);
        return local ? this.localTrackViewToTrack(local) : undefined;
      })();
    if (!track && id > 0) {
      const songs = await this.session.client.songDetail([id]);
      track = songs[0];
    }
    if (!track) throw new Error("歌曲不存在或不可用");
    this.activeNav = "song";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({
      kind: "song",
      title: track.name,
      loading: false,
      song: { track, lyric: { lrc: "", translation: "" }, composerNames: [] },
    });
    const lyricPromise = !track.localPath && id > 0
      ? this.session.client.lyric(id).catch((err) => {
          log.debug("song lyric unavailable", String(err));
          return { lrc: "", translation: "" };
        })
      : Promise.resolve({ lrc: "", translation: "" });
    if (id > 0) {
      const likedCount = await this.session.client.songRedCount(id).catch(() => 0);
      if (likedCount > 0) track = { ...track, likedCount };
    }
    this.activeNav = "song";
    this.pushSidebar();
    this.mainPanel.createOrShow();

    if (track.localPath) {
      this.commentsTarget = id > 0 ? { resource: commentResource("song", id), id, kind: "song" } : undefined;
      this.commentsView = undefined;
      this.setPage({
        kind: "song",
        title: track.name,
        song: { track, lyric: { lrc: "", translation: "" }, composerNames: [] },
      });
      if (id > 0) {
        await this.openComments({ resource: commentResource("song", id), id, offset: 0 }).catch((err) => {
          const view: CommentsView = {
            total: 0,
            hot: [],
            comments: [],
            loading: false,
            more: false,
            offset: 0,
            error: `当前无网络，评论区不可见（${(err as Error).message}）`,
          };
          this.commentsView = view;
          this.mainPanel.post({ type: "comments", view });
        });
      }
      return;
    }

    if (id <= 0) throw new Error("无效的歌曲 ID");
    this.setPage({
      kind: "song",
      title: track.name,
      loading: true,
      song: { track, lyric: { lrc: "", translation: "" }, composerNames: [] },
    });
    const lyric = await lyricPromise;
    const composerNames = parseComposers(lyric.lrc);
    this.commentsTarget = { resource: commentResource("song", id), id, kind: "song" };
    this.commentsView = undefined;
    this.setPage({
      kind: "song",
      title: track.name,
      song: { track, lyric, composerNames },
    });
    await this.openComments({ resource: commentResource("song", id), id, offset: 0 }).catch((err) => {
      const view: CommentsView = {
        total: 0,
        hot: [],
        comments: [],
        loading: false,
        more: false,
        offset: 0,
        error: `评论区加载失败：${(err as Error).message}`,
      };
      this.commentsView = view;
      this.mainPanel.post({ type: "comments", view });
    });
  }

  private async openFavorite(trackId: number, toggle = false): Promise<void> {
    if (!trackId) throw new Error("无效的歌曲 ID");
    if (trackId < 0) throw new Error("本地音乐没有关联的网易云歌曲，无法收藏到歌单");
    if (!this.session.loggedIn) {
      await this.openLogin();
      return;
    }
    if (!this.userPlaylists.length) await this.refreshUserPlaylists();
    const playlists = this.userPlaylists
      .filter((playlist) => playlist.specialType !== 5)
      .map((playlist) => this.toPlaylistRef(playlist));
    this.mainPanel.createOrShow();
    this.mainPanel.post({ type: toggle ? "toggleFavoritePicker" : "favoritePicker", trackId, playlists });
  }

  private async addFavorite(playlistId: number, trackId: number): Promise<void> {
    if (!playlistId || !trackId) throw new Error("请选择歌单");
    this.playlistCache.delete(playlistId);
    await this.session.client.addTrackToPlaylist(playlistId, trackId);
    this.toast("已收藏到歌单", "success");
    this.mainPanel.post({ type: "toast", kind: "success", message: "已收藏到歌单" });
    void this.refreshUserPlaylists().catch(() => undefined);
  }

  private async openUser(uid: number): Promise<void> {    if (!Number.isFinite(uid) || uid <= 0) throw new Error("无效的用户 ID");
    this.activeNav = "user";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({ kind: "user", title: "用户主页", loading: true });
    let detail: { user: UserPage["user"]; playlists: UserPlaylist[] };
    try {
      detail = await this.session.client.userDetail(uid);
    } catch (err) {
      this.setPage({ kind: "user", title: "用户主页加载失败", error: (err as Error).message });
      throw err;
    }
    const user: UserPage = {
      user: detail.user,
      playlists: detail.playlists.map((playlist) => this.toPlaylistRef(playlist)),
      isSelf: uid === this.session.accountInfo?.userId,
    };
    this.activeNav = user.isSelf ? "me" : "user";
    this.pushSidebar();
    this.setPage({ kind: "user", title: detail.user.nickname, user });
  }

  private async openMyProfile(): Promise<void> {
    const account = this.session.accountInfo;
    if (!account) {
      await this.openLogin();
      return;
    }
    await this.openUser(account.userId);
  }

  private async openArtistByName(name: string): Promise<void> {
    const artists = await this.session.client.searchArtists(name, 5);
    if (!artists.length) throw new Error(`没有找到歌手：${name}`);
    if (artists.length === 1) {
      await this.openArtist(artists[0].id);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      artists.map((artist) => ({ label: artist.name, id: artist.id })),
      { placeHolder: `选择「${name}」对应的歌手` },
    );
    if (picked) await this.openArtist(picked.id);
  }

  private async postSongComment(id: number, content: string): Promise<void> {
    const text = content.trim();
    if (!text) throw new Error("评论内容不能为空");
    await this.session.client.addComment(commentResource("song", id), text);
    this.toast("评论已发送", "success");
    await this.openComments({ resource: commentResource("song", id), id, offset: 0 });
  }

  private async fixSampleRate(): Promise<void> {
    await vscode.workspace
      .getConfiguration("neteaseMusic")
      .update("output.sampleRate", "auto", vscode.ConfigurationTarget.Global);
    this.pushSettings();
    this.toast("已把输出采样率改为 auto（跟随音源）", "success");
    if (this.player.isPlaying) await this.player.restartCurrent();
  }

  private async openAlbum(id: number): Promise<void> {
    this.activeNav = "album";
    this.pushSidebar();
    this.setPage({ kind: "album", title: "正在加载…", loading: true });
    this.mainPanel.createOrShow();
    let album: AlbumDetail;
    try {
      album = await this.session.client.albumDetail(id);
    } catch (err) {
      this.setPage({ kind: "album", title: "专辑加载失败", loading: false, error: (err as Error).message });
      throw err;
    }
    this.commentsTarget = { resource: commentResource("album", id), id, kind: "album" };
    this.setPage({ kind: "album", title: album.name, album });
  }

  private async openArtistSongs(id: number, name: string): Promise<void> {
    this.activeNav = "artist";
    this.pushSidebar();
    this.setPage({ kind: "artistSongs", title: `${name} · 全部歌曲`, loading: true });
    this.mainPanel.createOrShow();
    const [songs, artist] = await Promise.all([
      this.session.client.artistSongs(id, 100, 0).catch(() => []),
      this.session.client.artistDetail(id).catch(() => null),
    ]);
    const list = songs.length ? songs : artist?.songs ?? [];
    const total = artist?.musicSize ?? list.length;
    this.setPage({
      kind: "artistSongs",
      title: `${name} · 全部歌曲`,
      artist: artist ?? undefined,
      artistAll: list,
      artistAllOffset: list.length,
      artistAllTotal: total,
      artistAllHasMore: list.length < total,
    });
  }

  private async loadMoreArtistSongs(): Promise<void> {
    const page = this.currentPage;
    if (page.kind !== "artistSongs" || page.loading || page.artistAllLoading || page.artistAllHasMore === false) return;
    const artist = page.artist;
    if (!artist) return;
    page.artistAllLoading = true;
    this.setPage(page);
    const offset = page.artistAllOffset ?? page.artistAll?.length ?? 0;
    const more = await this.session.client.artistSongs(artist.id, 100, offset).catch(() => []);
    const existing = new Set((page.artistAll ?? []).map((track) => track.id));
    const before = page.artistAll?.length ?? 0;
    const next = [...(page.artistAll ?? []), ...more.filter((track) => !existing.has(track.id))];
    this.setPage({
      ...page,
      artistAll: next,
      artistAllOffset: offset + more.length,
      artistAllTotal: page.artistAllTotal ?? artist.musicSize,
      artistAllHasMore: more.length > 0 && next.length > before && next.length < (page.artistAllTotal ?? artist.musicSize),
      artistAllLoading: false,
    });
  }

  private async openArtist(id: number): Promise<void> {    this.activeNav = "artist";
    this.pushSidebar();
    this.setPage({ kind: "artist", title: "正在加载…", loading: true });
    this.mainPanel.createOrShow();
    let artist: ArtistDetail;
    try {
      const [detail, albums, similar] = await Promise.all([
        this.session.client.artistDetail(id),
        this.session.client.artistAlbums(id).catch(() => []),
        this.session.client.similarArtists(id).catch(() => []),
      ]);
      artist = { ...detail, albums, similar };
    } catch (err) {
      this.setPage({ kind: "artist", title: "歌手加载失败", loading: false, error: (err as Error).message });
      throw err;
    }
    this.commentsTarget = { resource: commentResource("artist", id), id, kind: "artist" };
    this.setPage({ kind: "artist", title: artist.name, artist });
  }

  private async openSearch(query: string, kind: SearchKind): Promise<void> {
    if (!query.trim()) throw new Error("请输入搜索关键词");
    this.activeNav = "search";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({
      kind: "search",
      title: `搜索：${query}`,
      search: { query, kind, songs: [], playlists: [], loading: true },
    });
    try {
      const result = await this.session.client.search(query, kind, 50, 0);
      this.setPage({
        kind: "search",
        title: `搜索：${query}`,
        search: {
          query,
          kind,
          songs: result.songs,
          playlists: result.playlists,
          albums: result.albums,
          artists: result.artists,
          users: result.users,
          lyrics: result.lyrics,
          radios: result.radios,
          loading: false,
          total:
            kind === "song"
              ? result.songCount
              : kind === "playlist"
                ? result.playlistCount
                : (result.albums?.length ?? 0) +
                  (result.artists?.length ?? 0) +
                  (result.users?.length ?? 0) +
                  (result.lyrics?.length ?? 0) +
                  (result.radios?.length ?? 0),
        },
      });
    } catch (err) {
      this.setPage({
        kind: "search",
        title: `搜索：${query}`,
        search: { query, kind, songs: [], playlists: [], loading: false, error: (err as Error).message },
      });
      throw err;
    }
  }

  private async openNow(): Promise<void> {
    if (this.player.current) {
      await this.openSongDetail(this.player.current.id);
      return;
    }
    this.activeNav = "now";
    this.pushSidebar();
    this.mainPanel.createOrShow();
    this.setPage({ kind: "now", title: "正在播放" });
  }

  private openQueue(): void {
    this.mainPanel.createOrShow();
    this.mainPanel.post({ type: "queuePopup", open: true });
    this.pendingQueuePopup = !this.mainPanel.isReady;
    this.broadcast({ type: "queue", tracks: this.player.getQueue(), index: this.player.state().index });
  }

  private async setPageTab(tab: string): Promise<void> {
    const page = this.currentPage;
    page.activeTab = tab === "comments" ? "comments" : tab === "subscribers" ? "subscribers" : "songs";
    this.setPage(page);
    if (page.activeTab === "comments" && this.commentsTarget) {
      await this.openComments({ resource: this.commentsTarget.resource, id: this.commentsTarget.id, offset: 0 });
    } else if (page.activeTab === "subscribers" && page.playlist) {
      await this.openSubscribers(page.playlist.playlist.id);
    }
  }

  private async openComments(payload: { resource?: string; id?: number; offset?: number }): Promise<void> {
    const resource = String(payload.resource ?? this.commentsTarget?.resource ?? "");
    const id = Number(payload.id ?? this.commentsTarget?.id ?? 0);
    if (!resource || !id) return;
    const offset = Math.max(0, Number(payload.offset ?? 0));
    if (!offset) {
      this.commentsView = undefined;
      this.mainPanel.post({
        type: "comments",
        view: { total: 0, hot: [], comments: [], loading: true, more: false, offset: 0 },
      });
    }
    let result: { comments: Comment[]; hot: Comment[]; total: number };
    try {
      result = await Promise.race([
        this.session.client.comments(resource, id, 30, offset),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("评论请求超时")), 12000)),
      ]);
    } catch (err) {
      const view: CommentsView = {
        total: 0,
        hot: [],
        comments: [],
        loading: false,
        more: false,
        offset: 0,
        error: `评论区加载失败：${(err as Error).message}`,
      };
      this.commentsView = view;
      this.mainPanel.post({ type: "comments", view });
      return;
    }
    this.commentsOffset = offset;
    const previous = offset && this.commentsView ? this.commentsView : undefined;
    const view: CommentsView = {
      total: result.total,
      hot: previous ? previous.hot : result.hot,
      comments: previous ? [...previous.comments, ...result.comments] : result.comments,
      loading: false,
      more: offset + result.comments.length < result.total,
      offset: 0,
    };
    this.commentsView = view;
    this.mainPanel.post({ type: "comments", view });
  }

  private async openSubscribers(id: number, offset = 0): Promise<void> {
    if (!offset) {
      this.subscribersView = undefined;
      this.mainPanel.post({
        type: "subscribers",
        view: { total: 0, subscribers: [], loading: true, more: false, offset: 0 },
      });
    }
    const result = await this.session.client.subscribers(id, 30, offset);
    this.subscribersOffset = offset;
    const previous = offset && this.subscribersView ? this.subscribersView : undefined;
    const view: SubscribersView = {
      total: result.total,
      subscribers: previous ? [...previous.subscribers, ...result.subscribers] : result.subscribers,
      loading: false,
      more: offset + result.subscribers.length < result.total,
      offset: 0,
    };
    this.subscribersView = view;
    this.mainPanel.post({ type: "subscribers", view });
  }

  private async refreshCurrentPage(): Promise<void> {
    switch (this.currentPage.kind) {
      case "playlist":
        if (this.currentPage.playlist) await this.openPlaylist(this.currentPage.playlist.playlist.id);
        break;
      case "song":
        if (this.currentPage.song) await this.openSongDetail(this.currentPage.song.track.id);
        break;
      case "user":
        if (this.currentPage.user) await this.openUser(this.currentPage.user.user.userId);
        break;
      case "album":
        if (this.currentPage.album) await this.openAlbum(this.currentPage.album.id);
        break;
      case "artist":
        if (this.currentPage.artist) await this.openArtist(this.currentPage.artist.id);
        break;
      case "search":
        if (this.currentPage.search) {
          await this.openSearch(this.currentPage.search.query, this.currentPage.search.kind);
        }
        break;
      case "featured":
        await this.openFeatured();
        break;
      case "podcast":
        await this.openPodcast();
        break;
      case "roam":
        await this.openRoam();
        break;
      case "following":
        await this.openFollowing();
        break;
      case "recent":
        await this.openRecent();
        break;
      case "collections":
        await this.openCollections();
        break;
      case "downloads":
        await this.openDownloads();
        break;
      case "local":
        await this.openLocal();
        break;
      case "cloud":
        await this.openCloud();
        break;
      case "queue":
        this.openQueue();
        break;
      case "now":
        this.setPage({ kind: "now", title: "正在播放" });
        break;
      default:
        await this.openRecommend();
        break;
    }
  }

  // ---------------------------------------------------------------- quality

  private async setPlaybackQuality(quality: Quality): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("neteaseMusic");
    const wasActive = this.player.isPlaying || this.player.state().loading;
    await this.player.releaseNativeOutput();
    const hadHrtf = configuration.get<boolean>("output.hrtf") ?? false;
    if (quality === "sky") {
      await configuration.update("output.bitPerfect", false, vscode.ConfigurationTarget.Global);
      await configuration.update("output.hrtf", true, vscode.ConfigurationTarget.Global);
    } else {
      await configuration.update("output.hrtf", false, vscode.ConfigurationTarget.Global);
    }
    await this.player.refreshOutput();
    await this.player.setQuality(quality, wasActive);
    this.toast(`音质请求已切换为：${QUALITY_LABELS[quality] ?? quality}`, "success");
    if (quality === "sky") {
      this.toast("沉浸环绕声：已关闭 Bit-perfect，已开启双声道空间增强（HRTF）。", "info");
    } else if (hadHrtf) {
      this.toast("已关闭双声道空间增强（HRTF）；Bit-perfect 不会自动开启。", "info");
    }
    this.pushSettings();
    this.updateStatus();
  }

  private parseListenInvite(input: string): { roomId: string; inviterId: string } {
    const text = decodeURIComponent(input.trim());
    const room = /(?:roomId|room_id|roomid)["'=:\s]+([A-Za-z0-9_-]+)/i.exec(text);
    const inviter = /(?:inviterId|inviter_id|inviter)["'=:\s]+(\d+)/i.exec(text);
    if (room?.[1] && inviter?.[1]) return { roomId: room[1], inviterId: inviter[1] };
    const numbers = text.match(/\d{5,}/g) ?? [];
    if (numbers.length >= 2) return { roomId: numbers[0]!, inviterId: numbers[1]! };
    throw new Error("无法解析房间信息：请粘贴官方邀请链接，或 roomId + inviterId");
  }

  private async joinListenTogether(input: string): Promise<void> {
    if (!this.session.loggedIn) {
      this.toast("请先登录网易云音乐", "error");
      return;
    }
    try {
      const { roomId, inviterId } = this.parseListenInvite(input);
      this.listen = { status: "joining", roomId, inviterId, message: "正在接受邀请…" };
      this.pushSidebar();
      await this.session.client.acceptListenTogether(roomId, inviterId);
      this.listenRoomId = roomId;
      await this.refreshListenRoom();
      this.scheduleListenPoll();
      this.toast("已加入一起听房间", "success");
    } catch (err) {
      this.listen = { ...this.listen, status: "error", message: (err as Error).message };
      this.pushSidebar();
      this.toast(`加入一起听失败：${(err as Error).message}`, "error");
    }
  }

  private async refreshListenRoom(): Promise<void> {
    if (!this.listenRoomId) return;
    const room = await this.session.client.listenTogetherRoom(this.listenRoomId);
    const command = room.playCommand ?? {};
    const trackId = Number(command.targetSongId ?? 0);
    this.listenCommand = {
      targetSongId: Number(command.targetSongId ?? 0),
      formerSongId: Number(command.formerSongId ?? command.targetSongId ?? 0),
      clientSeq: Number(command.clientSeq ?? 0),
    };
    this.listenList = (room.playlist?.displayList?.result ?? [])
      .map((item) => Number(typeof item === "object" ? item.songId : item))
      .filter((id) => Number.isFinite(id) && id > 0);
    this.listenVersions = (room.playlist?.version ?? []).map((item) => ({ userId: Number(item.userId), version: Number(item.version) }));
    this.listenPlayMode = String(room.playlist?.playMode ?? "ORDER_LOOP");
    const listKey = this.listenList.join(",");
    if (listKey && listKey !== this.listenListKey) {
      this.listenListKey = listKey;
      try {
        this.listenQueue = await this.session.client.songDetail(this.listenList);
      } catch {
        this.listenQueue = [];
      }
    }

    let trackName = "";
    let artists = "";
    let track = this.listenTrack?.id === trackId ? this.listenTrack : undefined;
    if (trackId && !track) {
      try {
        track = (await this.session.client.songDetail([trackId]))[0];
        this.listenTrack = track;
      } catch {
        /* metadata is optional */
      }
    }
    if (track) {
      trackName = track.name;
      artists = track.artists?.map((artist) => artist.name).join(" / ") ?? "";
    }
    const baseProgress = Number(command.progress ?? 0) / 1000;
    const rawStatus = command.playStatus;
    const playing =
      rawStatus === 2 ||
      String(rawStatus ?? "") === "2" ||
      String(rawStatus ?? "").toUpperCase().startsWith("PLAY");
    const now = Date.now();
    const rawProgressChanged = Boolean(
      this.listenLastProgress !== undefined &&
      Math.abs(baseProgress - this.listenLastProgress) > 1.5,
    );
    this.listenLastProgress = baseProgress;
    if (
      !this.listenBase ||
      this.listenBase.trackId !== trackId ||
      this.listenBase.playing !== playing ||
      rawProgressChanged
    ) {
      if (rawProgressChanged) this.listenForceSeek = true;
      this.listenBase = { trackId, progress: baseProgress, at: now, playing };
    }
    const target = baseProgress + (playing ? (now - this.listenBase.at) / 1000 : 0);
    if (track) await this.syncListenPlayback(track, target, playing);
    this.listen = {
      status: "connected",
      roomId: this.listenRoomId,
      inviterId: this.listen.inviterId,
      trackId: trackId || undefined,
      trackName: trackName || (trackId ? `歌曲 ${trackId}` : undefined),
      artists,
      position: target,
      playing,
      message: "手机端需保持一起听页面活跃",
    };
    this.pushSidebar();
  }

  private async playInListenRoom(track: Track): Promise<boolean> {
    if (this.listen.status !== "connected" || !this.listenRoomId) return false;
    try {
      if (!this.listenList.includes(track.id)) {
        const userId = Number(this.session.accountInfo?.userId ?? 0);
        const versions = this.listenVersions.map((item) => ({ ...item }));
        const mine = versions.find((item) => item.userId === userId);
        if (mine) mine.version += 1;
        else versions.push({ userId, version: 1 });
        const anchorSong = this.listenCommand?.targetSongId ?? track.id;
        const anchorIndex = Math.max(0, this.listenList.indexOf(anchorSong));
        const display = [...this.listenList.map(String)];
        if (!display.includes(String(track.id))) display.push(String(track.id));
        await this.session.client.listenTogetherListCommand(this.listenRoomId, {
          commandType: "ADD",
          version: versions,
          anchorSongId: "",
          anchorPosition: -1,
          randomList: display,
          displayList: display,
        });
        this.listenVersions = versions;
        this.listenList = [...this.listenList, track.id];
        this.listenQueue = [...this.listenQueue, track];
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!(await this.sendListenPlayCommand("GOTO", track.id))) return false;
      const queue = this.listenQueue.length ? this.listenQueue : [track];
      const index = Math.max(0, queue.findIndex((item) => item.id === track.id));
      await this.player.playTrack(track, queue, index);
      return true;
    } catch (err) {
      this.toast(`一起听选歌失败：${(err as Error).message}`, "error");
      return false;
    }
  }

  private async sendListenPlayCommand(commandType: "PLAY" | "PAUSE" | "GOTO" | "PROGRESS", targetSongId?: number, positionMs?: number): Promise<boolean> {
    if (this.listen.status !== "connected" || !this.listenRoomId) return false;
    const previous = this.listenCommand;
    const target = targetSongId ?? previous?.targetSongId ?? this.player.current?.id ?? 0;
    if (!target) return false;
    const former = previous?.formerSongId || target;
    const clientSeq = (previous?.clientSeq ?? 0) + 1;
    const base = {
      commandType,
      progress: commandType === "GOTO" ? 0 : Math.round(positionMs ?? this.player.state().position * 1000),
      formerSongId: String(former),
      targetSongId: String(target),
      clientSeq,
    };
    const payloads = commandType === "GOTO"
      ? [{ ...base, playStatus: 2 }, { ...base, playStatus: "PLAY" }]
      : [
          { ...base, playStatus: commandType === "PAUSE" ? 1 : 2 },
          { ...base, playStatus: commandType === "PAUSE" ? "PAUSE" : "PLAY" },
        ];
    let lastError: unknown;
    for (const command of payloads) {
      try {
        await this.session.client.listenTogetherPlayCommand(this.listenRoomId, command);
        this.listenCommand = { targetSongId: target, formerSongId: former, clientSeq };
        return true;
      } catch (err) {
        lastError = err;
      }
    }
    this.toast(`一起听控制失败：${(lastError as Error)?.message ?? "未知错误"}`, "error");
    return false;
  }

  private async localListenControl(action: "toggle" | "next" | "previous"): Promise<boolean> {
    if (this.listen.status !== "connected") return false;
    if (action === "toggle") {
      const playing = this.player.state().playing;
      const sent = await this.sendListenPlayCommand(playing ? "PAUSE" : "PLAY");
      if (sent) {
        if (playing) await this.player.pause();
        else await this.player.resume();
      }
      return sent;
    }
    const current = this.listenCommand?.targetSongId ?? this.player.current?.id ?? 0;
    if (!current || !this.listenList.length) return false;
    const index = this.listenList.indexOf(current);
    if (index < 0) return false;
    const next = action === "next"
      ? (index + 1) % this.listenList.length
      : (index - 1 + this.listenList.length) % this.listenList.length;
    return this.sendListenPlayCommand("GOTO", this.listenList[next]);
  }

  private async syncListenPlayback(track: Track, target: number, playing: boolean): Promise<void> {
    const current = this.player.current;
    if (!current || current.id !== track.id) {
      const queue = this.listenQueue.length ? this.listenQueue : [track];
      const index = Math.max(0, queue.findIndex((item) => item.id === track.id));
      await this.player.playTrack(track, queue, index);
      if (!playing) await this.player.pause();
      if (target > 0.5) await this.player.seek(target);
      return;
    }
    if (playing && !this.player.isPlaying) await this.player.resume();
    if (!playing && this.player.isPlaying) await this.player.pause();
    const state = this.player.state();
    if (!state.loading && (this.listenForceSeek || Math.abs(state.position - target) > 1.5)) {
      log.info("listen seek", { target, local: state.position, force: this.listenForceSeek });
      this.listenForceSeek = false;
      await this.player.seek(target);
    }
  }

  private scheduleListenPoll(): void {
    if (this.listenPoll) clearTimeout(this.listenPoll);
    if (this.listen.status !== "connected") return;
    this.listenPoll = setTimeout(async () => {
      try {
        await this.refreshListenRoom();
      } catch (err) {
        this.listen = { ...this.listen, message: `同步中断：${(err as Error).message}` };
        this.pushSidebar();
      }
      this.scheduleListenPoll();
    }, 1000);
  }

  private leaveListenTogether(): void {
    if (this.listenPoll) clearTimeout(this.listenPoll);
    this.listenPoll = undefined;
    this.listenRoomId = "";
    this.listenTrack = undefined;
    this.listenBase = undefined;
    this.listenQueue = [];
    this.listenListKey = "";
    this.listenList = [];
    this.listenVersions = [];
    this.listen = { status: "idle" };
    this.pushSidebar();
  }

  private async setDownloadQuality(quality: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("neteaseMusic")
      .update("download.quality", quality, vscode.ConfigurationTarget.Global);
    this.pushSettings();
    this.toast(`下载音质已设为：${quality === "auto" ? "跟随播放音质" : QUALITY_LABELS[quality] ?? quality}`, "success");
  }

  // -------------------------------------------------------------- user data

  private async createPlaylist(): Promise<void> {
    if (!this.session.loggedIn) throw new Error("请先登录");
    const name = await vscode.window.showInputBox({ prompt: "新建歌单名称", placeHolder: "歌单名称" });
    if (!name?.trim()) return;
    const id = await this.session.client.createPlaylist(name.trim());
    if (id) this.playlistOrder.push(id);
    await this.savePlaylistOrder();
    await this.refreshUserPlaylists();
    this.toast(`已创建歌单：${name.trim()}`, "success");
  }

  private async deletePlaylist(id: number): Promise<void> {
    const playlist = this.userPlaylists.find((item) => item.id === id);
    if (!playlist || playlist.specialType === 5) throw new Error("我喜欢的音乐不能删除");
    const answer = await vscode.window.showWarningMessage(`删除歌单「${playlist.name}」？`, { modal: true }, "删除");
    if (answer !== "删除") return;
    await this.session.client.deletePlaylist(id);
    this.playlistOrder = this.playlistOrder.filter((item) => item !== id);
    await this.savePlaylistOrder();
    await this.refreshUserPlaylists();
    this.toast("歌单已删除", "success");
  }

  private async movePlaylist(id: number, direction: number): Promise<void> {
    const ordered = this.userPlaylists
      .filter((item) => item.specialType !== 5 && !item.subscribed)
      .sort((a, b) => {
        const ai = this.playlistOrder.indexOf(a.id);
        const bi = this.playlistOrder.indexOf(b.id);
        if (ai < 0 && bi < 0) return 0;
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      });
    const index = ordered.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    const ids = ordered.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    this.playlistOrder = ids;
    await this.savePlaylistOrder();
    this.pushSidebar();
  }

  private async savePlaylistOrder(): Promise<void> {
    await this.ctx.globalState.update(PLAYLIST_ORDER_KEY, this.playlistOrder);
  }

  private async refreshUserPlaylists(): Promise<void> {    if (!this.session.loggedIn || !this.session.accountInfo?.userId) {
      this.userPlaylists = [];
      this.playlistsLoaded = true;
      this.pushSidebar();
      return;
    }
    try {
      this.userPlaylists = await this.session.client.userPlaylists(this.session.accountInfo.userId);
      this.playlistsLoaded = true;
      const liked = this.userPlaylists.find((playlist) => playlist.specialType === 5);
      if (liked && !this.likedHydrated) {
        this.likedHydrated = true;
        void this.session.client
          .playlistDetail(liked.id)
          .then((detail) => this.player.markLiked(detail.tracks.map((track) => track.id)))
          .catch(() => undefined);
      }
    } catch (err) {
      log.warn("user playlists failed", String(err));
      if (!this.playlistsLoaded) this.userPlaylists = [];
    }
    this.pushSidebar();
  }

  // ------------------------------------------------------------------ login

  private async openLogin(): Promise<void> {
    this.settingsTab = "account";
    this.pendingLogin = true;
    await this.settingsPanel.open("account");
  }

  private async startQrLogin(): Promise<void> {
    if (this.qrTimer) clearInterval(this.qrTimer);
    const { key, qrContent } = await this.session.startQrLogin();
    const dataUrl = await QRCode.toDataURL(qrContent, { margin: 1, width: 320, errorCorrectionLevel: "M" });
    this.broadcast({ type: "qr", dataUrl, qrContent, code: 801, message: "请使用网易云音乐 App 扫码" });
    this.qrTimer = setInterval(() => void this.pollQr(key, dataUrl, qrContent), 2500);
    log.info("qr login started", { key });
  }

  private async pollQr(key: string, dataUrl: string, qrContent: string): Promise<void> {
    try {
      const state = await this.session.pollQrLogin(key);
      const messages: Record<number, string> = {
        800: "二维码已过期，请刷新",
        801: "等待扫码…",
        802: "已扫码，请在手机上确认",
        803: "登录成功",
      };
      this.broadcast({
        type: "qr",
        dataUrl,
        qrContent,
        code: state.code,
        message: state.message || messages[state.code] || "等待扫码…",
      });
      if (state.code === 803) {
        this.stopQr();
        this.afterLogin();
      } else if (state.code === 800) {
        this.stopQr();
      }
    } catch (err) {
      this.stopQr();
      this.broadcast({ type: "loginResult", ok: false, message: `扫码登录失败：${(err as Error).message}` });
    }
  }

  private stopQr(): void {
    if (this.qrTimer) clearInterval(this.qrTimer);
    this.qrTimer = undefined;
  }

  private async loginWithPhone(payload: any): Promise<void> {
    const phone = String(payload.phone ?? "").trim();
    const captcha = String(payload.captcha ?? "").trim();
    const password = String(payload.password ?? "");
    if (!phone) throw new Error("请填写手机号");
    if (!captcha && !password) throw new Error("请填写验证码或密码");
    const account: Account = await this.session.loginWithCellphone({
      phone,
      captcha: captcha || undefined,
      password: password || undefined,
    });
    this.afterLogin(account);
  }

  private async loginWithEmail(payload: any): Promise<void> {
    const username = String(payload.username ?? "").trim();
    const password = String(payload.password ?? "");
    if (!username || !password) throw new Error("请填写邮箱与密码");
    const account: Account = await this.session.loginWithEmail(username, password);
    this.afterLogin(account);
  }

  private afterLogin(account?: Account): void {
    const name = account?.nickname ?? this.session.accountInfo?.nickname ?? "";
    this.broadcast({ type: "loginResult", ok: true, message: `登录成功：${name}` });
    this.broadcast({ type: "account", account: this.session.accountInfo });
    this.toast(`欢迎，${name}`, "success");
    this.pushSidebar();
    this.pushSettings();
    void this.refreshUserPlaylists().catch(() => undefined);
    void this.openRecommend().catch(() => undefined);
    this.updateStatus();
  }

  // ------------------------------------------------------------- components

  private async ensureNative(): Promise<void> {
    const cfg = getConfig();
    if (!cfg.components.autoDownload) return;
    const result = await this.components.ensureNative();
    if (result.changed) {
      await this.pushComponents();
      await this.player.refreshOutput();
      this.toast(result.message, "success");
    }
  }

  private async installComponent(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "安装此组件目录",
      title: "选择包含 component.json 的组件目录",
    });
    if (!picked?.[0]) return;
    const record = await this.components.installFromDirectory(picked[0].fsPath);
    await this.pushComponents();
    await this.player.refreshOutput();
    this.toast(`已安装 ${record.name} ${record.version}`, "success");
  }

  private async removeComponent(id: string): Promise<void> {
    const record = await this.components.get(id);
    if (!record) throw new Error("组件不存在");
    if (!record.removable) throw new Error("该模块不可卸载" + (record.kind === "builtin" ? "，只能禁用" : ""));
    const answer = await vscode.window.showWarningMessage(
      `确定卸载「${record.name}」？二进制与配置将被删除。`,
      { modal: true },
      "卸载",
    );
    if (answer !== "卸载") return;
    await this.components.remove(id);
    await this.pushComponents();
    await this.player.refreshOutput();
    this.toast(`已卸载 ${record.name}`);
  }

  private async locateComponent(id: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "使用此二进制",
      title: "重新定位原生引擎二进制",
    });
    if (!picked?.[0]) return;
    await this.components.locate(id, picked[0].fsPath);
    await this.pushComponents();
    await this.player.refreshOutput();
    this.toast("组件路径已更新", "success");
  }

  private async openComponentDir(id: string): Promise<void> {
    const record = await this.components.get(id);
    const dir = record?.dir ?? this.components.rootDir;
    await fs.mkdir(dir, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(dir));
  }

  private async nativeStatus(): Promise<NativeStatusView> {
    const record = await this.components.nativeRecord();
    const status: NativeStatusView = {
      installed: Boolean(record),
      enabled: record?.enabled ?? false,
      ready: record?.status === "ready",
      path: record?.entryPath,
      version: record?.version,
      backend: record?.backend,
      reason: record?.reason ?? (record ? undefined : "未安装 Native Audio Output Engine"),
    };
    if (record && this.probeCache && this.probeCache.path === record.entryPath) {
      const probe = this.probeCache.probe;
      if (probe.ok) {
        status.devices = (probe.devices ?? []).map((device) => ({
          id: device.id,
          name: device.name,
          backend: device.backend,
          isDefault: device.isDefault,
          formats: device.formats.map((format) => ({
            sampleRate: format.sampleRate,
            bits: format.bits,
            channels: format.channels,
            sampleFormat: format.sampleFormat,
          })),
        }));
        status.backends = probe.backends ?? [];
        status.backend = probe.backends?.join(" / ") ?? status.backend;
        status.version = probe.version ?? status.version;
      } else {
        status.ready = false;
        status.reason = probe.error ?? "原生引擎探测失败";
      }
    }
    return status;
  }

  private restartApp(): void {
    const exe = process.execPath;
    log.info("restart app", { exe, platform: process.platform });
    try {
      // The old instance is still running when this is spawned. Wait a few
      // seconds after quitting, then launch a fresh Code process.
      if (process.platform === "win32") {
        const command = `ping -n 4 127.0.0.1 >nul & start "" "${exe}"`;
        const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.unref();
      } else if (process.platform === "darwin") {
        // appRoot is <bundle>.app/Contents/Resources/app; relaunch the whole
        // bundle, not the helper executable.
        const bundle = path.resolve(vscode.env.appRoot, "../../..");
        const args = bundle.endsWith(".app") ? ["-n", bundle] : ["-n", "-a", vscode.env.appName];
        const child = spawn("/bin/sh", ["-c", `sleep 2; open ${args.map((part) => `"${part}"`).join(" ")}`], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } else {
        const child = spawn("/bin/sh", ["-c", `sleep 2; "${exe}"`], { detached: true, stdio: "ignore" });
        child.unref();
      }
    } catch (err) {
      log.warn("restart spawn failed", (err as Error).message);
    }
    setTimeout(() => {
      void vscode.commands.executeCommand("workbench.action.quit");
    }, 300);
  }

  private async probeAudio(announce: boolean): Promise<EngineProbe> {
    const record = await this.components.nativeRecord();
    if (!record?.entryPath || record.status !== "ready") {
      throw new Error("原生引擎未安装或未启用，请先在设置 → 组件中安装并启用");
    }
    const backends: NativeBackend[] =
      process.platform === "win32" ? ["wasapi", "asio"] : process.platform === "darwin" ? ["coreaudio"] : ["alsa"];
    const results = await Promise.all(backends.map((backend) => probeEngine(record.entryPath!, backend)));
    const probe: EngineProbe = {
      ...results[0],
      ok: results.some((result) => result.ok),
      devices: results.flatMap((result) => result.devices ?? []),
      backends: [...new Set(results.flatMap((result) => result.backends ?? []))],
    };
    this.probeCache = { path: record.entryPath, probe, at: Date.now() };
    await this.autoConfigureOutput(probe);
    await this.pushComponents();
    this.settingsPanel.post({ type: "engineInfo", info: await this.nativeStatus() });
    if (!probe.ok) throw new Error(probe.error ?? "原生引擎探测失败");
    if (announce) this.toast(`探测完成：${probe.devices?.length ?? 0} 个输出设备`, "success");
    return probe;
  }

  private async autoConfigureOutput(probe: EngineProbe): Promise<void> {
    if (this.autoConfiguring) return;
    const devices = probe.devices ?? [];
    if (!devices.length) return;
    this.autoConfiguring = true;
    try {
      const configuration = vscode.workspace.getConfiguration("neteaseMusic");
      const cfg = getConfig();
      const hasAsio = devices.some((device) => device.backend === "asio");
      const configured = normalizeNativeBackend(cfg.output.backend);
      const backend = configured === "asio" && !hasAsio ? defaultNativeBackend() : configured;
      if (!this.outputAutoInitialized) this.outputAutoInitialized = true;
      const backendDevices = devices.filter((device) => device.backend === backend);
      const defaultDevice = backendDevices.find((device) => device.isDefault) ?? backendDevices[0];
      let selected: (typeof devices)[number] | undefined = backend === "asio" ? defaultDevice : defaultDevice ?? backendDevices[0];
      if (backend !== cfg.output.backend) await configuration.update("output.backend", backend, vscode.ConfigurationTarget.Global);
      const targetDevice = backend === "wasapi" ? "default" : selected?.id;
      if (targetDevice && targetDevice !== cfg.output.device) {
        await configuration.update("output.device", targetDevice, vscode.ConfigurationTarget.Global);
      }
    } finally {
      this.autoConfiguring = false;
    }
  }

  private async selectDevice(): Promise<void> {
    const probe = await this.probeAudio(false);
    const devices = probe.devices ?? [];
    const currentBackend = getConfig().output.backend;
    const items: Array<vscode.QuickPickItem & { deviceId: string; backend?: NativeBackend }> = [
      { label: "$(home) 系统默认设备", description: "由操作系统选择默认端点", deviceId: "default" },
      ...devices.map((device) => ({
        label: `$(device-desktop) ${device.name}`,
        description: `${device.backend}${device.isDefault ? " · 默认" : ""}${device.backend === currentBackend ? " · 当前后端" : ""}`,
        detail: device.formats.map((format) => `${format.sampleRate / 1000} kHz/${format.bits} bit`).join(" · "),
        deviceId: device.id,
        backend: device.backend as NativeBackend,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "选择音频输出设备（会同时切换对应后端）",
      matchOnDescription: true,
    });
    if (!picked) return;
    this.autoConfiguring = true;
    try {
      const configuration = vscode.workspace.getConfiguration("neteaseMusic");
      await configuration.update("output.device", picked.deviceId, vscode.ConfigurationTarget.Global);
      if (picked.backend) await configuration.update("output.backend", picked.backend, vscode.ConfigurationTarget.Global);
      const chosen = devices.find((device) => device.id === picked.deviceId);
      const bluetooth = Boolean(chosen && /bluetooth|蓝牙|hands-free|airpods|buds|wh-1000|wf-1000/i.test(chosen.name));
      await configuration.update("output.mode", bluetooth ? "webaudio" : "native", vscode.ConfigurationTarget.Global);
      // CoreAudio has no WASAPI-style exclusive format negotiation; leave the
      // stricter switches off by default so device selection never goes silent.
      const strict = !bluetooth && process.platform !== "darwin";
      await configuration.update("output.exclusive", strict, vscode.ConfigurationTarget.Global);
      await configuration.update("output.bitPerfect", strict, vscode.ConfigurationTarget.Global);
      if (!bluetooth) await configuration.update("output.hrtf", false, vscode.ConfigurationTarget.Global);
    } finally {
      this.autoConfiguring = false;
    }
    this.pushSettings();
    this.toast(`输出设备已设为：${picked.label.replace(/\$\([^)]*\)\s*/, "")}`, "success");
  }

  private async ensureAudioHost(): Promise<void> {
    let ok = await this.sidebar.ensureReady();
    if (!ok) {
      try {
        await vscode.commands.executeCommand("workbench.view.extension.neteaseMusic");
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      ok = this.sidebar.isReady;
    }
    if (!ok) throw new Error("音频宿主侧边栏未就绪，请打开「网易云音乐」侧边栏后重试");
    await this.player.refreshOutput();
    const output = this.player.state().output;
    if (output.kind === "none") throw new Error(output.detail);
    log.info("audio host ready", `${output.kind}: ${output.label}`);
  }

  private async openInFileManager(dir: string): Promise<void> {
    const target = path.resolve(dir);
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [target], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  private async downloadCover(payload: any): Promise<void> {
    const url = String(payload.url ?? "");
    if (!url) throw new Error("封面地址为空");
    const cfg = getConfig();
    const dir = path.resolve(cfg.cover.dir || path.join(this.downloads.dir, "covers"));
    await fs.mkdir(dir, { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`封面下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg";
    const template = cfg.cover.filenameTemplate || "{name} - {artist}";
    const rawName = template
      .replace(/\{name\}/g, String(payload.name ?? "封面"))
      .replace(/\{artist\}/g, String(payload.artist ?? ""))
      .trim();
    const name = (rawName || "封面").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 150);
    const file = path.join(dir, `${name}${ext}`);
    await fs.writeFile(file, buffer);
    this.toast(`封面已保存：${file}`, "success");
    this.mainPanel.post({ type: "toast", kind: "success", message: `封面已保存：${file}` });
  }

  private setSleepTimer(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      this.clearSleepTimer();
      return;
    }
    this.clearSleepTimer(false);
    const ms = Math.round(minutes) * 60 * 1000;
    this.sleepUntil = Date.now() + ms;
    this.sleepTimer = setTimeout(() => {
      this.clearSleepTimer(false);
      void this.player.sleepStop();
      this.toast("定时关闭：已暂停播放", "info");
    }, ms);
    if (!this.sleepTicker) {
      this.sleepTicker = setInterval(() => this.updateSleepStatus(), 1000);
    }
    this.updateSleepStatus();
    this.toast(Math.round(minutes) + " 分钟后暂停", "success");
  }

  private clearSleepTimer(announce = true): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    if (this.sleepTicker) clearInterval(this.sleepTicker);
    this.sleepTimer = undefined;
    this.sleepTicker = undefined;
    this.sleepUntil = undefined;
    this.status.sleep.hide();
    if (announce) this.toast("已关闭定时暂停");
  }

  private updateSleepStatus(): void {
    if (!this.sleepUntil) {
      this.status.sleep.hide();
      return;
    }
    const total = Math.ceil(Math.max(0, this.sleepUntil - Date.now()) / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    this.status.sleep.text =
      "$(clock) 定时关闭 " + hours + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    this.status.sleep.tooltip = "定时关闭剩余 " + hours + " 小时 " + minutes + " 分 " + seconds + " 秒\n点击取消";
    this.status.sleep.command = "neteaseMusic.sleepTimer";
    this.status.sleep.show();
  }

  private async pickSleepTimer(): Promise<void> {
    if (this.sleepUntil) {
      this.clearSleepTimer();
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: "15 分钟后暂停", minutes: 15 },
        { label: "30 分钟后暂停", minutes: 30 },
        { label: "60 分钟后暂停", minutes: 60 },
        { label: "90 分钟后暂停", minutes: 90 },
      ],
      { title: "定时关闭", placeHolder: "选择暂停时间（侧边栏时钟可自定义分钟）" },
    );
    if (picked) this.setSleepTimer(picked.minutes);
  }

private async pickPlaybackRate(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "0.75x", value: 0.75 },
        { label: "1.0x（正常）", value: 1 },
        { label: "1.25x", value: 1.25 },
        { label: "1.5x", value: 1.5 },
        { label: "2.0x", value: 2 },
      ],
      { title: "播放速度" },
    );
    if (!picked) return;
    await this.player.setRate(picked.value);
    this.toast(`播放速度 ${picked.label}`, "success");
  }

  // -------------------------------------------------------------- local files

  private localTrackViewToTrack(item: LocalTrackView): Track {
    return {
      id: item.id,
      name: item.name,
      artists: [{ id: 0, name: item.artists || "本地音乐" }],
      album: { id: 0, name: item.album || item.ext.toUpperCase(), picUrl: "" },
      duration: 0,
      localPath: item.path,
    };
  }

  private async scanLocalMusic(): Promise<LocalTrackView[]> {
    const cfg = getConfig();
    const dir = cfg.localMusic.dir || this.downloads.dir;
    const results: LocalTrackView[] = [];
    const downloaded = new Map(
      this.downloads
        .toViews()
        .filter((task): task is typeof task & { path: string } => Boolean(task.path))
        .map((task) => [path.resolve(task.path), task]),
    );
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 3 || results.length >= 1000) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= 1000) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        const stat = await fs.stat(full).catch(() => null);
        if (!stat?.isFile()) continue;
        const stem = entry.name.slice(0, -ext.length);
        const match = stem.match(/^(.+?)\s+-\s+(.+)$/);
        const task = downloaded.get(path.resolve(full));
        const songId = task?.songId;
        const clean = (value: string): string =>
          value.replace(/\{(?:artist|name|album|id|quality|ext)\}/gi, "").trim();
        const rawName = match ? match[2] : task?.name ?? stem;
        const rawArtist = match ? match[1] : task?.artists ?? "";
        results.push({
          path: full,
          id: songId ?? -Math.abs(hashString(full)),
          songId,
          name: clean(rawName) || stem,
          artists: clean(rawArtist) || "本地音乐",
          album: path.basename(path.dirname(full)),
          size: stat.size,
          ext,
        });
      }
    };
    await walk(dir, 0);
    results.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return results;
  }

  // ---------------------------------------------------------------- settings

  private async openSettings(tab: string): Promise<void> {
    this.settingsTab = tab || "account";
    await this.settingsPanel.open(this.settingsTab);
  }

  private async openDocs(): Promise<void> {
    const candidates = ["docs/使用说明.md", "README.md"];
    for (const relative of candidates) {
      const uri = vscode.Uri.joinPath(this.ctx.extensionUri, relative);
      try {
        await fs.access(uri.fsPath);
        await vscode.commands.executeCommand("markdown.showPreview", uri);
        return;
      } catch {
        /* try next */
      }
    }
    throw new Error("未找到文档文件");
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): void {
    const register = (id: string, handler: (...args: any[]) => unknown): void => {
      this.disposables.push(
        vscode.commands.registerCommand(id, (...args: any[]) => {
          Promise.resolve(handler(...args)).catch((err) => this.reportError(err));
        }),
      );
    };
    register("neteaseMusic.focus", () => this.openMain());
    register("neteaseMusic.back", () => this.goBack());
    register("neteaseMusic.openPlayer", () => this.openMain());
    register("neteaseMusic.openMain", () => this.openMain());
    register("neteaseMusic.openNowPlaying", () => this.openNow());
    register("neteaseMusic.openQueue", () => this.openQueue());
    register("neteaseMusic.toggleQueue", () => {
      this.mainPanel.createOrShow();
      if (this.mainPanel.isReady) this.mainPanel.post({ type: "toggleQueue" });
      else this.openQueue();
    });
    register("neteaseMusic.openMyProfile", () => this.openMyProfile());
    register("neteaseMusic.openSettingsPanel", () => this.openSettings("account"));
    register("neteaseMusic.playlist.open", async (id: number) => this.openPlaylist(Number(id)));
    register("neteaseMusic.toggleLyrics", async () => {
      await this.toggleLyrics();
    });
    register("neteaseMusic.minimize", async () => {
      try {
        await vscode.commands.executeCommand("workbench.action.toggleWindowMaximized");
      } catch {
        await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
      }
    });
    register("neteaseMusic.like", async () => {
      const id = this.player.current?.id ?? 0;
      if (id <= 0) return;
      const liked = await this.player.toggleLike(id);
      this.toast(liked ? "已添加到喜欢的音乐" : "已取消喜欢", "success");
    });
    register("neteaseMusic.favorite", async () => {
      const track = this.player.current;
      if (!track) return;
      await this.openFavorite(track.id, true);
    });
    register("neteaseMusic.mode", async () => {
      const modes = ["order", "shuffle", "repeatOne", "repeat"] as const;
      const current = this.player.state().mode;
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      await this.player.setMode(next);
      this.toast(`播放模式：${next}`, "success");
    });
    register("neteaseMusic.pause", async () => {
      await this.player.pause();
    });
    register("neteaseMusic.playPause", async () => {
      if (await this.localListenControl("toggle")) return;
      if (this.player.state().output.kind === "none") await this.ensureAudioHost();
      await this.player.toggle();
    });
    register("neteaseMusic.next", async () => {
      if (await this.localListenControl("next")) return;
      if (this.player.state().output.kind === "none") await this.ensureAudioHost();
      await this.player.next(true);
    });
    register("neteaseMusic.previous", async () => {
      if (await this.localListenControl("previous")) return;
      if (this.player.state().output.kind === "none") await this.ensureAudioHost();
      await this.player.previous();
    });
    register("neteaseMusic.volumeUp", () => this.player.setVolume(this.player.state().volume + 0.05));
    register("neteaseMusic.volumeDown", () => this.player.setVolume(this.player.state().volume - 0.05));
    register("neteaseMusic.mute", () => this.toggleMute());
    register("neteaseMusic.qualityPicker", () => this.pickQuality());
    register("neteaseMusic.sleepTimer", () => this.pickSleepTimer());
    register("neteaseMusic.volumePicker", () => this.pickVolume());
    register("neteaseMusic.search", async () => {
      const query = await vscode.window.showInputBox({ prompt: "搜索歌曲", placeHolder: "歌曲 / 歌手 / 专辑" });
      if (!query) return;
      await this.openSearch(query, "all");
    });
    register("neteaseMusic.login", () => this.openLogin());
    register("neteaseMusic.logout", async () => {
      this.stopQr();
      await this.session.logout();
      this.userPlaylists = [];
      this.likedHydrated = false;
      this.pushSidebar();
      this.broadcast({ type: "account", account: null });
      this.toast("已退出登录", "success");
    });
    register("neteaseMusic.downloadCurrent", async () => {
      const track = this.player.current;
      if (!track) throw new Error("当前没有播放歌曲");
      await this.downloads.enqueue(track);
      this.toast(`开始下载：${track.name}`);
    });
    register("neteaseMusic.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:AICis.netease-music-vscode"),
    );
    register("neteaseMusic.openConfigFile", () => vscode.commands.executeCommand("workbench.action.openSettingsJson"));
    register("neteaseMusic.showOutput", () => showLog());
    register("neteaseMusic.refresh", async () => {
      await this.components.rescan();
      await this.pushComponents();
      await this.refreshUserPlaylists();
      await this.refreshCurrentPage();
      await this.player.refreshOutput();
    });
    register("neteaseMusic.components.install", () => this.installComponent());
    register("neteaseMusic.components.refresh", async () => {
      await this.components.rescan();
      await this.pushComponents();
    });
    register("neteaseMusic.components.docs", () => this.openDocs());
    register("neteaseMusic.components.enable", (arg) =>
      this.withRecord(arg, async (record) => {
        await this.components.setEnabled(record.id, true);
        await this.pushComponents();
        await this.player.refreshOutput();
        this.toast(`已启用 ${record.name}`, "success");
      }),
    );
    register("neteaseMusic.components.disable", (arg) =>
      this.withRecord(arg, async (record) => {
        await this.components.setEnabled(record.id, false);
        await this.pushComponents();
        await this.player.refreshOutput();
        this.toast(`已禁用 ${record.name}`);
      }),
    );
    register("neteaseMusic.components.remove", (arg) =>
      this.withRecord(arg, (record) => this.removeComponent(record.id)),
    );
    register("neteaseMusic.components.verify", (arg) =>
      this.withRecord(arg, async (record) => {
        const result = await this.components.verify(record.id);
        this.toast(result.message, result.ok ? "success" : "error");
      }),
    );
    register("neteaseMusic.components.locate", (arg) =>
      this.withRecord(arg, (record) => this.locateComponent(record.id)),
    );
    register("neteaseMusic.components.restoreBundled", async () => {
      const record = await this.components.restoreBundledNative();
      await this.pushComponents();
      await this.player.refreshOutput();
      this.toast(`已恢复随包原生引擎 ${record.version}`, "success");
    });
    register("neteaseMusic.components.openDir", (arg) =>
      arg ? this.withRecord(arg, (record) => this.openComponentDir(record.id)) : this.openComponentDir(""),
    );
    register("neteaseMusic.components.info", (arg) =>
      this.withRecord(arg, async (record) => {
        const lines = [
          `名称：${record.name}`,
          `ID：${record.id}`,
          `版本：${record.version}`,
          `类型：${record.kind}`,
          `状态：${record.status}${record.enabled ? "（已启用）" : ""}`,
          `平台：${record.platform}/${record.arch}`,
          `后端：${record.backend ?? "—"}`,
          `位置：${record.entryPath ?? record.dir}`,
          record.reason ? `提示：${record.reason}` : "",
        ].filter(Boolean);
        await vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
      }),
    );
    register("neteaseMusic.audio.selectDevice", () => this.selectDevice());
    register("neteaseMusic.audio.probe", () => this.probeAudio(true));
    register("neteaseMusic.audio.showEngineInfo", async () => {
      await this.probeAudio(false);
      await this.openSettings("system");
      this.settingsPanel.post({ type: "engineInfo", info: await this.nativeStatus() });
      const info = await this.nativeStatus();
      this.toast(`原生引擎：${info.devices?.length ?? 0} 个设备${info.version ? ` · v${info.version}` : ""}`, "success");
    });
  }

  private async withRecord(arg: unknown, fn: (record: ComponentRecord) => Promise<void>): Promise<void> {
    let record: ComponentRecord | undefined;
    if (typeof arg === "string") record = await this.components.get(arg);
    else if (arg && typeof arg === "object" && "id" in (arg as object)) record = arg as ComponentRecord;
    if (!record) throw new Error("未找到组件");
    await fn(record);
  }

  // ------------------------------------------------------------- status bar

  private directoryForSetting(key: string): string {
    const cfg = getConfig();
    if (key === "download.dir") return this.downloads.dir;
    if (key === "cache.dir") return cfg.cache.dir || defaultCacheDir(this.ctx);
    if (key === "cover.dir") return cfg.cover.dir || path.join(this.downloads.dir, "covers");
    if (key === "localMusic.dir") return cfg.localMusic.dir || this.downloads.dir;
    return "";
  }

  private async migrateDirectory(from: string, to: string, key: string): Promise<void> {
    if (!from || !to || path.resolve(from) === path.resolve(to)) return;
    const fromResolved = path.resolve(from);
    const toResolved = path.resolve(to);
    if (toResolved.startsWith(fromResolved + path.sep) || fromResolved.startsWith(toResolved + path.sep)) return;
    const cacheFile = /\.(flac|mp3|m4a|wav|ogg|ape|part|done)$/i;
    const coverFile = /\.(png|jpe?g|webp|gif)$/i;
    const downloadFile = /\.(flac|mp3|m4a|wav|ogg|ape|lrc|png|jpe?g|webp|gif)$/i;
    const allowed = key === "cache.dir"
      ? (name: string) => /\.(flac|mp3|m4a|wav|ogg|ape|part|done)$/i.test(name)
      : key === "cover.dir"
        ? (name: string) => coverFile.test(name)
        : key === "download.dir"
          ? (name: string) => downloadFile.test(name)
          : (name: string) => cacheFile.test(name);
    try {
      const stat = await fs.stat(fromResolved);
      if (!stat.isDirectory()) return;
      await fs.mkdir(toResolved, { recursive: true });
      const entries = await fs.readdir(fromResolved, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !allowed(entry.name)) continue;
        const source = path.join(fromResolved, entry.name);
        const target = path.join(toResolved, entry.name);
        await fs.copyFile(source, target);
        await fs.rm(source, { force: true });
      }
      await fs.rmdir(fromResolved).catch(() => undefined);
    } catch {
      this.toast("旧目录迁移失败，已保留原目录", "error");
    }
  }

  private shortcutValues(): Record<string, string> {
    const saved = this.ctx.globalState.get<Record<string, string>>("neteaseMusic.shortcuts") ?? {};
    const values: Record<string, string> = {};
    for (const def of SHORTCUT_DEFS) {
      values[def.id] = saved[def.id] ?? def.local;
      values[def.id + "Global"] = saved[def.id + "Global"] ?? def.global;
    }
    return values;
  }

  private async setShortcut(id: string, value: string): Promise<void> {
    const saved = { ...(this.ctx.globalState.get<Record<string, string>>("neteaseMusic.shortcuts") ?? {}) };
    saved[id] = value.trim();
    await this.ctx.globalState.update("neteaseMusic.shortcuts", saved);
    await this.applyShortcuts();
    this.pushSettings();
  }

  private async applyShortcuts(): Promise<void> {
    const values = this.shortcutValues();
    const entries: string[] = [];
    for (const def of SHORTCUT_DEFS) {
      const local = values[def.id];
      const global = values[def.id + "Global"];
      if (local) entries.push(`  { "key": "${local.toLowerCase()}", "command": "${def.command}", "when": "activeWebviewPanelId == 'neteaseMusic.main' || focusedView == 'neteaseMusic.sidebar'" }`);
      if (global) entries.push(`  { "key": "${global.toLowerCase()}", "command": "${def.command}" }`);
    }
    const begin = "// >>> netease-music shortcuts (auto-generated)";
    const end = "// <<< netease-music shortcuts";
    const block = begin + "\n" + entries.join(",\n") + "\n  " + end;
    try {
      const userDir = path.dirname(path.dirname(this.ctx.globalStorageUri.fsPath));
      const file = path.join(userDir, "keybindings.json");
      let text = await fs.readFile(file, "utf8").catch(() => "[]");
      text = text.replace(/\n?\/\/ >>> netease-music shortcuts[\s\S]*?\/\/ <<< netease-music shortcuts\n?/g, "");
      const close = text.lastIndexOf("]");
      if (close < 0) return;
      let head = text.slice(0, close).trimEnd();
      if (!head.endsWith("[")) head += ",";
      text = head + "\n" + block + "\n" + text.slice(close);
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(file, text, "utf8");
    } catch {
      /* ignore keybindings sync errors */
    }
  }

  private configureStatusBar(): void {
    const s = this.status;
    s.previous.text = "$(chevron-left)";
    s.previous.tooltip = "上一首";
    s.previous.command = "neteaseMusic.previous";
    s.lyrics.text = "$(comment)";
    s.lyrics.tooltip = "开启/关闭歌词悬浮窗";
    s.lyrics.command = "neteaseMusic.toggleLyrics";
    s.like.text = "$(heart)";
    s.like.tooltip = "喜欢当前歌曲";
    s.like.command = "neteaseMusic.like";
    s.favorite.text = "$(star)";
    s.favorite.tooltip = "收藏到歌单";
    s.favorite.command = "neteaseMusic.favorite";
    s.mode.text = "$(list-ordered)";
    s.mode.tooltip = "切换播放模式";
    s.mode.command = "neteaseMusic.mode";
    s.play.text = "$(play)";
    s.play.tooltip = "播放 / 暂停";
    s.play.command = "neteaseMusic.playPause";
    s.next.text = "$(chevron-right)";
    s.next.tooltip = "下一首";
    s.next.command = "neteaseMusic.next";
    s.title.text = "$(music) 网易云音乐";
    s.title.tooltip = "打开网易云音乐";
    s.title.command = "neteaseMusic.openNowPlaying";
    s.quality.text = "$(verified) 极高";
    s.quality.tooltip = "切换播放音质";
    s.quality.command = "neteaseMusic.qualityPicker";
    s.volume.text = "$(unmute) 80%";
    s.volume.tooltip = "调节音量";
    s.volume.command = "neteaseMusic.volumePicker";
    s.now.text = "$(play-circle)";
    s.now.tooltip = "打开歌曲详情 / 正在播放";
    s.now.command = "neteaseMusic.openNowPlaying";
    s.queue.text = "$(list-unordered)";
    s.queue.tooltip = "播放队列";
    s.queue.command = "neteaseMusic.toggleQueue";
    s.settings.text = "$(settings-gear)";
    s.settings.tooltip = "网易云音乐设置";
    s.settings.command = "neteaseMusic.openSettingsPanel";
    s.idle.text = "$(music) 网易云音乐";
    s.idle.tooltip = "打开网易云音乐";
    s.idle.command = "neteaseMusic.openMain";
    for (const item of this.statusItems) item.show();
  }

  private startMarquee(): void {
    if (this.marqueeTimer) return;
    this.marqueeTimer = setInterval(() => {
      this.marqueeOffset += 1;
      this.updateStatusTitle();
    }, 650);
  }

  private stopMarquee(): void {
    if (!this.marqueeTimer) return;
    clearInterval(this.marqueeTimer);
    this.marqueeTimer = undefined;
  }

  private updateStatusTitle(): void {
    const state = this.player.state();
    const track = state.track;
    if (!track) return;
    const artists = track.artists.map((artist) => artist.name).join(" / ");
    const full = `${track.name}${artists ? ` 鈥? ${artists}` : ""}`;
    if (full.length <= 22) {
      this.stopMarquee();
      this.status.title.text = `$(music) ${full}`;
      return;
    }
    const cycle = full.length + 3;
    const offset = this.marqueeOffset % cycle;
    const padded = `${full}   ${full}`;
    const label = padded.slice(offset, offset + 22).padEnd(22, "\u3000");
    this.status.title.text = `$(music) ${label}`;
  }

  private updateStatus(): void {
    this.updateSleepStatus();
    const state = this.player.state();
    const track = state.track;
    const statusKey = track
      ? [track.id, state.playing, state.loading, Math.round(state.preparing || 0), state.liked, state.mode, state.quality, state.actualQuality, Math.round(state.volume * 100), state.output.label].join("|")
      : "idle";
    if (statusKey === this.lastStatusKey) return;
    this.lastStatusKey = statusKey;
    if (!track) {
      this.status.idle.hide();
      this.status.buffer.hide();
      this.status.previous.show();
      this.status.play.show();
      this.status.next.show();
      this.status.title.show();
      this.status.quality.show();
      this.status.volume.show();
      this.status.now.show();
      this.status.queue.show();
      this.status.settings.show();
      this.status.play.text = "$(play)";
      this.status.play.tooltip = "播放 / 暂停";
      this.status.title.text = "$(music) 网易云音乐";
      this.status.title.tooltip = "打开网易云音乐";
      const configured = QUALITY_LABELS[state.quality] ?? state.quality;
      this.status.quality.text = `$(verified) ${configured}`;
      this.status.quality.tooltip = `当前音质：${configured}（未在播放）\n点击切换`;
      this.status.volume.text = `${state.volume <= 0.01 ? "$(mute)" : "$(unmute)"} ${Math.round(state.volume * 100)}%`;
      this.status.volume.tooltip = `音量 ${Math.round(state.volume * 100)}%\n点击调节`;
      this.applyStatusVisibility(state);
      return;
    }
    this.status.idle.hide();
    this.status.buffer.show();
    this.status.previous.show();
    this.status.play.show();
    this.status.next.show();
    this.status.title.show();
    this.status.quality.show();
    this.status.volume.show();
    this.status.now.show();
    this.status.queue.show();
    this.status.settings.show();
    const bufferPercent = state.loading ? Math.max(0, Math.min(100, Math.round(state.preparing || 0))) : 0;
    this.status.buffer.text = `$(sync) 缓冲 ${String(bufferPercent).padStart(3, " ")}%`;
    this.status.buffer.tooltip = state.loading ? "正在缓冲当前歌曲" : "缓冲完成";
    this.status.buffer.show();
    this.status.play.command = "neteaseMusic.playPause";
    this.status.play.text = state.playing ? "$(debug-pause)" : "$(play)";
    this.status.play.tooltip = state.playing ? "暂停" : "播放";
    const artists = track.artists.map((artist) => artist.name).join(" / ");
    const full = `${track.name}${artists ? ` — ${artists}` : ""}`;
    if (full !== this.lastTitle) {
      this.lastTitle = full;
      this.marqueeOffset = 0;
    }
    if (full.length > 22) this.startMarquee();
    else this.stopMarquee();
    const window = 22;
    let label = full;
    if (full.length > window) {
      const cycle = full.length + 3;
      const offset = this.marqueeOffset % cycle;
      const padded = `${full}   ${full}`;
      label = padded.slice(offset, offset + window).padEnd(window, "\u3000");
    } else {
      label = full.padEnd(window, "\u3000");
    }
    this.status.title.text = `$(music) ${label}`;
    const actual = state.actualQuality && state.actualQuality !== "local"
      ? QUALITY_LABELS[state.actualQuality] ?? state.actualQuality
      : QUALITY_LABELS[state.quality] ?? state.quality;
    const requested = QUALITY_LABELS[state.quality] ?? state.quality;
    const downgraded = state.actualQuality && !["local", state.quality].includes(state.actualQuality);
    this.status.title.tooltip = `${full}\n${state.output.label}${downgraded ? `\n请求：${requested} · 实际：${actual}` : ""}`;
    this.status.quality.text = `$(verified) ${actual}`;
    this.status.quality.tooltip = `当前音质：${actual}${downgraded ? `（请求 ${requested}，服务端已降级）` : ""}\n点击切换`;
    this.status.volume.text = `${state.volume <= 0.01 ? "$(mute)" : "$(unmute)"} ${Math.round(state.volume * 100)}%`;
    this.status.volume.tooltip = `音量 ${Math.round(state.volume * 100)}%\n点击调节`;
    this.status.lyrics.text = "$(comment)";
    this.status.lyrics.tooltip = this.lyricsOverlay?.active ? "关闭歌词悬浮窗" : "开启歌词悬浮窗";
    this.status.like.text = state.liked ? "$(heart-filled)" : "$(heart)";
    this.status.like.tooltip = state.liked ? "取消喜欢" : "喜欢当前歌曲";
    this.status.mode.text =
      state.mode === "shuffle"
        ? "随机播放"
        : state.mode === "repeatOne"
          ? "单曲循环"
          : state.mode === "repeat"
            ? "列表循环"
            : "顺序播放";
    this.status.mode.tooltip = "切换播放模式";
    this.applyStatusVisibility(state);
  }

  private applyStatusVisibility(state: ReturnType<typeof this.player.state>): void {
    const st = getConfig().status;
    const hasTrack = Boolean(state.track);
    const show = (item: vscode.StatusBarItem, visible: boolean) => (visible ? item.show() : item.hide());
    show(this.status.lyrics, st.showLyrics && hasTrack);
    show(this.status.buffer, st.showBuffer && hasTrack);
    show(this.status.like, st.showLike && hasTrack);
    show(this.status.favorite, st.showFavorite && hasTrack);
    show(this.status.mode, st.showMode && hasTrack);
    show(this.status.previous, st.showNavigation && hasTrack);
    show(this.status.play, st.showNavigation && hasTrack);
    show(this.status.next, st.showNavigation && hasTrack);
    show(this.status.queue, st.showQueue && hasTrack);
    this.status.settings.show();
    show(this.status.title, st.showTitle);
  }

  private async pickQuality(): Promise<void> {
    const state = this.player.state();
    const items = QUALITY_OPTIONS.map((option) => ({
      label: `${state.quality === option.key ? "$(check) " : ""}${option.label}`,
      description: option.tier === "free" ? "免费" : option.tier.toUpperCase(),
      detail: option.description,
      quality: option.key,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "选择播放音质（高音质需要对应会员权益）",
      matchOnDescription: true,
    });
    if (picked) await this.setPlaybackQuality(picked.quality);
  }

  private async pickVolume(): Promise<void> {
    const current = Math.round(this.player.state().volume * 100);
    const items = [0, 20, 40, 60, 80, 100].map((value) => ({
      label: `${current === value ? "$(check) " : ""}${value === 0 ? "静音" : `${value}%`}`,
      value,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "选择音量" });
    if (picked) await this.player.setVolume(picked.value / 100);
  }

  private async toggleMute(): Promise<void> {
    const volume = this.player.state().volume;
    if (volume > 0.01) {
      this.lastVolume = volume;
      await this.player.setVolume(0);
    } else {
      await this.player.setVolume(this.lastVolume || 0.8);
    }
  }

  private reportError(err: unknown): void {
    const message = (err as Error).message ?? String(err);
    log.error("command failed", String(err));
    void vscode.window.showErrorMessage(`网易云音乐：${message}`);
    this.toast(message, "error");
  }

  dispose(): void {
    if (this.listenPoll) clearTimeout(this.listenPoll);
    if (this.friendPoll) clearInterval(this.friendPoll);
    this.stopQr();
    this.smtc?.stop();
    if (this.marqueeTimer) clearInterval(this.marqueeTimer);
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    for (const item of this.statusItems) item.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.downloads.dispose();
    this.player.dispose();
    this.components.dispose();
    this.session.dispose();
    this.mainPanel.dispose();
    this.settingsPanel.dispose();
    this.sidebar.dispose();
  }
}

function pageKey(page: PageView): string {
  switch (page.kind) {
    case "playlist":
      return `playlist:${page.playlist?.playlist.id ?? 0}`;
    case "song":
      return `song:${page.song?.track.id ?? 0}`;
    case "user":
      return `user:${page.user?.user.userId ?? 0}`;
    case "album":
      return `album:${page.album?.id ?? 0}`;
    case "artist":
      return `artist:${page.artist?.id ?? 0}`;
    case "search":
      return `search:${page.search?.kind ?? "song"}:${page.search?.query ?? ""}`;
    default:
      return page.kind;
  }
}

function navForPage(page: PageView): string {
  switch (page.kind) {
    case "playlist":
      return "playlist";
    case "song":
      return "song";
    case "user":
      return "user";
    case "album":
      return "album";
    case "artist":
      return "artist";
    case "search":
      return "search";
    default:
      return page.kind;
  }
}

function hashString(value: string): number {  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

/** Pull composer names out of LRC metadata such as `[00:00] 作曲 : 张三 / 李四`. */
function parseComposers(lrc: string): string[] {
  const names: string[] = [];
  for (const line of lrc.split(/\r?\n/)) {
    const match = line.match(/(?:作曲|Composer)\s*[:：]\s*(.+)$/i);
    if (!match) continue;
    for (const name of match[1].split(/[/、,，&]/)) {
      const clean = name.replace(/\s*等$/, "").trim();
      if (clean && !names.includes(clean)) names.push(clean);
    }
  }
  return names;
}
