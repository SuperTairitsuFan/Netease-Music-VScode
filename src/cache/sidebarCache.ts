import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SidebarState } from "../protocol";

export interface SidebarCacheFile {
  updatedAt: number;
  state: SidebarState;
}

export async function readSidebarCache(dir: string): Promise<SidebarState | undefined> {
  if (!dir) return undefined;
  try {
    const text = await fs.readFile(path.join(dir, "netease-sidebar.json"), "utf8");
    const data = JSON.parse(text) as SidebarCacheFile;
    return data.state;
  } catch {
    return undefined;
  }
}

function csv(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeSidebarCache(dir: string, state: SidebarState): Promise<void> {
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  const data: SidebarCacheFile = { updatedAt: Date.now(), state };
  await fs.writeFile(path.join(dir, "netease-sidebar.json"), JSON.stringify(data), "utf8");
  const rows = ["section,id,name,track_count,subscribed"];
  const add = (section: string, playlist: { id: number; name: string; trackCount: number; subscribed?: boolean } | null | undefined) => {
    if (!playlist) return;
    rows.push([section, playlist.id, csv(playlist.name), playlist.trackCount, playlist.subscribed ? 1 : 0].join(","));
  };
  add("liked", state.liked);
  for (const playlist of state.created) add("created", playlist);
  for (const playlist of state.subscribed) add("subscribed", playlist);
  await fs.writeFile(path.join(dir, "netease-sidebar.csv"), `\uFEFF${rows.join("\r\n")}\r\n`, "utf8");
}
