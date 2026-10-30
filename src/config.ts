import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export type Quality = "standard" | "exhigh" | "lossless" | "hires" | "jyeffect" | "sky" | "jymaster";
export type OutputMode = "auto" | "webaudio" | "native";
export type PlayMode = "order" | "repeat" | "repeatOne" | "shuffle";

export interface MusicConfig {
  output: {
    mode: OutputMode;
    device: string;
    sampleRate: string;
    bitDepth: string;
    sampleFormat: string;
    exclusive: boolean;
    bufferMs: number;
    bitPerfect: boolean;
    backend: "wasapi" | "asio";
    streaming: boolean;
  };
  quality: Quality;
  download: {
    quality: Quality | "auto";
    dir: string;
    filenameTemplate: string;
    concurrent: number;
    writeMetadata: boolean;
    saveLyric: boolean;
  };
  cover: { dir: string; filenameTemplate: string };
  cache: { enabled: boolean; dir: string; maxSizeMB: number };
  localMusic: { dir: string };
  api: { baseUrl: string; timeout: number; userAgent: string; realIP: string; cookie: string };
  playback: { volume: number; mode: PlayMode; rememberQueue: boolean; autoPlay: boolean; backgroundPlay: boolean };
  ui: { theme: string; showLyrics: boolean; panels: Record<string, boolean>; compact: boolean; autoOpen: boolean };
  components: { dir: string; nativeEnginePath: string; verifyHash: boolean; downloadUrl: string; autoDownload: boolean };
}

export interface QualityOption {
  key: Quality;
  label: string;
  short: string;
  tier: "free" | "vip" | "svip";
  description: string;
  /** NetEase `level` strings that mean this option was actually granted. */
  levels: string[];
}

/**
 * PC 客户端「音质播放设置」里的七档。顺序即界面顺序。
 * 服务端仍可能按版权 / 会员权益降级，界面以返回的 `level` 为准。
 */
export const QUALITY_OPTIONS: QualityOption[] = [
  {
    key: "standard",
    label: "标准",
    short: "标准",
    tier: "free",
    description: "128 kbps · 节省流量",
    levels: ["standard", "higher"],
  },
  {
    key: "exhigh",
    label: "极高",
    short: "极高",
    tier: "vip",
    description: "320 kbps · VIP",
    levels: ["exhigh", "higher", "standard"],
  },
  {
    key: "lossless",
    label: "无损",
    short: "无损",
    tier: "vip",
    description: "FLAC 无损 · VIP",
    levels: ["lossless", "exhigh"],
  },
  {
    key: "hires",
    label: "高解析度无损",
    short: "Hi-Res",
    tier: "vip",
    description: "Hi-Res 高解析度 · VIP",
    levels: ["hires", "lossless"],
  },
  {
    key: "jyeffect",
    label: "高清臻音",
    short: "臻音",
    tier: "svip",
    description: "高清臻音 · SVIP",
    levels: ["jyeffect", "hires"],
  },
  {
    key: "sky",
    label: "沉浸环绕声",
    short: "环绕",
    tier: "svip",
    description: "沉浸环绕声 · SVIP",
    levels: ["sky", "jyeffect"],
  },
  {
    key: "jymaster",
    label: "超清母带",
    short: "母带",
    tier: "svip",
    description: "超清母带 · SVIP",
    levels: ["jymaster", "hires"],
  },
];

export const QUALITY_ORDER: Quality[] = QUALITY_OPTIONS.map((option) => option.key);

export const QUALITY_LABELS: Record<string, string> = Object.fromEntries(
  QUALITY_OPTIONS.map((option) => [option.key, option.label]),
) as Record<string, string>;

export const QUALITY_SHORT: Record<string, string> = Object.fromEntries(
  QUALITY_OPTIONS.map((option) => [option.key, option.short]),
) as Record<string, string>;

/** Extra labels the server can return even if they are not selectable anymore. */
QUALITY_LABELS.higher = "较高";
QUALITY_LABELS.jymaster = "超清母带";
QUALITY_SHORT.higher = "较高";

export const SONG_LEVEL_LABELS: Record<string, string> = {
  standard: "标准",
  higher: "较高",
  exhigh: "极高",
  lossless: "无损",
  hires: "Hi-Res",
  jyeffect: "高清臻音",
  sky: "沉浸环绕声",
  jymaster: "超清母带",
  none: "",
};

export function normalizeQuality(value: string | undefined): Quality {
  if (value && QUALITY_ORDER.includes(value as Quality)) return value as Quality;
  if (value === "higher") return "exhigh";
  return "exhigh";
}

export function getConfig(): MusicConfig {
  const c = vscode.workspace.getConfiguration("neteaseMusic");
  return {
    output: {
      mode: (c.get<string>("output.mode") ?? "auto") as OutputMode,
      device: c.get<string>("output.device") ?? "",
      sampleRate: c.get<string>("output.sampleRate") ?? "auto",
      bitDepth: c.get<string>("output.bitDepth") ?? "auto",
      sampleFormat: c.get<string>("output.sampleFormat") ?? "auto",
      exclusive: c.get<boolean>("output.exclusive") ?? true,
      bufferMs: c.get<number>("output.bufferMs") ?? 10,
      bitPerfect: c.get<boolean>("output.bitPerfect") ?? false,
      backend: c.get<string>("output.backend") === "asio" ? "asio" : "wasapi",
      streaming: c.get<boolean>("output.streaming") ?? true,
    },
    quality: normalizeQuality(c.get<string>("quality")),
    download: {
      quality: (() => {
        const value = c.get<string>("download.quality") ?? "auto";
        return value === "auto" ? "auto" : normalizeQuality(value);
      })(),
      dir: c.get<string>("download.dir") ?? "",
      filenameTemplate: c.get<string>("download.filenameTemplate") ?? "{artist} - {name}",
      concurrent: Math.max(1, Math.min(4, c.get<number>("download.concurrent") ?? 2)),
      writeMetadata: c.get<boolean>("download.writeMetadata") ?? true,
      saveLyric: c.get<boolean>("download.saveLyric") ?? true,
    },
    cover: {
      dir: c.get<string>("cover.dir") ?? "",
      filenameTemplate: c.get<string>("cover.filenameTemplate") ?? "{name} - {artist}",
    },
    cache: {
      enabled: c.get<boolean>("cache.enabled") ?? true,
      dir: c.get<string>("cache.dir") ?? "",
      maxSizeMB: Math.max(64, c.get<number>("cache.maxSizeMB") ?? 1024),
    },
    localMusic: {
      dir: c.get<string>("localMusic.dir") ?? "",
    },
    api: {
      baseUrl: (c.get<string>("api.baseUrl") ?? "https://interface.music.163.com").replace(/\/+$/, ""),
      timeout: c.get<number>("api.timeout") ?? 15000,
      userAgent: c.get<string>("api.userAgent") ?? "",
      realIP: c.get<string>("api.realIP") ?? "",
      cookie: c.get<string>("api.cookie") ?? "",
    },
    playback: {
      volume: Math.max(0, Math.min(100, c.get<number>("playback.volume") ?? 80)),
      mode: (c.get<string>("playback.mode") ?? "order") as PlayMode,
      rememberQueue: c.get<boolean>("playback.rememberQueue") ?? true,
      autoPlay: c.get<boolean>("playback.autoPlay") ?? false,
      backgroundPlay: c.get<boolean>("playback.backgroundPlay") ?? true,
    },
    ui: {
      theme: c.get<string>("ui.theme") ?? "auto",
      showLyrics: c.get<boolean>("ui.showLyrics") ?? true,
      panels: c.get<Record<string, boolean>>("ui.panels") ?? {},
      compact: c.get<boolean>("ui.compact") ?? false,
      autoOpen: c.get<boolean>("ui.autoOpen") ?? true,
    },
    components: {
      dir: c.get<string>("components.dir") ?? "",
      nativeEnginePath: c.get<string>("components.nativeEnginePath") ?? "",
      verifyHash: c.get<boolean>("components.verifyHash") ?? true,
      downloadUrl: c.get<string>("components.downloadUrl") ?? "",
      autoDownload: c.get<boolean>("components.autoDownload") ?? true,
    },
  };
}

export function defaultMusicDir(): string {
  const home = os.homedir();
  const xdg = process.env.XDG_MUSIC_DIR;
  if (xdg) return path.join(xdg, "NetEaseMusic");
  switch (process.platform) {
    case "win32": {
      const profile = process.env.USERPROFILE || home;
      return path.join(profile, "Music", "NetEaseMusic");
    }
    case "darwin":
      return path.join(home, "Music", "NetEaseMusic");
    default:
      return path.join(home, "Music", "NetEaseMusic");
  }
}

export function defaultCacheDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, "cache", "audio");
}

export function defaultComponentsDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, "components");
}
