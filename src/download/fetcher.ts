import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  bytes: number;
  total: number;
}

/** Streams an HTTP(S) resource to disk atomically (`<dest>.part` then rename). */
export async function downloadToFile(url: string, dest: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: options.signal,
    headers: {
      "User-Agent": UA,
      Referer: "https://music.163.com/",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  if (!res.body) throw new Error("下载失败：响应没有内容");
  const total = Number(res.headers.get("content-length") ?? 0);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let received = 0;
  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    options.onProgress?.({ received, total });
  });
  try {
    await pipeline(stream, createWriteStream(tmp));
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { bytes: received, total };
}

export async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Referer: "https://music.163.com/" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadToGrowingFile(
  url: string,
  dest: string,
  donePath: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: options.signal,
    headers: { "User-Agent": UA, Referer: "https://music.163.com/", ...(options.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  if (!res.body) throw new Error("下载失败：响应没有内容");
  const total = Number(res.headers.get("content-length") ?? 0);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  let received = 0;
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    options.onProgress?.({ received, total });
  });
  try {
    await pipeline(stream, createWriteStream(dest));
    await fs.writeFile(donePath, "done");
  } catch (err) {
    await fs.writeFile(donePath, "error").catch(() => undefined);
    throw err;
  }
  return { bytes: received, total };
}
