import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import * as QRCode from "qrcode";
import { SessionManager } from "./auth/session";
import { commentResource } from "./api/client";
import type {
  Account,
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
  getConfig,
  QUALITY_LABELS,
  QUALITY_OPTIONS,
  type Quality,
} from "./config";
import { DownloadManager } from "./download/downloader";
import { ComponentStore, type ComponentRecord } from "./player/components";
import { probeEngine, type EngineProbe } from "./player/nativeEngine";
import { PlayerService } from "./player/player";
import type {
  CommentsView,
  ComponentView,
  HostMessage,
  InitState,
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

export class App implements vscode.Disposable {
  readonly session: SessionManager;
  readonly components: ComponentStore;
  readonly player: PlayerService;
  readonly downloads: DownloadManager;
  readonly sidebar: SidebarViewProvider;
  readonly mainPanel: MainPanelProvider;
  readonly settingsPanel: SettingsPanelProvider;

  private readonly status = {
    previous: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 109),
    play: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 108),
    next: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 107),
    title: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 106),
    quality: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105),
    volume: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104),
    now: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103),
    queue: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102),
    settings: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101),
    idle: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
  };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusItems: vscode.StatusBarItem[];

  private userPlaylists: UserPlaylist[] = [];
  private playlistsLoaded = false;
  private activeNav = "recommend";
  private currentPage: PageView = { kind: "recommend", title: "推荐", loading: true };
  private pageHistory: PageView[] = [];
  private navigatingBack = false;
  private settingsTab = "account";
  private activePlaylist?: PlaylistDetail;
  private commentsTarget?: CommentsTarget;
  private commentsView?: CommentsView;
  private subscribersView?: SubscribersView;
  private commentsOffset = 0;
  private subscribersOffset = 0;
  private localTracks: LocalTrackView[] = [];
  private playlistOrder: number[] = [];
  private likedHydrated = false;
  private localCount = 0;
  private cloudTracks: Track[] = [];
  private qrTimer?: NodeJS.Timeout;
  private probeCache?: ProbeCache;
  private lastVolume = 0.8;
  private pendingLogin = false;
  private pendingQueuePopup = false;
  private marqueeOffset = 0;
  private marqueeTimer?: NodeJS.Timeout;
  private lastTitle = "";
  private sleepTimer?: NodeJS.Timeout;

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
      onVisibility: (visible) => {
        if (!visible && !getConfig().playback.backgroundPlay) void this.player.pause();
      },
    });
    this.mainPanel = new MainPanelProvider(ctx, {
      ...hostDeps,
      onVisibility: (visible) => {
        if (!visible && !getConfig().playback.backgroundPlay) void this.player.pause();
      },
    });
    this.settingsPanel = new SettingsPanelProvider(ctx, hostDeps);

    this.configureStatusBar();
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
    this.startMarquee();
    if (getConfig().ui.autoOpen) {
      this.mainPanel.createOrShow();
      void this.openRecommend().catch((err) => log.warn("recommend failed", String(err)));
    }
    void this.refreshUserPlaylists().catch(() => undefined);
    void this.pushComponents();
    void this.ensureNative().catch((err) => log.warn("ensureNative failed", String(err)));
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
      this.player.onDidChange(() => this.updateStatus()),
      vscode.window.onDidChangeActiveColorTheme((theme) =>
        this.broadcast({ type: "theme", kind: String(theme.kind) }),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
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
    if (
      msg.type === "load" ||
      msg.type === "control" ||
      msg.type === "nativeReady" ||
      msg.type === "nativePcmAck" ||
      msg.type === "nativeFallback"
    ) {
      this.sidebar.post(msg);
      return;
    }
    if (msg.type === "playerError" || msg.type === "toast") {
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

  private settingsView(): SettingsView {
    const cfg = getConfig();
    return {
      quality: cfg.quality,
      downloadQuality: cfg.download.quality === "auto" ? "auto" : QUALITY_LABELS[cfg.download.quality] ?? cfg.download.quality,
      downloadDir: this.downloads.dir,
      coverDir: cfg.cover.dir || path.join(this.downloads.dir, "covers"),
      coverFilenameTemplate: cfg.cover.filenameTemplate,
      cacheDir: cfg.cache.dir || defaultCacheDir(this.ctx),
      localMusicDir: cfg.localMusic.dir || this.downloads.dir,
      componentsDir: this.components.rootDir,
      outputMode: cfg.output.mode,
      device: cfg.output.device,
      sampleRate: cfg.output.sampleRate,
      bitDepth: cfg.output.bitDepth,
      sampleFormat: cfg.output.sampleFormat,
      exclusive: cfg.output.exclusive,
      bufferMs: cfg.output.bufferMs,
      volume: Math.round(cfg.playback.volume),
      mode: cfg.playback.mode,
      backgroundPlay: cfg.playback.backgroundPlay,
      autoPlay: cfg.playback.autoPlay,
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
        const list = Array.isArray(payload.list) && payload.list.length ? (payload.list as Track[]) : undefined;
        const index = Number.isFinite(payload.index) ? Number(payload.index) : undefined;
        await this.player.playTrack(track, list, index);
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
        await this.player.setQueueAndPlay(tracks, Number(payload.index ?? 0));
        break;
      }
      case "playNext":
        if (payload.track) this.player.playNext(payload.track as Track);
        break;
      case "playPause":
        await this.ensureAudioHost();
        await this.player.toggle();
        break;
      case "next":
        await this.player.next(true);
        break;
      case "previous":
        await this.player.previous();
        break;
      case "seek":
        await this.player.seek(Number(payload.value));
        break;
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
        if (payload.track) this.player.addToQueue(payload.track as Track);
        break;
      case "enqueuePlaylist": {
        const view = await this.ensurePlaylist(Number(payload.id));
        if (view) {
          this.player.addManyToQueue(view.tracks);
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
        await this.session.client.removeTrackFromPlaylist(playlistId, trackId);
        this.toast("已从歌单删除", "success");
        await this.openPlaylist(playlistId);
        break;
      }
      case "qualityPicker":
        await vscode.commands.executeCommand("neteaseMusic.qualityPicker");
        break;
      case "sleepTimer":
        await this.pickSleepTimer();
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
      case "setConfig": {
        const key = String(payload.key ?? "");
        if (!key) return;
        await vscode.workspace
          .getConfiguration("neteaseMusic")
          .update(key, payload.value, vscode.ConfigurationTarget.Global);
        if (key === "playback.volume") {
          await this.player.setVolume(Number(payload.value) / 100);
        } else if (key === "playback.mode") {
          await this.player.setMode(payload.value as any);
        }
        this.pushSettings();
        this.pushSidebar();
        if (key.startsWith("output.")) await this.player.refreshOutput();
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
        await vscode.workspace
          .getConfiguration("neteaseMusic")
          .update(key, picked[0].fsPath, vscode.ConfigurationTarget.Global);
        this.pushSettings();
        this.toast("目录已更新", "success");
        break;
      }
      case "openConfigFile":
        await vscode.commands.executeCommand("workbench.action.openSettingsJson");
        break;
      case "openVscodeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:dsh.netease-music");
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
    if (!this.navigatingBack && previous && !previous.loading && pageKey(previous) !== pageKey(page)) {
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
    let lyric = { lrc: "", translation: "" };
    try {
      lyric = await this.session.client.lyric(id);
    } catch (err) {
      log.debug("song lyric unavailable", String(err));
    }
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

  private async openFavorite(trackId: number): Promise<void> {
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
    this.mainPanel.post({ type: "favoritePicker", trackId, playlists });
  }

  private async addFavorite(playlistId: number, trackId: number): Promise<void> {
    if (!playlistId || !trackId) throw new Error("请选择歌单");
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
    const result = await this.session.client.comments(resource, id, 30, offset);
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
    await this.player.setQuality(quality);
    this.toast(`音质请求已切换为：${QUALITY_LABELS[quality] ?? quality}`, "success");
    this.pushSettings();
    this.updateStatus();
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
        status.backend = probe.backends?.join(" / ") ?? status.backend;
        status.version = probe.version ?? status.version;
      } else {
        status.ready = false;
        status.reason = probe.error ?? "原生引擎探测失败";
      }
    }
    return status;
  }

  private async probeAudio(announce: boolean): Promise<EngineProbe> {
    const record = await this.components.nativeRecord();
    if (!record?.entryPath || record.status !== "ready") {
      throw new Error("原生引擎未安装或未启用，请先在设置 → 组件中安装并启用");
    }
    const probe = await probeEngine(record.entryPath);
    this.probeCache = { path: record.entryPath, probe, at: Date.now() };
    await this.pushComponents();
    this.settingsPanel.post({ type: "engineInfo", info: await this.nativeStatus() });
    if (!probe.ok) throw new Error(probe.error ?? "原生引擎探测失败");
    if (announce) this.toast(`探测完成：${probe.devices?.length ?? 0} 个输出设备`, "success");
    return probe;
  }

  private async selectDevice(): Promise<void> {
    const probe = await this.probeAudio(false);
    const devices = probe.devices ?? [];
    const items: Array<vscode.QuickPickItem & { deviceId: string }> = [
      { label: "$(home) 系统默认设备", description: "由操作系统选择默认端点", deviceId: "default" },
      ...devices.map((device) => ({
        label: `$(device-desktop) ${device.name}`,
        description: device.backend + (device.isDefault ? " · 默认" : ""),
        detail: device.formats.map((format) => `${format.sampleRate / 1000} kHz/${format.bits} bit`).join(" · "),
        deviceId: device.id,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "选择音频输出设备（写入 neteaseMusic.output.device）",
      matchOnDescription: true,
    });
    if (!picked) return;
    await vscode.workspace
      .getConfiguration("neteaseMusic")
      .update("output.device", picked.deviceId, vscode.ConfigurationTarget.Global);
    this.pushSettings();
    this.toast(`输出设备已设为：${picked.label.replace(/\$\([^)]*\)\s*/, "")}`, "success");
  }

  private async ensureAudioHost(): Promise<void> {
    const ok = await this.sidebar.ensureReady();
    if (!ok) throw new Error("音频宿主侧边栏未就绪，请打开「网易云音乐」侧边栏后重试");
    await this.player.refreshOutput();
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

  private async pickSleepTimer(): Promise<void> {    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: "关闭定时", minutes: 0 },
        { label: "15 分钟后暂停", minutes: 15 },
        { label: "30 分钟后暂停", minutes: 30 },
        { label: "60 分钟后暂停", minutes: 60 },
        { label: "90 分钟后暂停", minutes: 90 },
      ],
      { title: "定时关闭", placeHolder: "选择暂停时间" },
    );
    if (!picked?.minutes) {
      this.toast("已关闭定时暂停");
      return;
    }
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = undefined;
      void this.player.pause();
      this.toast("定时关闭：已暂停播放", "info");
    }, picked.minutes * 60 * 1000);
    this.toast(`${picked.label}`, "success");
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
        results.push({
          path: full,
          id: songId ?? -Math.abs(hashString(full)),
          songId,
          name: match ? match[2] : task?.name ?? stem,
          artists: match ? match[1] : task?.artists ?? "",
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
    register("neteaseMusic.openMyProfile", () => this.openMyProfile());
    register("neteaseMusic.openSettingsPanel", () => this.openSettings("account"));
    register("neteaseMusic.playlist.open", async (id: number) => this.openPlaylist(Number(id)));
    register("neteaseMusic.playPause", async () => {
      await this.ensureAudioHost();
      await this.player.toggle();
    });
    register("neteaseMusic.next", async () => {
      await this.ensureAudioHost();
      await this.player.next(true);
    });
    register("neteaseMusic.previous", async () => {
      await this.ensureAudioHost();
      await this.player.previous();
    });
    register("neteaseMusic.volumeUp", () => this.player.setVolume(this.player.state().volume + 0.05));
    register("neteaseMusic.volumeDown", () => this.player.setVolume(this.player.state().volume - 0.05));
    register("neteaseMusic.mute", () => this.toggleMute());
    register("neteaseMusic.qualityPicker", () => this.pickQuality());
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
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:dsh.netease-music"),
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

  private configureStatusBar(): void {
    const s = this.status;
    s.previous.text = "$(chevron-left)";
    s.previous.tooltip = "上一首";
    s.previous.command = "neteaseMusic.previous";
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
    s.queue.command = "neteaseMusic.openQueue";
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
      this.updateStatus();
    }, 650);
  }

  private updateStatus(): void {
    const state = this.player.state();
    const track = state.track;
    if (!track) {
      this.status.idle.hide();
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
      return;
    }
    this.status.idle.hide();
    this.status.previous.show();
    this.status.play.show();
    this.status.next.show();
    this.status.title.show();
    this.status.quality.show();
    this.status.volume.show();
    this.status.now.show();
    this.status.queue.show();
    this.status.settings.show();
    this.status.play.text = state.loading ? "$(loading~spin)" : state.playing ? "$(debug-pause)" : "$(play)";
    this.status.play.tooltip = state.playing ? "暂停" : state.loading ? "缓冲中…" : "播放";
    const artists = track.artists.map((artist) => artist.name).join(" / ");
    const full = `${track.name}${artists ? ` — ${artists}` : ""}`;
    if (full !== this.lastTitle) {
      this.lastTitle = full;
      this.marqueeOffset = 0;
    }
    const window = 22;
    let label = full;
    if (full.length > window) {
      const cycle = full.length + 3;
      const offset = this.marqueeOffset % cycle;
      const padded = `${full}   ${full}`;
      label = padded.slice(offset, offset + window);
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
    this.stopQr();
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
