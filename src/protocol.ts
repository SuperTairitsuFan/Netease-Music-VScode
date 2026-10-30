import type {
  Account,
  AlbumDetail,
  ArtistDetail,
  ArtistRef,
  Comment,
  DjRadio,
  HomeFeed,
  PlaylistDetail,
  PlaylistRef,
  SearchResult,
  SongPage,
  Subscriber,
  Toplist,
  Track,
  UserPage,
} from "./api/types";
import type { MusicConfig, PlayMode, Quality, QualityOption } from "./config";

export type WebviewSurface = "sidebar" | "main" | "settings" | "extras";

export interface NativeFormatView {
  sampleRate: number;
  bits: number;
  channels: number;
  sampleFormat: string;
}

export interface OutputView {
  kind: "webaudio" | "native" | "none";
  label: string;
  detail: string;
  backend?: string;
  format?: NativeFormatView;
  deviceName?: string;
  unavailableReason?: string;
}

export interface PlayerState {
  track: Track | null;
  playing: boolean;
  loading: boolean;
  /** seconds */
  position: number;
  /** seconds */
  duration: number;
  /** seconds buffered by the audio element; 0 when unknown */
  buffered?: number;
  /** playback rate, 1 = normal */
  rate: number;
  volume: number;
  mode: PlayMode;
  quality: Quality;
  /** quality actually granted by the server for the current stream */
  actualQuality: string;
  liked: boolean;
  /** all locally known liked song ids (used by sorting/filtering) */
  likedIds: number[];
  error: string | null;
  output: OutputView;
  queueLength: number;
  index: number;
  preparing: number;
}

export interface SettingsView {
  quality: Quality;
  downloadQuality: string;
  downloadDir: string;
  coverDir: string;
  coverFilenameTemplate: string;
  cacheDir: string;
  localMusicDir: string;
  componentsDir: string;
  outputMode: string;
  device: string;
  sampleRate: string;
  bitDepth: string;
  sampleFormat: string;
  exclusive: boolean;
  bitPerfect: boolean;
  nativeBackend: "wasapi" | "asio";
  bufferMs: number;
  volume: number;
  mode: string;
  backgroundPlay: boolean;
  autoPlay: boolean;
  rememberQueue: boolean;
  themeMode: string;
  compact: boolean;
  showLyrics: boolean;
  autoOpen: boolean;
  nativeEnginePath: string;
  verifyHash: boolean;
  autoDownload: boolean;
  downloadUrl: string;
  filenameTemplate: string;
  downloadConcurrent: number;
  writeMetadata: boolean;
  saveLyric: boolean;
  cacheEnabled: boolean;
  cacheMaxSizeMB: number;
}

export interface ComponentView {
  id: string;
  removable: boolean;
  name: string;
  version: string;
  kind: string;
  description?: string;
  status: "ready" | "disabled" | "invalid" | "incompatible" | "removed";
  enabled: boolean;
  bundled: boolean;
  platform: string;
  arch: string;
  entry: string;
  dir: string;
  hashOk: boolean;
  reason?: string;
  formats?: NativeFormatView[];
  backend?: string;
}

export interface NativeStatusView {
  installed: boolean;
  enabled: boolean;
  ready: boolean;
  path?: string;
  version?: string;
  backend?: string;
  reason?: string;
  devices?: Array<{
    id: string;
    name: string;
    backend: string;
    isDefault: boolean;
    formats: NativeFormatView[];
  }>;
}

export interface DownloadTaskView {
  id: string;
  songId: number;
  name: string;
  artists: string;
  status: "queued" | "downloading" | "done" | "error" | "cancelled";
  received: number;
  total: number;
  quality: string;
  error?: string;
  path?: string;
}

export type SearchKind = "all" | "song" | "playlist" | "album" | "artist" | "user" | "lyric" | "radio";

export interface SearchView {
  query: string;
  kind: SearchKind;
  songs: Track[];
  playlists: PlaylistRef[];
  albums?: import("./api/types").AlbumRef[];
  artists?: import("./api/types").ArtistRef[];
  users?: import("./api/types").UserProfile[];
  lyrics?: import("./api/types").LyricHit[];
  radios?: import("./api/types").DjRadio[];
  loading: boolean;
  error?: string;
  total?: number;
}

export interface CommentsView {
  total: number;
  hot: Comment[];
  comments: Comment[];
  loading: boolean;
  more: boolean;
  offset: number;
  error?: string;
}

export interface SubscribersView {
  total: number;
  subscribers: Subscriber[];
  loading: boolean;
  more: boolean;
  offset: number;
  error?: string;
}

export interface LocalTrackView {
  path: string;
  /** negative local hash, or the original NetEase song id when known */
  id: number;
  songId?: number;
  name: string;
  artists: string;
  album: string;
  size: number;
  ext: string;
}

export type NavKey = "recommend" | "featured" | "podcast" | "roam" | "following" | "recent" | "collections" | "downloads" | "local" | "cloud" | "liked";

export type PageKind =
  | "recommend"
  | "featured"
  | "podcast"
  | "roam"
  | "following"
  | "playlist"
  | "song"
  | "user"
  | "album"
  | "artist"
  | "radioDetail"
  | "artistSongs"
  | "search"
  | "queue"
  | "downloads"
  | "recent"
  | "collections"
  | "local"
  | "cloud"
  | "now";

export type PageTab = "songs" | "comments" | "subscribers";

export interface PageView {
  kind: PageKind;
  title: string;
  subtitle?: string;
  loading?: boolean;
  error?: string;
  activeTab?: PageTab;
  home?: HomeFeed;
  playlist?: PlaylistDetail;
  song?: SongPage;
  user?: UserPage;
  album?: AlbumDetail;
  artist?: ArtistDetail;
  artistAll?: Track[];
  artistAllTotal?: number;
  artistAllOffset?: number;
  artistAllHasMore?: boolean;
  artistAllLoading?: boolean;
  radio?: import("./api/types").DjRadio;
  radioPrograms?: Track[];
  search?: SearchView;
  comments?: CommentsView;
  subscribers?: SubscribersView;
  recent?: Track[];
  collections?: PlaylistRef[];
  local?: LocalTrackView[];
  cloud?: Track[];
  roam?: Track[];
  following?: ArtistRef[];
}

export interface SidebarState {
  account: Account | null;
  liked: PlaylistRef | null;
  created: PlaylistRef[];
  subscribed: PlaylistRef[];
  counts: {
    liked: number;
    recent: number;
    downloads: number;
    local: number;
    cloud: number;
  };
  active: string;
  collapsed: Record<string, boolean>;
  version: string;
}

export interface SettingsState {
  account: Account | null;
  settings: SettingsView;
  qualityOptions: QualityOption[];
  components: ComponentView[];
  native: NativeStatusView;
  activeTab: string;
  version: string;
  platform: string;
  arch: string;
  loggedIn: boolean;
  vip: "none" | "vip" | "svip";
}

export interface InitState {
  player: PlayerState;
  account: Account | null;
  queue: Track[];
  settings: SettingsView;
  page: PageView;
  panels: Record<string, boolean>;
  components: ComponentView[];
  native: NativeStatusView;
  downloads: DownloadTaskView[];
  showLyrics: boolean;
  compact: boolean;
  theme: string;
  version: string;
  platform: string;
  arch: string;
}

export interface LoadRequest {
  song: Track;
  /** remote URL (WebAudio path) */
  url?: string;
  /** vscode-webview resource URI for a cached local file (native decode path) */
  localUri?: string;
  native: boolean;
  /** local file playback: no URL resolution, no native engine */
  local?: boolean;
  position: number;
  volume: number;
  duration: number;
  gain?: number;
  trialEnd?: number;
  sourceSampleRate?: number;
  /** source bit depth when known (16/24/32) */
  sourceBits?: number;
  /** use integer PCM frames (bit-perfect path) */
  integerPcm?: boolean;
}

export type HostMessage =
  | { type: "init"; state: InitState }
  | { type: "sidebarInit"; state: SidebarState }
  | { type: "settingsInit"; state: SettingsState }
  | { type: "state"; state: PlayerState }
  | { type: "page"; page: PageView }
  | { type: "lyric"; songId: number; lrc: string; translation: string }
  | { type: "comments"; view: CommentsView }
  | { type: "subscribers"; view: SubscribersView }
  | { type: "account"; account: Account | null }
  | { type: "sidebar"; state: SidebarState }
  | { type: "settings"; settings: SettingsView }
  | { type: "queue"; tracks: Track[]; index: number }
  | { type: "queuePopup"; open: boolean }
  | { type: "downloads"; tasks: DownloadTaskView[] }
  | { type: "components"; items: ComponentView[]; native: NativeStatusView }
  | { type: "engineInfo"; info: NativeStatusView }
  | { type: "toast"; kind: "info" | "error" | "success"; message: string }
  | { type: "load"; request: LoadRequest }
  | { type: "control"; action: "play" | "pause" | "stop" | "seek" | "volume" | "rate"; value?: number }
  | { type: "nativeReady"; songId: number; format: NativeFormatView; maxChunkFrames: number }
  | { type: "nativePcmAck"; seq: number }
  | { type: "nativeFallback"; songId: number; reason: string }
  | { type: "playerError"; message: string }
  | { type: "theme"; kind: string }
  | { type: "qr"; dataUrl: string; qrContent: string; code: number; message: string }
  | { type: "loginResult"; ok: boolean; message: string }
  | { type: "openLogin" }
  | { type: "switchTab"; tab: string }
  | { type: "favoritePicker"; trackId: number; playlists: PlaylistRef[] }
  | { type: "playlists"; state: SidebarState };

export type WebviewCommand =
  | "ready"
  | "nav"
  | "openPlaylist"
  | "openSongDetail"
  | "openSongComments"
  | "postComment"
  | "openUser"
  | "openMyProfile"
  | "openArtistByName"
  | "fixSampleRate"
  | "openLiked"
  | "openRecent"
  | "openCollections"
  | "openDownloads"
  | "openLocal"
  | "openCloud"
  | "openSettings"
  | "createPlaylist"
  | "deletePlaylist"
  | "movePlaylist"
  | "setVolume"
  | "openMain"
  | "openNow"
  | "openQueue"
  | "openAlbum"
  | "openArtist"
  | "openArtistSongs"
  | "loadMoreArtistSongs"
  | "openRadio"
  | "playTrack"
  | "playQueueIndex"
  | "playAll"
  | "playNext"
  | "enqueueTrack"
  | "enqueuePlaylist"
  | "removeFromQueue"
  | "clearQueue"
  | "playPause"
  | "next"
  | "previous"
  | "seek"
  | "volume"
  | "mode"
  | "quality"
  | "qualityPicker"
  | "sleepTimer"
  | "playbackRate"
  | "playlistSubscribe"
  | "downloadQuality"
  | "search"
  | "searchKind"
  | "likeTrack"
  | "openFavorite"
  | "favoriteTo"
  | "removeFromPlaylist"
  | "back"
  | "downloadTrack"
  | "downloadCover"
  | "downloadCurrent"
  | "cancelDownload"
  | "clearDownloads"
  | "openDownloadDir"
  | "login"
  | "qrStart"
  | "phoneLogin"
  | "emailLogin"
  | "sendCaptcha"
  | "logout"
  | "refreshAccount"
  | "refreshPage"
  | "tab"
  | "loadComments"
  | "loadSubscribers"
  | "playLocal"
  | "copy"
  | "openLink"
  | "setConfig"
  | "setPanel"
  | "chooseDir"
  | "openConfigFile"
  | "openVscodeSettings"
  | "openDocs"
  | "showLog"
  | "refreshComponents"
  | "installComponent"
  | "enableComponent"
  | "disableComponent"
  | "removeComponent"
  | "verifyComponent"
  | "locateComponent"
  | "restoreBundled"
  | "openComponentDir"
  | "probeAudio"
  | "selectDevice"
  | "extras";

export type WebviewMessage =
  | { type: "ready" }
  | { type: "cmd"; cmd: WebviewCommand; payload?: any }
  | { type: "time"; position: number; duration: number; buffered?: number }
  | { type: "ended" }
  | { type: "loadError"; message: string }
  | { type: "nativeBegin"; songId: number; sampleRate: number; channels: number; length: number; bits: number; integer?: boolean }
  | { type: "pcm"; seq: number; data: string; frames: number }
  | { type: "pcmInt"; seq: number; data: string; frames: number; bits: number }
  | { type: "pcmDone"; songId: number; totalFrames: number }
  | { type: "decodeError"; message: string }
  | { type: "nativeFallbackLocal"; reason: string };

export type { MusicConfig, PlayMode, Quality, QualityOption, SearchResult, Toplist, DjRadio };
