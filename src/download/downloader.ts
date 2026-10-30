import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionManager } from "../auth/session";
import type { MusicConfig, Quality } from "../config";
import { defaultMusicDir, QUALITY_LABELS } from "../config";
import type { DownloadTaskView } from "../protocol";
import type { Track } from "../api/types";
import { log } from "../util/logger";
import { downloadToFile } from "./fetcher";
import { writeId3 } from "./tags";

export type DownloadStatus = "queued" | "downloading" | "done" | "error" | "cancelled";

export interface DownloadTask {
  id: string;
  song: Track;
  quality: Quality;
  status: DownloadStatus;
  received: number;
  total: number;
  error?: string;
  filePath?: string;
  startedAt: number;
}

const STATE_KEY = "neteaseMusic.downloads.v1";

function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 120) || "未命名";
}

export class DownloadManager implements vscode.Disposable {
  private tasks: DownloadTask[] = [];
  private queue: string[] = [];
  private active = new Map<string, AbortController>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private lastNotify = 0;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly session: SessionManager,
    private readonly getConfig: () => MusicConfig,
  ) {
    const saved = ctx.globalState.get<DownloadTask[]>(STATE_KEY) ?? [];
    this.tasks = saved.map((t) => ({
      ...t,
      status: t.status === "downloading" || t.status === "queued" ? "error" : t.status,
      error: t.status === "downloading" || t.status === "queued" ? "扩展重启导致下载中断" : t.error,
      received: t.status === "done" ? t.total : t.received,
    }));
  }

  toViews(): DownloadTaskView[] {
    return this.tasks.map((t) => ({
      id: t.id,
      songId: t.song.id,
      name: t.song.name,
      artists: t.song.artists.map((a) => a.name).join(" / "),
      status: t.status,
      received: t.received,
      total: t.total,
      quality: QUALITY_LABELS[t.quality] ?? t.quality,
      error: t.error,
      path: t.filePath,
    }));
  }

  get dir(): string {
    return this.getConfig().download.dir || path.join(defaultMusicDir(), "网易云音乐");
  }

  async enqueue(song: Track, quality?: Quality): Promise<DownloadTask> {
    if (!this.session.snapshot().loggedIn) {
      // Free tracks still download fine anonymously; the URL call is what matters.
    }
    const task: DownloadTask = {
      id: `${song.id}-${Date.now()}`,
      song,
      quality:
        quality ??
        (this.getConfig().download.quality === "auto"
          ? this.getConfig().quality
          : (this.getConfig().download.quality as Quality)),
      status: "queued",
      received: 0,
      total: 0,
      startedAt: Date.now(),
    };
    this.tasks.unshift(task);
    this.queue.push(task.id);
    this.notify(true);
    void this.persist();
    this.pump();
    return task;
  }

  cancel(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status === "downloading") this.active.get(id)?.abort();
    if (task.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      task.status = "cancelled";
    }
    this.notify(true);
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter(
      (t) => t.status === "downloading" || t.status === "queued" || t.status === "error",
    );
    this.notify(true);
    void this.persist();
  }

  private pump(): void {
    const limit = Math.max(1, Math.min(4, this.getConfig().download.concurrent));
    while (this.active.size < limit && this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.find((t) => t.id === id);
      if (!task || task.status !== "queued") continue;
      const controller = new AbortController();
      this.active.set(id, controller);
      void this.run(task, controller)
        .catch((err) => {
          if (controller.signal.aborted) {
            task.status = "cancelled";
          } else {
            task.status = "error";
            task.error = (err as Error).message;
            log.warn("download failed", { id: task.id, error: (err as Error).message });
          }
        })
        .finally(() => {
          this.active.delete(id);
          this.notify(true);
          void this.persist();
          this.pump();
        });
    }
  }

  private async run(task: DownloadTask, controller: AbortController): Promise<void> {
    task.status = "downloading";
    this.notify(true);
    const url = await this.session.client.songUrl(task.song.id, task.quality);
    if (!url.url) throw new Error(url.code === 404 ? "无版权，无法下载" : "无法获取下载地址（可能需要登录或会员）");
    task.total = url.size || 0;
    const ext = url.type === "flac" ? "flac" : "mp3";
    const name = sanitize(this.renderTemplate(task.song, task.quality, ext));
    const filePath = path.join(this.dir, `${name}.${ext}`);
    await fs.mkdir(this.dir, { recursive: true });
    let last = 0;
    await downloadToFile(url.url, filePath, {
      signal: controller.signal,
      onProgress: (p) => {
        task.received = p.received;
        if (p.total) task.total = p.total;
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          this.notify();
        }
      },
    });
    task.status = "done";
    task.filePath = filePath;
    task.received = task.total || task.received;
    this.notify(true);

    void this.afterDownload(task, filePath, ext).catch((err) =>
      log.warn("post-download processing failed", String(err)),
    );
  }

  private async afterDownload(task: DownloadTask, filePath: string, ext: string): Promise<void> {
    const cfg = this.getConfig();
    if (cfg.download.writeMetadata && ext === "mp3") {
      await writeId3(filePath, {
        title: task.song.name,
        artist: task.song.artists.map((a) => a.name).join(" / "),
        album: task.song.album.name,
      });
    }
    if (cfg.download.saveLyric) {
      const lyric = await this.session.client.lyric(task.song.id).catch(() => null);
      if (lyric?.lrc) {
        const lrcPath = filePath.replace(/\.[^.]+$/, ".lrc");
        await fs.writeFile(lrcPath, lyric.lrc, "utf8");
      }
    }
  }

  private renderTemplate(song: Track, quality: Quality, ext: string): string {
    const template = this.getConfig().download.filenameTemplate || "{artists} - {name}";
    return template
      .replace(/\{name\}/g, song.name)
      .replace(/\{artists\}/g, song.artists.map((a) => a.name).join(", "))
      .replace(/\{album\}/g, song.album.name)
      .replace(/\{id\}/g, String(song.id))
      .replace(/\{quality\}/g, QUALITY_LABELS[quality] ?? quality)
      .replace(/\{ext\}/g, ext);
  }

  private notify(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastNotify < 200) return;
    this.lastNotify = now;
    this.emitter.fire();
  }

  private async persist(): Promise<void> {
    const slim = this.tasks.slice(0, 100).map((t) => ({
      ...t,
      song: {
        id: t.song.id,
        name: t.song.name,
        artists: t.song.artists,
        album: t.song.album,
        duration: t.song.duration,
      },
    }));
    await this.ctx.globalState.update(STATE_KEY, slim);
  }

  dispose(): void {
    for (const controller of this.active.values()) controller.abort();
    this.emitter.dispose();
  }
}
