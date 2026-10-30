import type { Account, PlaylistRef, Track } from "../api/types";
import type {
  HostMessage,
  PlayerState,
  SidebarState,
  WebviewCommand,
  WebviewMessage,
} from "../protocol";
import { AudioEngine } from "./audio";
import { cover, esc, qs, qsa } from "./dom";
import { icon } from "./icons";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const send = (cmd: WebviewCommand, payload?: unknown): void => vscode.postMessage({ type: "cmd", cmd, payload });
const audio = new AudioEngine((message) => vscode.postMessage(message));

const app = document.getElementById("app")!;
const logo = app.dataset.logo ?? "";

let state: SidebarState | null = null;
let player: PlayerState | null = null;
let account: Account | null = null;

const NAV_ITEMS: Array<{ key: string; label: string; icon: string; nav: string }> = [
  { key: "recommend", label: "推荐", icon: "home", nav: "recommend" },
  { key: "featured", label: "精选", icon: "star", nav: "featured" },
  { key: "podcast", label: "播客", icon: "radio", nav: "podcast" },
  { key: "roam", label: "漫游", icon: "compass", nav: "roam" },
  { key: "following", label: "关注", icon: "users", nav: "following" },
];

function boot(): void {
  app.innerHTML = `<div class="sidebar">
    <div class="sb-head">
      <div class="sb-brand">${logo ? `<img src="${esc(logo)}" alt="">` : ""}<span>网易云音乐</span></div>
      <span class="spacer"></span>
      <div class="sb-head-actions">
        <button class="icon-btn" data-act="refresh" title="刷新">${icon("refresh", 14)}</button>
      </div>
    </div>
    <div class="sb-scroll" id="sb-scroll"></div>
    <div class="sb-footer">
      <button class="icon-btn quality-btn" data-act="quality" title="音质调节">${icon("music", 14)}<span id="side-quality">极高</span></button>
      <button class="icon-btn" data-act="sleepTimer" title="定时关闭">${icon("clock", 14)}</button>
      <button class="icon-btn rate-btn" data-act="playbackRate" title="播放速度">1.0x</button>
      <button class="icon-btn" data-act="volumePopup" title="音量">${icon("volume", 14)}</button>
    </div>
    <div class="volume-pop" id="volume-pop" hidden>
      <input id="volume-range" type="range" min="0" max="100" step="1" value="80" />
      <span id="volume-label">80%</span>
    </div>
  </div>`;
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.id !== "volume-range") return;
    const value = Number(target.value);
    const label = qs<HTMLElement>("#volume-label");
    if (label) label.textContent = `${value}%`;
    send("setVolume", { value });
  });
  vscode.postMessage({ type: "ready" });
}

function onClick(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const groupTitle = target.closest<HTMLElement>("[data-group]");
  if (groupTitle && !target.closest("[data-act]")) {
    const group = groupTitle.dataset.group ?? "";
    const element = groupTitle.closest<HTMLElement>(".sb-group");
    if (element) {
      const collapsed = element.classList.toggle("collapsed");
      send("setPanel", { key: `sidebar.${group}`, open: !collapsed });
    }
    return;
  }
  const el = target.closest<HTMLElement>("[data-act]");
  if (!el) return;
  const act = el.dataset.act ?? "";
  switch (act) {
    case "nav":
      send("nav", { nav: el.dataset.nav ?? "recommend" });
      break;
    case "openPlaylist":
      send("openPlaylist", { id: Number(el.dataset.id) });
      break;
    case "createPlaylist":
      send("createPlaylist");
      break;
    case "deletePlaylist":
      send("deletePlaylist", { id: Number(el.dataset.id) });
      break;
    case "movePlaylist":
      send("movePlaylist", { id: Number(el.dataset.id), direction: Number(el.dataset.direction ?? 0) });
      break;
    case "openLiked":
      send("openLiked");
      break;
    case "openRecent":
      send("openRecent");
      break;
    case "openCollections":
      send("openCollections");
      break;
    case "openDownloads":
      send("openDownloads");
      break;
    case "openLocal":
      send("openLocal");
      break;
    case "openCloud":
      send("openCloud");
      break;
    case "openSettings":
      send("openSettings", { tab: "account" });
      break;
    case "openComponents":
      send("openSettings", { tab: "components" });
      break;
    case "openMain":
      send("openMain");
      break;
    case "lyricsOverlay":
      send("openNow");
      break;
    case "quality":
      send("qualityPicker");
      break;
    case "sleepTimer":
      send("sleepTimer");
      break;
    case "playbackRate":
      send("playbackRate");
      break;
    case "volumePopup": {
      const pop = qs<HTMLElement>("#volume-pop");
      if (pop) pop.hidden = !pop.hidden;
      break;
    }
    case "openMyProfile":
      send("openMyProfile");
      break;
    case "openNow":
      send("openNow");
      break;
    case "login":
      send("login");
      break;
    case "refresh":
      send("refreshPage");
      break;
    case "playPause":
      send("playPause");
      break;
    case "next":
      send("next");
      break;
    case "previous":
      send("previous");
      break;
    default:
      break;
  }
}

function render(): void {
  const scroll = qs("#sb-scroll");
  if (!scroll || !state) return;
  const panels = state.collapsed ?? {};
  const group = (key: string, title: string, body: string, extra = ""): string => {
    const collapsed = panels[`sidebar.${key}`] === false;
    return `<div class="sb-group ${collapsed ? "collapsed" : ""}">
      <div class="sb-group-title" data-group="${key}"><span class="chev">${icon("chevronDown", 11)}</span>${title}${extra}</div>
      <div class="sb-group-body">${body}</div>
    </div>`;
  };
  const navActive = (key: string): string => (state?.active === key ? " active" : "");
  const nav = NAV_ITEMS.map(
    (item) => `<button class="nav-item${navActive(item.key)}" data-act="nav" data-nav="${item.nav}">
      <span class="ico">${icon(item.icon, 15)}</span><span class="label">${item.label}</span>
    </button>`,
  ).join("");
  const liked = state.liked;
  const myMusic = `
    <button class="nav-item liked${navActive("liked")}" data-act="openLiked">
      <span class="ico">${icon("heart", 15)}</span><span class="label">我喜欢的音乐</span>
      <span class="count">${liked ? liked.trackCount : 0}</span>
    </button>
    <button class="nav-item${navActive("recent")}" data-act="openRecent">
      <span class="ico">${icon("clock", 15)}</span><span class="label">最近播放</span>
      <span class="count">${state.counts.recent || ""}</span>
    </button>
    <button class="nav-item${navActive("collections")}" data-act="openCollections">
      <span class="ico">${icon("star", 15)}</span><span class="label">我的收藏</span>
    </button>
    <button class="nav-item${navActive("downloads")}" data-act="openDownloads">
      <span class="ico">${icon("download", 15)}</span><span class="label">下载管理</span>
      ${state.counts.downloads ? `<span class="badge">${state.counts.downloads}</span>` : ""}
    </button>
    <button class="nav-item${navActive("local")}" data-act="openLocal">
      <span class="ico">${icon("folder", 15)}</span><span class="label">本地音乐</span>
      <span class="count">${state.counts.local || ""}</span>
    </button>
    <button class="nav-item${navActive("cloud")}" data-act="openCloud">
      <span class="ico">${icon("cloud", 15)}</span><span class="label">我的音乐网盘</span>
    </button>`;
  const accountRow = account
    ? `<div class="sb-account" data-act="openMyProfile" title="查看我的主页">
        ${account.avatarUrl ? `<img src="${esc(cover(account.avatarUrl, 60))}" alt="">` : `<span class="avatar-placeholder">${icon("login", 15)}</span>`}
        <div style="min-width:0">
          <div class="name">${esc(account.nickname)}</div>
          <div class="sub">${account.vipType && account.vipType > 0 ? (account.vipType >= 10 ? "SVIP 会员" : "VIP 会员") : "网易云音乐用户"}</div>
        </div>
      </div>`
    : `<div class="sb-account" data-act="login" title="登录网易云音乐">
        <span class="avatar-placeholder">${icon("login", 15)}</span>
        <div style="min-width:0">
          <div class="name">未登录</div>
          <div class="sub">登录后同步歌单与会员音质</div>
        </div>
      </div>`;
  const playlistItem = (playlist: PlaylistRef, likedStyle = false, editable = false, index = 0): string => `<div class="pl-item${state?.active === `playlist:${playlist.id}` ? " active" : ""}${likedStyle ? " liked" : ""}" data-act="openPlaylist" data-id="${playlist.id}" title="${esc(playlist.name)}">
    <img src="${esc(cover(playlist.coverImgUrl, 60))}" alt="">
    <span class="meta">
      <span class="name">${esc(playlist.name)}</span>
      <span class="sub">${playlist.trackCount} 首</span>
    </span>
    ${editable ? `<span class="pl-actions">
      <button class="icon-btn" data-act="movePlaylist" data-id="${playlist.id}" data-direction="-1" title="上移">↑</button>
      <button class="icon-btn" data-act="movePlaylist" data-id="${playlist.id}" data-direction="1" title="下移">↓</button>
      <button class="icon-btn" data-act="deletePlaylist" data-id="${playlist.id}" title="删除歌单">${icon("trash", 11)}</button>
    </span>` : ""}
  </div>`;
  const created = state.created.length
    ? state.created.map((playlist, index) => playlistItem(playlist, false, true, index)).join("")
    : `<div class="pl-empty">${account ? "还没有创建歌单" : "登录后显示你创建的歌单"}</div>`;
  const subscribed = state.subscribed.length
    ? state.subscribed.map((playlist) => playlistItem(playlist)).join("")
    : `<div class="pl-empty">${account ? "还没有收藏歌单" : "登录后显示收藏的歌单"}</div>`;
  scroll.innerHTML = `${accountRow}
    ${group("nav", "导航", nav)}
    ${group("my", "我的音乐", myMusic)}
    ${group("created", "创建的歌单", created, `<span style="margin-left:auto;display:flex;align-items:center;gap:4px"><span class="count">${state.created.length}</span><button class="icon-btn" data-act="createPlaylist" title="新建歌单">${icon("plus", 12)}</button></span>`)}
    ${group("subscribed", "收藏的歌单", subscribed, state.subscribed.length ? `<span class="count" style="margin-left:auto">${state.subscribed.length}</span>` : "")}`;
  updateLoginButton();
}

function updateLoginButton(): void {
  const button = qs<HTMLElement>("#login-btn");
  if (!button) return;
  button.innerHTML = account ? icon("account", 14) : icon("login", 14);
  button.title = account ? "账户设置" : "登录网易云音乐";
  button.dataset.act = account ? "openSettings" : "login";
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "sidebarInit":
      state = msg.state;
      account = state.account;
      render();
      break;
    case "sidebar":
    case "playlists":
      state = msg.state;
      account = state.account;
      render();
      break;
    case "state":
      player = msg.state;
      {
        const rate = qs<HTMLElement>(".rate-btn");
        if (rate) rate.textContent = `${(player.rate ?? 1).toFixed(2).replace(/0$/, "")}x`;
        const quality = qs<HTMLElement>("#side-quality");
        if (quality) {
          const labels: Record<string, string> = {
            standard: "标准",
            exhigh: "极高",
            lossless: "无损",
            hires: "Hi-Res",
            jyeffect: "臻音",
            sky: "环绕",
            jymaster: "母带",
          };
          quality.textContent = labels[player.quality] ?? player.quality;
        }
        const volume = qs<HTMLInputElement>("#volume-range");
        const volumeLabel = qs<HTMLElement>("#volume-label");
        if (volume) volume.value = String(Math.round((player.volume ?? 0.8) * 100));
        if (volumeLabel) volumeLabel.textContent = `${Math.round((player.volume ?? 0.8) * 100)}%`;
      }
      break;
    case "account":
      account = msg.account;
      if (state) state.account = account;
      render();
      break;
    case "theme":
      document.body.dataset.theme = msg.kind;
      break;
    case "toast":
      toast(msg.message, msg.kind);
      break;
    case "load":
      void audio.load(msg.request);
      break;
    case "control":
      audio.control(msg.action, msg.value);
      break;
    case "nativeReady":
      audio.onNativeReady(msg);
      break;
    case "nativeFallback":
      audio.onHostFallback(msg.songId, msg.reason);
      break;
    case "nativePcmAck":
      audio.onAck(msg.seq);
      break;
    case "playerError":
      audio.onPlayerError();
      break;
    case "openLogin":
      send("login");
      break;
  }
});

function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  let box = qs(".toasts");
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    document.body.appendChild(box);
  }
  box.appendChild(item);
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(() => item.remove(), 4000);
}

boot();
