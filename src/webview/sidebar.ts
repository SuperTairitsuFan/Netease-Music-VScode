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
let lastVolume = 0.8;

const NAV_ITEMS: Array<{ key: string; label: string; icon: string; nav: string }> = [
  { key: "recommend", label: "推荐", icon: "home", nav: "recommend" },
  { key: "featured", label: "精选", icon: "star", nav: "featured" },
  { key: "podcast", label: "播客", icon: "radio", nav: "podcast" },
  { key: "roam", label: "漫游", icon: "compass", nav: "roam" },
  { key: "following", label: "关注", icon: "users", nav: "following" },
];

function hideQualityPop(): void {
  const pop = qs<HTMLElement>("#quality-pop");
  if (pop) pop.hidden = true;
}

function hideSleepPop(): void {
  const pop = qs<HTMLElement>("#sleep-pop");
  if (pop) pop.hidden = true;
}

function confirmSleepTimer(): void {
  const hoursInput = qs<HTMLInputElement>("#sleep-hours");
  const minutesInput = qs<HTMLInputElement>("#sleep-minutes");
  const error = qs<HTMLElement>("#sleep-error");
  const hoursRaw = hoursInput?.value.trim() ?? "0";
  const minutesRaw = minutesInput?.value.trim() ?? "0";
  const hours = hoursRaw === "" ? 0 : Number(hoursRaw);
  const minutes = minutesRaw === "" ? 0 : Number(minutesRaw);
  if (!/^\d+$/.test(hoursRaw || "0") || !/^\d+$/.test(minutesRaw || "0") || hours < 0 || minutes < 0 || hours * 60 + minutes <= 0) {
    if (error) error.style.display = "block";
    (minutesInput ?? hoursInput)?.focus();
    (minutesInput ?? hoursInput)?.select();
    return;
  }
  if (error) error.style.display = "none";
  send("setSleepTimer", { minutes: hours * 60 + minutes });
  hideSleepPop();
}

function hideRatePop(): void {
  const pop = qs<HTMLElement>("#rate-pop");
  if (pop) pop.hidden = true;
}

function confirmRate(): void {
  const input = qs<HTMLInputElement>("#rate-input");
  const error = qs<HTMLElement>("#rate-error");
  const value = Number(input?.value.trim() ?? "");
  if (!Number.isFinite(value) || value < 0.5 || value > 3) {
    if (error) error.style.display = "block";
    input?.focus();
    input?.select();
    return;
  }
  if (error) error.style.display = "none";
  send("setPlaybackRate", { value });
  hideRatePop();
}

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
      <button class="icon-btn" data-act="volumePopup" title="音量（双击静音）">${icon("volume", 14)}</button>
      <div class="sleep-pop quality-pop" id="quality-pop" hidden>
        <div class="sleep-title">音质调节<button class="icon-btn quality-close" data-act="closeQuality" title="关闭">×</button></div>
        <button class="quality-option" data-act="setQuality" data-quality="standard"><span>标准</span><span class="quality-desc">128 kbps</span></button>
        <button class="quality-option" data-act="setQuality" data-quality="exhigh"><span>极高</span><span class="quality-desc">320 kbps</span></button>
        <button class="quality-option" data-act="setQuality" data-quality="lossless"><span>无损</span><span class="quality-desc">FLAC 16-bit</span></button>
        <button class="quality-option" data-act="setQuality" data-quality="hires"><span>高解析度无损</span><span class="quality-desc">Hi-Res 24-bit</span></button>
        <button class="quality-option" data-act="setQuality" data-quality="jyeffect"><span>高清臻音</span><span class="quality-desc">SVIP 24-bit</span></button>
        <button class="quality-option" data-act="setQuality" data-quality="jymaster"><span>超清母带</span><span class="quality-desc">SVIP 24-bit</span></button>
      </div>
      <div class="sleep-pop" id="sleep-pop" hidden>
        <div class="sleep-title">定时关闭</div>
        <div class="sleep-inputs">
          <label>时<input id="sleep-hours" type="number" min="0" step="1" inputmode="numeric" value="0" autocomplete="off"></label>
          <label>分<input id="sleep-minutes" type="number" min="0" step="1" inputmode="numeric" value="0" autocomplete="off"></label>
        </div>
        <div class="sleep-error" id="sleep-error">请输入非负整数，分钟可超过 60</div>
        <div class="sleep-actions"><button class="btn small" data-act="sleepCancel">取消</button><button class="btn small primary" data-act="sleepConfirm">确定</button></div>
      </div>
    </div>
      <div class="sleep-pop" id="rate-pop" hidden>
        <div class="sleep-title">播放速度</div>
        <input id="rate-input" type="number" min="0.5" max="3" step="0.05" inputmode="decimal" value="1" autocomplete="off">
        <div class="sleep-error" id="rate-error">请输入 0.5 到 3.0 之间的数字</div>
        <div class="sleep-actions"><button class="btn small" data-act="rateCancel">取消</button><button class="btn small primary" data-act="rateConfirm">确定</button></div>
      </div>
    <div class="volume-pop" id="volume-pop" hidden>
      <input id="volume-range" type="range" min="0" max="100" step="1" value="80" />
      <span id="volume-label">80%</span>
    </div>
  </div>`;
  document.addEventListener("keydown", (event) => {
    const input = event.target as HTMLElement | null;
    if (input?.id === "rate-input") {
      if (event.key === "Enter") { event.preventDefault(); confirmRate(); }
      if (event.key === "Escape") { event.preventDefault(); hideRatePop(); }
    }
    if (input?.id === "sleep-minutes" || input?.id === "sleep-hours") {
      if (event.key === "Enter") { event.preventDefault(); confirmSleepTimer(); }
      if (event.key === "Escape") { event.preventDefault(); hideSleepPop(); }
    }
  });
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.id !== "volume-range") return;
    const value = Number(target.value);
    const label = qs<HTMLElement>("#volume-label");
    if (label) label.textContent = `${value}%`;
    send("setVolume", { value });
  });
  document.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('[data-act="volumePopup"]')) return;
    event.preventDefault();
    const current = player?.volume ?? 0.8;
    if (current > 0) {
      lastVolume = current;
      send("setVolume", { value: 0 });
    } else {
      send("setVolume", { value: Math.round(Math.max(0.1, lastVolume) * 100) });
    }
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
    case "quality": {
      const volume = qs<HTMLElement>("#volume-pop");
      if (volume) volume.hidden = true;
      hideSleepPop();
      hideRatePop();
      const pop = qs<HTMLElement>("#quality-pop");
      if (!pop) break;
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        for (const btn of qsa<HTMLElement>("#quality-pop .quality-option")) {
          btn.classList.toggle("current", btn.dataset.quality === player?.quality);
        }
      }
      break;
    }
    case "closeQuality":
      hideQualityPop();
      break;
    case "setQuality":
      send("quality", { quality: el.dataset.quality });
      hideQualityPop();
      break;
    case "sleepTimer": {
      const volume = qs<HTMLElement>("#volume-pop");
      if (volume) volume.hidden = true;
      hideRatePop();
      hideQualityPop();
      const pop = qs<HTMLElement>("#sleep-pop");
      if (!pop) break;
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        const input = qs<HTMLInputElement>("#sleep-minutes");
        const hours = qs<HTMLInputElement>("#sleep-hours");
        if (hours) hours.value = "0";
        const mins = qs<HTMLInputElement>("#sleep-minutes");
        if (mins) mins.value = "0";
        input?.focus();
        input?.select();
      }
      break;
    }
    case "sleepCancel":
      hideSleepPop();
      break;
    case "sleepConfirm":
      confirmSleepTimer();
      break;
    case "playbackRate": {
      if (player?.output?.kind === "native") {
        toast("原生音频输出不支持变速，请切换到 WebAudio", "info");
        break;
      }
      const sleep = qs<HTMLElement>("#sleep-pop");
      if (sleep) sleep.hidden = true;
      const volume = qs<HTMLElement>("#volume-pop");
      if (volume) volume.hidden = true;
      const pop = qs<HTMLElement>("#rate-pop");
      if (!pop) break;
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        const input = qs<HTMLInputElement>("#rate-input");
        if (input) input.value = String(player?.rate ?? 1);
        input?.focus();
        input?.select();
      }
      break;
    }
    case "rateCancel":
      hideRatePop();
      break;
    case "rateConfirm":
      confirmRate();
      break;
    case "volumePopup": {
      const sleep = qs<HTMLElement>("#sleep-pop");
      if (sleep) sleep.hidden = true;
      hideRatePop();
      hideQualityPop();
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
        if (rate) {
          rate.textContent = `${(player.rate ?? 1).toFixed(2).replace(/0$/, "")}x`;
          const disabled = player.output?.kind === "native";
          rate.classList.toggle("disabled", disabled);
          rate.title = disabled ? "原生音频输出不支持变速" : "播放速度";
        }
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
        if ((player.volume ?? 0) > 0) lastVolume = player.volume;
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
