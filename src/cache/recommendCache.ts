import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HomeFeed } from "../api/types";

export interface RecommendCacheFile {
  date: string;
  accountId: number;
  home: HomeFeed;
}

export function todayKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export async function readRecommendCache(dir: string, accountId: number): Promise<HomeFeed | undefined> {
  try {
    const text = await fs.readFile(path.join(dir, "netease-recommend.json"), "utf8");
    const data = JSON.parse(text) as RecommendCacheFile;
    if (data.date !== todayKey() || Number(data.accountId) !== accountId) return undefined;
    return data.home;
  } catch {
    return undefined;
  }
}

export async function writeRecommendCache(dir: string, accountId: number, home: HomeFeed): Promise<void> {
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  const data: RecommendCacheFile = { date: todayKey(), accountId, home };
  await fs.writeFile(path.join(dir, "netease-recommend.json"), JSON.stringify(data), "utf8");
  const rows = ["section,track_id,name,artists,album"];
  const add = (section: string, tracks: { id: number; name: string; artists?: Array<{ name: string }>; album?: { name?: string } }[]) => {
    for (const track of tracks) {
      const esc = (value: unknown) => {
        const text = String(value ?? "");
        return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      rows.push([section, track.id, esc(track.name), esc(track.artists?.map((artist) => artist.name).join(" / ")), esc(track.album?.name)].join(","));
    }
  };
  add("daily", home.dailySongs);
  add("new", home.newSongs);
  add("roam", home.roamSongs);
  await fs.writeFile(path.join(dir, "netease-recommend.csv"), `\uFEFF${rows.join("\r\n")}\r\n`, "utf8");
}
