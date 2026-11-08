import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Track, UserPlaylist } from "../api/types";

export interface FavoriteCacheEntry {
  updatedAt: number;
  trackIds: number[];
  tracks?: Track[];
}

export interface FavoriteCacheFile {
  updatedAt: number;
  playlists: UserPlaylist[];
  entries: Record<string, FavoriteCacheEntry>;
}

export function emptyFavoriteCache(): FavoriteCacheFile {
  return { updatedAt: 0, playlists: [], entries: {} };
}

export async function readFavoriteCache(dir: string): Promise<FavoriteCacheFile> {
  try {
    const text = await fs.readFile(path.join(dir, "netease-favorites.json"), "utf8");
    const data = JSON.parse(text) as FavoriteCacheFile;
    return {
      updatedAt: Number(data.updatedAt ?? 0),
      playlists: Array.isArray(data.playlists) ? data.playlists : [],
      entries: data.entries && typeof data.entries === "object" ? data.entries : {},
    };
  } catch {
    return emptyFavoriteCache();
  }
}

function csv(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeFavoriteCache(dir: string, data: FavoriteCacheFile, exportCsv = false): Promise<void> {
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "netease-favorites.json"), JSON.stringify(data), "utf8");
  if (!exportCsv) return;
  const lines = ["playlist_id,playlist_name,track_count,updated_at"];
  for (const [id, entry] of Object.entries(data.entries)) {
    const playlist = data.playlists.find((item) => String(item.id) === id);
    lines.push([id, csv(playlist?.name ?? ""), entry.trackIds.length, entry.updatedAt].join(","));
  }
  await fs.writeFile(path.join(dir, "netease-favorites.csv"), `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  const trackLines = ["playlist_id,playlist_name,track_id,track_name,artists"];
  for (const [id, entry] of Object.entries(data.entries)) {
    const playlist = data.playlists.find((item) => String(item.id) === id);
    for (const track of entry.tracks ?? []) {
      trackLines.push([
        id,
        csv(playlist?.name ?? ""),
        track.id,
        csv(track.name),
        csv(track.artists?.map((artist) => artist.name).join(" / ") ?? ""),
      ].join(","));
    }
  }
  await fs.writeFile(path.join(dir, "netease-library.csv"), `\uFEFF${trackLines.join("\r\n")}\r\n`, "utf8");
}

export function cacheContains(data: FavoriteCacheFile, playlistId: number, trackId: number): boolean {
  return Boolean(data.entries[String(playlistId)]?.trackIds.includes(trackId));
}

export function setCachedTracks(data: FavoriteCacheFile, playlistId: number, tracks: Track[], now = Date.now()): void {
  data.entries[String(playlistId)] = {
    updatedAt: now,
    trackIds: [...new Set(tracks.map((track) => track.id).filter((id) => Number.isFinite(id) && id > 0))],
    tracks,
  };
  data.updatedAt = now;
}
