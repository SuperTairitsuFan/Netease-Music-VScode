import "./webview.css";
import type { Account, AlbumDetail, ArtistDetail, Comment, PlaylistRef, SongPage, Track, UserPage } from "../api/types";
import type { PlaybackSource } from "../protocol";
import { parseLrc } from "../api/normalize";
import type {
  CommentsView,
  HostMessage,
  InitState,
  LocalTrackView,
  PageView,
  PlayerState,
  SearchView,
  SubscribersView,
  WebviewCommand,
  WebviewMessage,
} from "../protocol";
import { cover, esc, fmtCount, fmtDate, fmtDateTime, fmtTime, QUALITY_TEXT, qs, qsa } from "./dom";
import { icon } from "./icons";
import { AudioEngine } from "./audio";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const editorAudio = new AudioEngine((msg) => vscode.postMessage(msg));
const send = (cmd: WebviewCommand, payload?: unknown): void => vscode.postMessage({ type: "cmd", cmd, payload });

const app = document.getElementById("app")!;
const logo = app.dataset.logo ?? "";

let player: PlayerState | null = null;
let account: Account | null = null;
let queue: Track[] = [];
let queueSources: Array<PlaybackSource | null> = [];
let page: PageView = { kind: "recommend", title: "推荐", loading: true };
let comments: CommentsView | null = null;
let subscribers: SubscribersView | null = null;
let downloads: import("../protocol").DownloadTaskView[] = [];
let lyric = { lrc: "", translation: "" };
let lyricLines: Array<{ time: number; text: string; translation?: string }> = [];
let lastTrackId = 0;
let lastLyricIndex = -1;
let songLyricIndex = -1;
let songLyricTrackId = 0;
let lyricManualUntil = 0;
let lyricManualTimer: ReturnType<typeof setTimeout> | undefined;
let likedIds = new Set<number>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let contextTrack: Track | null = null;
let contextList: Track[] = [];
let contextIndex = -1;
let songCommentsOpen = false;
let songPageId = 0;
let bpSeekTimer: ReturnType<typeof setTimeout> | undefined;
let queuePopupOpen = false;
let favoritePicker: { trackId: number; playlists: PlaylistRef[] } | null = null;
let playlistSort: Array<{ key: "title" | "artist" | "album" | "duration"; dir: 1 | -1 }> = [];
let playlistLikeOrder: LikeOrder = "none";
let playlistQuery = "";
let playlistSortId = 0;
let artistTab: "songs" | "albums" | "detail" | "similar" = "songs";
let artistTabId = 0;
let artistAllSort: Array<{ key: "title" | "artist" | "album" | "duration"; dir: 1 | -1 }> = [];
let artistAllLikeOrder: LikeOrder = "none";
let artistAllQuery = "";
let artistAllSortId = 0;
let artistPreviewSort: Array<{ key: "title" | "artist" | "album" | "duration"; dir: 1 | -1 }> = [];
let artistPreviewLikeOrder: LikeOrder = "none";
let artistPreviewSortId = 0;
let coverPreview: { url: string; name: string; artist: string } | null = null;
let pendingLocate = false;
let commentsLoadingMore = false;

type LikeOrder = "none" | "first" | "last";
function nextLikeOrder(order: LikeOrder): LikeOrder {
  return order === "none" ? "first" : order === "first" ? "last" : "none";
}
function likeOrderMark(order: LikeOrder): string {
  return order === "first" ? " ↑" : order === "last" ? " ↓" : "";
}

function boot(): void {
  app.innerHTML = `<div class="main">
    <div class="main-top">
      <button class="icon-btn top-back" data-act="back" title="返回上一页">${icon("back", 16)}</button>
      <div class="crumbs">
        <span>${logo ? `<img src="${esc(logo)}" style="width:15px;height:15px" alt="">` : ""}</span>
        <span>网易云音乐</span>
        <span>/</span>
        <span class="current" id="crumb-current">推荐</span>
      </div>
      <div class="top-search">
        <input id="top-search-input" type="search" placeholder="搜索歌曲、歌手、歌单…" autocomplete="off" spellcheck="false" />
        <span class="search-icon">${icon("search", 13)}</span>
      </div>
      <button class="top-account" id="top-account" data-act="openMyProfile"></button>
    </div>
    <div class="main-body" id="content"><div class="boot"><span class="spinner"></span>正在加载网易云音乐…</div></div>
  </div>
  <div class="bottom-player hidden" id="bottom-player"></div>
  <div class="toasts" id="toasts"></div>
  <div id="queue-popup-root"></div>
  <div id="favorite-root"></div>
  <div id="cover-root"></div>
  <div id="ctx-root"></div>`;
  const input = qs<HTMLInputElement>("#top-search-input");
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const query = input.value.trim();
    if (query) send("search", { query, kind: "all" });
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id === "playlist-search" && event.key === "Enter") {
      playlistQuery = (target as HTMLInputElement).value.trim();
      render();
    }
    if (target?.id === "artist-all-search" && event.key === "Enter") {
      artistAllQuery = (target as HTMLInputElement).value.trim();
      render();
    }
  });
  document.addEventListener("click", onClick, true);
  const mainScroll = qs<HTMLElement>(".main");
  mainScroll?.addEventListener("scroll", () => {
    if (page.kind !== "artistSongs" || page.artistAllLoading || !page.artistAllHasMore) return;
    const nearBottom = mainScroll.scrollTop + mainScroll.clientHeight >= mainScroll.scrollHeight - 280;
    if (nearBottom) send("loadMoreArtistSongs");
  }, { passive: true });
  mainScroll?.addEventListener("scroll", () => {
    if (commentsLoadingMore || !comments?.more) return;
    const commentsVisible =
      page.kind === "song" ||
      page.kind === "now" ||
      (page.kind === "playlist" && page.activeTab === "comments");
    if (!commentsVisible) return;
    const nearBottom = mainScroll.scrollTop + mainScroll.clientHeight >= mainScroll.scrollHeight - 220;
    if (nearBottom) requestMoreComments();
  }, { passive: true });
  document.addEventListener("scroll", (event) => {
    const el = event.target as HTMLElement | null;
    if (!el?.classList?.contains("comment-list")) return;
    if (commentsLoadingMore || !comments?.more) return;
    if (page.kind !== "song" && page.kind !== "now") return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 90) requestMoreComments();
  }, true);
  document.addEventListener("wheel", onLyricWheelScroll, { passive: true });
  window.addEventListener("resize", () => updateBottomProgress());
  window.addEventListener("online", () => {
    if (page.kind !== "song") return;
    const track = page.song?.track;
    if (!track) return;
    if (track.localPath && track.id > 0) {
      send("loadComments", { resource: `R_SO_4_${track.id}`, id: track.id, offset: 0 });
    }
    render();
  });
  window.addEventListener("offline", () => {
    if (page.kind === "song") render();
  });
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>(".track-row");
    if (!row) return;
    send("openSongDetail", { id: Number(row.dataset.trackId) });
  });
  vscode.postMessage({ type: "ready" });
}

// ------------------------------------------------------------------ helpers

function outputLabel(): string {
  const state = player;
  if (!state) return "";
  if (state.output.kind === "native") return `原生输出 · ${state.output.format ? `${state.output.format.sampleRate / 1000} kHz / ${state.output.format.bits} bit` : state.output.backend ?? ""}`;
  if (state.output.kind === "webaudio") return "WebAudio（共享）";
  return state.output.label;
}

function qualityLabel(track: Track | null | undefined): { label: string; tier: string } | null {
  if (!track) return null;
  if (track.localPath) return { label: "本地", tier: "free" };
  const level = track.privilege?.maxBrLevel;
  const map: Record<string, { label: string; tier: string }> = {
    jymaster: { label: "超清母带", tier: "svip" },
    sky: { label: "沉浸环绕声", tier: "svip" },
    jyeffect: { label: "高清臻音", tier: "svip" },
    hires: { label: "Hi-Res", tier: "vip" },
    lossless: { label: "无损", tier: "vip" },
    exhigh: { label: "极高", tier: "free" },
    higher: { label: "较高", tier: "free" },
    standard: { label: "标准", tier: "free" },
  };
  if (level && map[level]) return map[level];
  if (track.fee === 1) return { label: "VIP", tier: "vip" };
  return null;
}

function qualityTag(track: Track): string {
  const quality = qualityLabel(track);
  if (!quality) return "";
  return `<span class="q-tag ${esc(quality.tier)}">${esc(quality.label)}</span>`;
}

function currentList(kind: string): Track[] {
  switch (kind) {
    case "playlist":
      return playlistDisplayTracks();
    case "album":
      return page.album?.tracks ?? [];
    case "artist":
      return artistPreviewDisplayTracks();
    case "artistAll":
      return artistAllDisplayTracks();
    case "radio":
      return page.radioPrograms ?? [];
    case "search":
      return page.search?.songs ?? [];
    case "queue":
      return queue;
    case "recent":
      return page.recent ?? [];
    case "roam":
      return page.roam ?? page.home?.roamSongs ?? [];
    case "cloud":
      return page.cloud ?? [];
    case "daily":
      return page.home?.dailySongs ?? [];
    case "new":
      return page.home?.newSongs ?? [];
    default:
      return [];
  }
}

function findTrack(id: number): Track | null {
  for (const list of [
    queue,
    page.song ? [page.song.track] : [],
    page.playlist?.tracks ?? [],
    page.album?.tracks ?? [],
    page.artist?.songs ?? [],
    page.artistAll ?? [],
    page.radioPrograms ?? [],
    page.search?.songs ?? [],
    page.roam ?? [],
    page.recent ?? [],
    page.cloud ?? [],
    page.home?.dailySongs ?? [],
    page.home?.newSongs ?? [],
  ]) {
    const found = list.find((track) => track.id === id);
    if (found) return found;
  }
  return null;
}

function listForTrack(track: Track): { list: Track[]; index: number; kind: string } {
  const candidates: Array<{ list: Track[]; kind: string }> = [
    { list: page.playlist?.tracks ?? [], kind: "playlist" },
    { list: page.album?.tracks ?? [], kind: "album" },
    { list: page.artist?.songs ?? [], kind: "artist" },
    { list: page.artistAll ?? [], kind: "artistAll" },
    { list: page.radioPrograms ?? [], kind: "radio" },
    { list: page.search?.songs ?? [], kind: "search" },
    { list: page.recent ?? [], kind: "recent" },
    { list: page.roam ?? [], kind: "roam" },
    { list: page.cloud ?? [], kind: "cloud" },
    { list: page.home?.dailySongs ?? [], kind: "daily" },
    { list: page.home?.newSongs ?? [], kind: "new" },
    { list: queue, kind: "queue" },
  ];
  for (const candidate of candidates) {
    const index = candidate.list.findIndex((item) => item.id === track.id);
    if (index >= 0) return { list: candidate.list, index, kind: candidate.kind };
  }
  return { list: [track], index: 0, kind: "single" };
}

function isLiked(track: Track): boolean {
  if (page.kind === "playlist" && page.playlist?.playlist.specialType === 5) return true;
  if (player?.track?.id === track.id) return player.liked;
  return likedIds.has(track.id) || Boolean(track.liked);
}

function trackRow(track: Track, index: number, kind: string, options: { remove?: boolean; local?: boolean } = {}): string {
  const current = player?.track?.id === track.id;
  const liked = isLiked(track);
  const sub = track.artists.map((artist) => artist.name).join(" / ");
  const album = track.album?.name ?? "";
  const artistHtml = track.artists.length
    ? track.artists
        .map(
          (artist) =>
            `<a href="#" data-act="openArtist" data-id="${artist.id}" title="${esc(artist.name)}">${esc(artist.name)}</a>`,
        )
        .join(" / ")
    : `<span>${esc(sub)}</span>`;
  return `<div class="track-row ${current ? "current" : ""}" data-track-id="${track.id}" data-index="${index}" data-list="${esc(kind)}" data-act="playTrack">
    <div class="idx-cell">
      <span class="idx">${current && player?.playing ? icon("volume", 11) : index + 1}</span>
      <button class="thumb-btn" data-act="openSongDetail" data-id="${track.id}" title="查看歌曲详情与评论"><img class="thumb" src="${esc(cover(track.album?.picUrl, 60))}" alt="" loading="lazy"></button>
    </div>
    <div class="track-title">
      <span class="name" title="${esc(track.name)}">${esc(track.name)}</span>
      ${track.alia?.length ? `<span class="alias">（${esc(track.alia[0])}）</span>` : ""}
      ${qualityTag(track)}
    </div>
    <div class="track-artist">${artistHtml}</div>
    <div class="track-album">${album ? `<a href="#" data-act="openAlbum" data-id="${track.album.id}" title="${esc(album)}">${esc(album)}</a>` : ""}</div>
    <div class="track-duration">${track.duration ? fmtTime(track.duration / 1000) : options.local ? "" : "--:--"}</div>
    <button class="icon-btn track-like ${liked ? "active" : ""}" data-act="likeTrack" data-id="${track.id}" title="${liked ? "取消喜欢" : "喜欢"}">${icon("heart", 13)}</button>
    ${
      options.remove
        ? `<button class="icon-btn row-more" data-act="removeQueue" data-index="${index}" title="移出队列">${icon("trash", 13)}</button>`
        : `<button class="icon-btn row-more" data-act="trackMenu" data-id="${track.id}" title="更多操作">${icon("more", 14)}</button>`
    }
  </div>`;
}

function trackTable(tracks: Track[], kind: string, emptyText = "暂无歌曲", options: { remove?: boolean } = {}): string {
  if (!tracks.length) return `<div class="empty">${esc(emptyText)}</div>`;
  const locate = player?.track && tracks.some((track) => track.id === player?.track?.id)
    ? `<button class="locate-current" data-act="locateCurrent" title="定位到当前播放歌曲">${icon("compass", 14)} 定位播放</button>`
    : "";
  return `${locate}<div class="table-head">
      <span>#</span><span>标题</span><span>歌手</span><span class="album-head">专辑</span><span style="text-align:right">时长</span><span></span><span></span>
    </div>
    <div>${tracks.map((track, index) => trackRow(track, index, kind, options)).join("")}</div>`;
}

function playlistCard(item: PlaylistRef): string {
  return `<button class="card" data-act="openPlaylist" data-id="${item.id}" title="${esc(item.name)}">
    <div class="art"><img src="${esc(cover(item.coverImgUrl, 240))}" alt="" loading="lazy"><span class="play">${icon("play", 13)}</span></div>
    <div class="name">${esc(item.name)}</div>
    <div class="sub">${item.trackCount} 首${item.creator?.nickname ? ` · ${esc(item.creator.nickname)}` : ""}</div>
  </button>`;
}

function radioCard(item: import("../api/types").DjRadio): string {
  return `<button class="radio-card" data-act="openRadio" data-id="${item.id}" title="${esc(item.name)}">
    <img src="${esc(cover(item.picUrl, 140))}" alt="" loading="lazy">
    <div style="min-width:0">
      <div class="name">${esc(item.name)}</div>
      <div class="sub">${esc(item.category ?? "")}${item.programCount ? ` · ${item.programCount} 期` : ""}${item.subCount ? ` · ${fmtCount(item.subCount)} 订阅` : ""}</div>
      ${item.rcmdtext ? `<div class="sub">${esc(item.rcmdtext)}</div>` : ""}
    </div>
  </button>`;
}

function artistCard(item: { id: number; name: string; avatarUrl?: string }): string {
  return `<button class="artist-card" data-act="openArtist" data-id="${item.id}">
    <img src="${esc(cover(item.avatarUrl, 120))}" alt="">
    <div class="name">${esc(item.name)}</div>
  </button>`;
}

function commentItem(comment: Comment): string {
  return `<div class="comment">
    <img src="${esc(cover(comment.user.avatarUrl, 60))}" alt="" data-act="openUser" data-uid="${comment.user.userId}" title="查看主页">
    <div class="body">
      <div class="who"><button class="link-btn" data-act="openUser" data-uid="${comment.user.userId}">${esc(comment.user.nickname)}</button>${comment.user.title ? `<span class="user-title">${esc(comment.user.title)}</span>` : ""}${comment.user.vipType ? `<span class="vip-badge ${comment.user.vipType >= 10 ? "svip" : ""}">${comment.user.vipType >= 10 ? "SVIP" : "VIP"}</span>` : ""}<span class="when">${esc(fmtDateTime(comment.time))}</span></div>
      <div class="text">${esc(comment.content)}</div>
      ${comment.replied ? `<div class="replied"><b>${esc(comment.replied.user.nickname)}：</b>${esc(comment.replied.content)}</div>` : ""}
      <div class="foot"><span>${icon("heart", 11)} ${comment.likedCount || ""}</span></div>
    </div>
  </div>`;
}

function banner(kind: "info" | "warn" | "error", message: string): string {
  return `<div class="banner ${kind}">${icon("info", 12)}<div>${esc(message)}</div></div>`;
}

function empty(message: string): string {
  return `<div class="empty">${message}</div>`;
}

// ------------------------------------------------------------------- render

function render(): void {
  const content = qs("#content");
  const crumb = qs("#crumb-current");
  if (!content) return;
  const wasSongPage = document.body.classList.contains("song-page");
  document.body.classList.toggle("song-page", page.kind === "song");
  if (page.kind === "song" && !wasSongPage) {
    const main = qs<HTMLElement>(".main");
    if (main) main.scrollTop = 0;
  }
  if (page.kind !== "song") {
    if (lyricManualTimer) {
      clearTimeout(lyricManualTimer);
      lyricManualTimer = undefined;
    }
    lyricManualUntil = 0;
    songLyricIndex = -1;
    songLyricTrackId = 0;
  }
  if (crumb) crumb.textContent = page.title || "网易云音乐";
  renderAccount();
  switch (page.kind) {
    case "recommend":
      content.innerHTML = renderRecommend();
      break;
    case "featured":
      content.innerHTML = renderFeatured();
      break;
    case "podcast":
      content.innerHTML = renderPodcast();
      break;
    case "roam":
      content.innerHTML = renderRoam();
      break;
    case "following":
      content.innerHTML = renderFollowing();
      break;
    case "playlist":
      content.innerHTML = renderPlaylist();
      break;
    case "song":
      content.innerHTML = renderSong();
      break;
    case "user":
      content.innerHTML = renderUser();
      break;
    case "album":
      content.innerHTML = renderAlbum();
      break;
    case "artist":
      content.innerHTML = renderArtist();
      break;
    case "radioDetail":
      content.innerHTML = renderRadio();
      break;
    case "artistSongs":
      content.innerHTML = renderArtistSongs();
      break;
    case "search":
      content.innerHTML = renderSearch();
      break;
    case "queue":
      content.innerHTML = renderQueue();
      break;
    case "downloads":
      content.innerHTML = renderDownloads();
      break;
    case "recent":
      content.innerHTML = renderRecent();
      break;
    case "collections":
      content.innerHTML = renderCollections();
      break;
    case "local":
      content.innerHTML = renderLocal();
      break;
    case "cloud":
      content.innerHTML = renderCloud();
      break;
    case "now":
      content.innerHTML = renderNow();
      break;
  }
  if (page.kind === "now") updateLyricHighlight(true);
  updateRowHighlights();
  renderBottomPlayer();
  renderQueuePopup();
  renderFavoritePicker();
  renderCoverPreview();
  if (page.kind === "song") updateSongLyricHighlight();
}

function renderAccount(): void {
  const chip = qs("#top-account");
  if (!chip) return;
  if (account) {
    chip.innerHTML = `${account.avatarUrl ? `<img src="${esc(cover(account.avatarUrl, 40))}" alt="">` : ""}<span>${esc(account.nickname)}</span>${account.vipType ? `<span class="vip-badge ${account.vipType >= 10 ? "svip" : ""}">${account.vipType >= 10 ? "SVIP" : "VIP"}</span>` : ""}`;
    chip.title = "查看我的主页";
    chip.dataset.act = "openMyProfile";
  } else {
    chip.innerHTML = `${icon("login", 12)}<span>未登录</span>`;
    chip.title = "登录网易云音乐";
    chip.dataset.act = "login";
  }
}

function renderRecommend(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载推荐…</div>`;
  if (page.error) return banner("error", page.error);
  const home = page.home;
  if (!home) return empty("暂无推荐内容");
  const daily = home.dailySongs.length
    ? `<section class="section"><div class="section-head"><span class="section-title">每日推荐</span><span class="section-sub">根据你的口味生成</span><button class="btn small" data-act="playAll" data-list="daily">${icon("play", 11)} 播放全部</button></div>${trackTable(home.dailySongs, "daily")}</section>`
    : "";
  const personalized = home.personalized.length
    ? `<section class="section"><div class="section-head"><span class="section-title">推荐歌单</span><span class="section-sub">为你精选</span></div><div class="card-grid">${home.personalized.map(playlistCard).join("")}</div></section>`
    : "";
  const toplists = home.toplists.length
    ? `<section class="section"><div class="section-head"><span class="section-title">排行榜</span><span class="section-sub">实时更新</span><button class="more" data-act="nav" data-nav="featured">查看全部 ›</button></div><div class="toplists">${home.toplists.slice(0, 6).map(toplistCard).join("")}</div></section>`
    : "";
  const newSongs = home.newSongs.length
    ? `<section class="section"><div class="section-head"><span class="section-title">最新音乐</span></div><div class="card-grid">${home.newSongs.slice(0, 12).map((track, index) => newSongCard(track, index)).join("")}</div></section>`
    : "";
  const radios = home.radios.length
    ? `<section class="section"><div class="section-head"><span class="section-title">播客推荐</span><button class="more" data-act="nav" data-nav="podcast">查看全部 ›</button></div><div class="radio-grid">${home.radios.slice(0, 4).map(radioCard).join("")}</div></section>`
    : "";
  const categories = `<div class="rec-categories">
    <button class="rec-cat rec-cat-daily" data-act="playAll" data-list="daily"><span class="cat-badge">30</span><span class="cat-title">每日推荐</span><span class="cat-sub">从「${esc(home.dailySongs[0]?.name ?? "今日推荐")}」听起</span></button>
    <button class="rec-cat rec-cat-heart" data-act="playAll" data-list="daily"><span class="cat-title">心动模式</span><span class="cat-sub">你的红心歌曲和更多相似推荐</span></button>
    <button class="rec-cat rec-cat-roam" data-act="nav" data-nav="roam"><span class="cat-title">私人漫游</span><span class="cat-sub">开启无限漫游</span></button>
    <button class="rec-cat rec-cat-acg" data-act="searchQuick" data-query="ACG"><span class="cat-title">ACG专区</span><span class="cat-sub">正在热播 ACG 好音乐</span></button>
  </div>`;
  return `${categories}${daily}${personalized}${toplists}${newSongs}${radios}`;
}

function toplistCard(item: import("../api/types").Toplist): string {
  return `<button class="toplist-card" data-act="openPlaylist" data-id="${item.id}">
    <img src="${esc(cover(item.coverImgUrl, 140))}" alt="" loading="lazy">
    <div style="min-width:0">
      <div class="name">${esc(item.name)}</div>
      <div class="sub">${esc(item.updateFrequency ?? "")}${item.trackCount ? ` · ${item.trackCount} 首` : ""}</div>
    </div>
  </button>`;
}

function newSongCard(track: Track, index = 0): string {
  return `<button class="card" data-act="playTrack" data-id="${track.id}" data-list="new" data-index="${index}" title="${esc(track.name)}">
    <div class="art"><img src="${esc(cover(track.album?.picUrl, 240))}" alt="" loading="lazy"><span class="play">${icon("play", 13)}</span></div>
    <div class="name">${esc(track.name)}</div>
    <div class="sub">${esc(track.artists.map((artist) => artist.name).join(" / "))}</div>
  </button>`;
}

function renderFeatured(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载精选…</div>`;
  const home = page.home;
  if (!home) return empty("暂无内容");
  return `<section class="section"><div class="section-head"><span class="section-title">排行榜</span><span class="section-sub">网易云音乐官方榜</span></div><div class="toplists">${home.toplists.map(toplistCard).join("")}</div></section>
    ${home.personalized.length ? `<section class="section"><div class="section-head"><span class="section-title">精选歌单</span></div><div class="card-grid">${home.personalized.map(playlistCard).join("")}</div></section>` : ""}`;
}

function renderPodcast(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载播客…</div>`;
  const radios = page.home?.radios ?? [];
  if (!radios.length) return empty("暂无播客推荐");
  return `<section class="section"><div class="section-head"><span class="section-title">播客推荐</span><span class="section-sub">${radios.length} 个节目</span></div><div class="radio-grid">${radios.map(radioCard).join("")}</div></section>`;
}

function renderRoam(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在为你漫游…</div>`;
  const tracks = page.roam ?? [];
  return `<section class="section"><div class="section-head"><span class="section-title">漫游</span><span class="section-sub">随机发现一些歌</span><button class="btn small" data-act="playAll" data-list="roam">${icon("play", 11)} 播放全部</button></div>${trackTable(tracks, "roam", "暂时没有漫游歌曲")}</section>`;
}

function renderFollowing(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载关注…</div>`;
  if (!account) return `${banner("info", "登录后可查看你关注的歌手。")}<button class="btn primary" data-act="login">登录网易云音乐</button>`;
  const artists = page.following ?? [];
  if (!artists.length) return empty("还没有关注歌手");
  return `<section class="section"><div class="section-head"><span class="section-title">关注的歌手</span><span class="section-sub">${artists.length} 位</span></div><div class="artist-grid">${artists.map((artist) => artistCard(artist)).join("")}</div></section>`;
}

function renderSong(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载歌曲…</div>`;
  if (page.error) return banner("error", page.error);
  const song = page.song;
  if (!song) return empty("歌曲不存在");
  const track = song.track;
  const artistButtons = track.artists
    .map(
      (artist) =>
        `<button class="link-btn" data-act="openArtist" data-id="${artist.id}">${esc(artist.name)}</button>`,
    )
    .join(" / ");
  const composerButtons = song.composerNames
    .map(
      (name) =>
        `<button class="link-btn" data-act="openArtistByName" data-name="${esc(name)}" title="打开 ${esc(name)} 的主页">${esc(name)}</button>`,
    )
    .join(" / ");
  const commentCount = comments?.total ?? track.commentCount ?? 0;
  const lines = parseLrc(song.lyric.lrc);
  const translations = parseLrc(song.lyric.translation);
  const activeLine = (lineTime: number) => {
    if (player?.track?.id !== track.id) return false;
    let active = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].time <= (player?.position ?? 0) + 0.15) active = i;
      else break;
    }
    return lines[active]?.time === lineTime;
  };
  const lyricHtml = lines.length
    ? lines
        .map((line) => {
          const translation = translations.find((item) => Math.abs(item.time - line.time) < 0.15);
          return `<div class="lyric-line ${activeLine(line.time) ? "active" : ""}" data-act="seekLyric" data-time="${line.time}" title="跳转到这一句">${esc(line.text) || "&nbsp;"}${
            translation ? `<span class="tr">${esc(translation.text)}</span>` : ""
          }</div>`;
        })
        .join("")
    : `<div class="lyric-line muted">暂无歌词</div>`;
  const left = `<div class="song-left">
    <img class="now-art song-art" src="${esc(cover(track.album?.picUrl, 520))}" alt="" data-act="zoomCover" data-src="${esc(cover(track.album?.picUrl, 800))}" data-name="${esc(track.name)}" data-artist="${esc(track.artists.map((artist) => artist.name).join(" / "))}" title="点击放大封面">
    <div class="song-info">
      <div class="now-title">${esc(track.name)}</div>
      <div class="song-artists">${artistButtons || esc(track.artists.map((artist) => artist.name).join(" / "))}</div>
      ${composerButtons ? `<div class="song-composers"><span class="muted">作曲</span>${composerButtons}</div>` : ""}
      <div class="now-badges">
        <span class="pill accent">${esc(QUALITY_TEXT[player?.actualQuality ?? ""] ?? QUALITY_TEXT[track.privilege?.maxBrLevel ?? ""] ?? "音质")}</span>
        ${track.album?.name ? `<span class="pill">${esc(track.album.name)}</span>` : ""}
        ${track.duration ? `<span class="pill">${fmtTime(track.duration / 1000)}</span>` : ""}
      </div>
      <div class="now-actions">
        <button class="btn small ${player?.track?.id === track.id && player.liked ? "primary" : ""}" data-act="likeTrack" data-id="${track.id}">${icon("heart", 12)} ${player?.track?.id === track.id && player.liked ? "已喜欢" : "喜欢"}</button>
        <button class="btn small" data-act="playTrack" data-id="${track.id}">${icon("play", 12)} 播放</button>
        <button class="btn small" data-act="downloadTrack" data-id="${track.id}">${icon("download", 12)} 下载</button>
        <button class="btn small" data-act="openFavorite" data-id="${track.id}">${icon("star", 12)} 收藏</button>
        <button class="btn small" data-act="playNext" data-id="${track.id}">${icon("next", 12)} 下一首播放</button>
      </div>
      <button class="comment-entry ${songCommentsOpen ? "active" : ""}" data-act="toggleSongComments">
        ${icon("comment", 15)} 评论 <b>${commentCount ? fmtCount(commentCount) : ""}</b>
      </button>
    </div>
    ${player?.error && /采样率|sampleRate/i.test(player.error) ? `<div class="banner warn" style="text-align:left">${esc(player.error)}<div style="margin-top:6px"><button class="btn small primary" data-act="fixSampleRate">改为 auto（跟随音源）</button></div></div>` : ""}
  </div>`;
  const lyricColumn = `<div class="song-lyric-column">
    <div class="lyric-box song-lyrics" id="song-lyric" title="点击或滚轮切换歌词进度">${lyricHtml}</div>
  </div>`;
  return `<div class="song-split">${left}${lyricColumn}<div class="song-comments" id="song-comments">${renderSongComments(track)}</div></div>`;
}

function renderSongComments(track: Track): string {
  const count = comments?.total ?? track.commentCount ?? 0;
  if (track.localPath && (track.id <= 0 || !comments)) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return `<div class="comment-head"><span class="section-title">评论</span></div>${
      offline
        ? banner("info", "当前无网络，评论区不可见。联网后会自动重新加载。")
        : banner("info", "本地音乐没有关联的在线评论。")
    }`;
  }
  if (!comments || comments.loading) {
    return `<div class="comment-head"><span class="section-title">评论</span><span class="section-sub">${count ? fmtCount(count) : ""}</span></div><div class="empty"><span class="spinner"></span>正在加载评论…</div>`;
  }
  if (comments.error) return banner("error", comments.error);
  const hot = comments.hot.length
    ? `<div class="comment-subhead">精彩评论</div>${comments.hot.map(commentItem).join("")}`
    : "";
  const list = comments.comments.length
    ? comments.comments.map(commentItem).join("")
    : `<div class="empty">还没有评论，来抢沙发吧</div>`;
  const more = comments.more
    ? `<div class="comment-more muted tiny">${commentsLoadingMore ? "正在加载更多评论…" : "滚动到此处继续加载评论"}</div>`
    : "";
  const composer = account
    ? `<div class="comment-compose">
        <textarea id="comment-input" maxlength="140" placeholder="说点什么…" rows="1"></textarea>
        <button class="send-comment" data-act="sendComment">发送</button>
      </div>`
    : `<div class="comment-compose login-first"><span class="muted">登录后参与评论</span><button class="btn small" data-act="login">登录</button></div>`;
  return `<div class="comment-head"><span class="section-title">评论</span><span class="section-sub">${count ? fmtCount(count) : ""}</span></div>
    ${composer}
    <div class="comment-list">${hot}${comments.comments.length ? `<div class="comment-subhead">最新评论</div>` : ""}${list}${more}</div>`;
}

function renderUser(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载用户主页…</div>`;
  if (page.error) return banner("error", page.error);
  const view = page.user;
  if (!view) return empty("用户不存在");
  const user = view.user;
  const vip = Number(user.vipType ?? 0);
  const badge = vip >= 10 ? `<span class="vip-badge svip">SVIP</span>` : vip > 0 ? `<span class="vip-badge">VIP</span>` : "";
  const playlists = view.playlists.length
    ? `<div class="card-grid">${view.playlists.map(playlistCard).join("")}</div>`
    : empty("还没有公开歌单");
  return `<div class="user-hero">
    <img class="user-avatar" src="${esc(cover(user.avatarUrl, 240))}" alt="">
    <div class="user-info">
      <div class="user-name">${esc(user.nickname)} ${badge} ${user.level ? `<span class="user-level">Lv.${user.level}</span>` : ""}</div>
      <div class="user-meta">
        <span>关注 ${user.follows ?? 0}</span><span>粉丝 ${user.followeds ?? 0}</span>
        ${user.listenSongs ? `<span>累计听歌 ${fmtCount(user.listenSongs)} 首</span>` : ""}
        ${user.createTime ? `<span>注册于 ${esc(fmtDate(user.createTime))}</span>` : ""}
      </div>
      ${user.signature ? `<div class="user-sign">${esc(user.signature)}</div>` : ""}
      <div class="user-tabs"><span class="active">音乐</span><span>歌单 ${view.playlists.length}</span></div>
    </div>
  </div>
  <div class="section"><div class="section-head"><span class="section-title">${view.isSelf ? "我的歌单" : "TA 的歌单"}</span><span class="section-sub">${view.playlists.length} 个</span></div>${playlists}</div>`;
}

function renderBottomPlayer(): void {
  const box = qs("#bottom-player");
  if (!box) return;
  if (!player?.track) {
    box.classList.add("hidden");
    box.innerHTML = "";
    box.removeAttribute("data-track");
    return;
  }
  const track = player.track;
  if (box.dataset.track === String(track.id)) {
    updateBottomProgress();
    const play = box.querySelector<HTMLElement>('[data-act="playPause"]');
    if (play) play.innerHTML = icon(player.playing ? "pause" : "play", 14);
    updateModeButton(box);
    updateLikeButton(box);
    return;
  }
  box.dataset.track = String(track.id);
  box.classList.remove("hidden");
  const artistText =
    track.artists
      .map((artist) => artist.name)
      .filter((name) => name && !/\{(?:artist|name|album)\}/i.test(name))
      .join(" / ") || "本地音乐";
  box.innerHTML = `<div class="bp-left" data-act="openSongDetail" data-id="${track.id}" title="打开歌曲详情"><img src="${esc(cover(track.album?.picUrl, 60))}" alt=""><div class="bp-meta"><div class="bp-title">${esc(track.name)}</div><div class="bp-sub">${esc(artistText)}</div></div></div>
    <div class="bp-seek-wrap"><span class="bp-time" id="bp-cur">${fmtTime(player.position)}</span><div class="bp-range" id="bp-range"><div class="bp-buffered" id="bp-buffered"></div><div class="bp-played" id="bp-played"></div><input id="bp-seek" type="range" min="0" max="${Math.max(1, player.duration)}" value="${Math.min(player.position, player.duration || player.position)}" step="0.5" aria-label="播放进度" /></div><span class="bp-time" id="bp-dur">${fmtTime(player.duration)}</span></div>`;
  updateModeButton(box);
  updateLikeButton(box);
  updateBottomProgress();
}

function updateLikeButton(box: HTMLElement): void {
  const button = box.querySelector<HTMLElement>(".bp-like");
  if (!button || !player) return;
  button.innerHTML = icon("heart", 14);
  button.classList.toggle("liked", Boolean(player.liked));
  button.title = player.liked ? "取消喜欢" : "喜欢";
}

const MODE_ORDER = ["order", "shuffle", "repeat", "repeatOne"] as const;
const MODE_LABEL: Record<string, string> = {
  order: "顺序播放",
  repeat: "列表循环",
  repeatOne: "单曲循环",
  shuffle: "随机播放",
};
const MODE_ICON: Record<string, string> = {
  order: "list",
  repeat: "repeat",
  repeatOne: "repeatOne",
  shuffle: "shuffle",
};

function nextPlayMode(mode: string): string {
  const index = MODE_ORDER.indexOf(mode as (typeof MODE_ORDER)[number]);
  return MODE_ORDER[(index + 1) % MODE_ORDER.length];
}

function updateModeButton(box: HTMLElement): void {
  const button = box.querySelector<HTMLElement>(".bp-mode");
  if (!button || !player) return;
  const mode = player.mode ?? "order";
  const label = MODE_LABEL[mode] ?? "顺序播放";
  const next = MODE_LABEL[nextPlayMode(mode)] ?? "";
  button.innerHTML = icon(MODE_ICON[mode] ?? "list", 14);
  button.title = `${label}（点击切换为${next}）`;
  button.dataset.mode = mode;
}

function currentPlaybackSource(): PlaybackSource | null {
  if (page.kind === "playlist" && page.playlist) {
    return { kind: "playlist", id: page.playlist.playlist.id, name: page.playlist.playlist.name };
  }
  if (page.kind === "album" && page.album) {
    return { kind: "album", id: page.album.id, name: page.album.name };
  }
  if ((page.kind === "artist" || page.kind === "artistSongs") && page.artist) {
    return { kind: "artist", id: page.artist.id, name: page.artist.name };
  }
  return null;
}

function renderQueuePopup(): void {
  const root = qs("#queue-popup-root");
  if (!root) return;
  if (!queuePopupOpen) {
    root.innerHTML = "";
    return;
  }
  const current = player?.track?.id;
  root.innerHTML = `<div class="queue-popup">
    <div class="queue-popup-head"><span>播放列表</span><span class="queue-count">${queue.length}</span><span class="spacer"></span><button class="btn small" data-act="locateQueueCurrent">定位当前</button><button class="btn small" data-act="locateQueuePlaylist">定位歌单</button><button class="icon-btn" data-act="closeQueuePopup" title="关闭">${icon("close", 14)}</button></div>
    <div class="queue-popup-list">
      ${
        queue.length
          ? queue
              .map(
                (track, index) => `<div class="queue-row ${track.id === current ? "current" : ""}" data-act="playQueueIndex" data-index="${index}">
                  <img src="${esc(cover(track.album?.picUrl, 60))}" alt="">
                  <div class="queue-meta"><div class="queue-title">${esc(track.name)}</div><div class="queue-sub">${esc(track.artists.map((artist) => artist.name).join(" / "))}</div></div>
                  ${track.id === current && player?.playing ? `<span class="queue-playing">${icon("volume", 12)}</span>` : ""}
                  <button class="icon-btn queue-remove" data-act="removeQueue" data-index="${index}" title="移出队列">${icon("trash", 12)}</button>
                </div>`,
              )
              .join("")
          : `<div class="empty">队列是空的</div>`
      }
    </div>
    <div class="queue-popup-foot"><button class="btn small" data-act="clearQueue">清空队列</button><span class="muted tiny">点击歌曲播放</span></div>
  </div>`;
}

function renderFavoritePicker(): void {
  const root = qs("#favorite-root");
  if (!root) return;
  if (!favoritePicker) {
    root.innerHTML = "";
    return;
  }
  const { trackId, playlists } = favoritePicker;
  const items = playlists.filter((playlist) => playlist.specialType !== 5);
  root.innerHTML = `<div class="favorite-backdrop" data-act="closeFavorite">
    <div class="favorite-modal" data-act="noop">
      <div class="favorite-head"><div><b>收藏到歌单</b><div class="muted tiny">选择目标歌单</div></div><button class="icon-btn" data-act="closeFavorite" title="关闭">${icon("close", 14)}</button></div>
      ${items.length ? `<div class="favorite-list">${items
        .map(
          (playlist) => `<button class="favorite-item" data-act="favoriteTo" data-track-id="${trackId}" data-playlist-id="${playlist.id}">
            <img src="${esc(cover(playlist.coverImgUrl, 80))}" alt="">
            <span class="favorite-meta"><span class="favorite-name">${esc(playlist.name)}</span><span class="favorite-sub">${playlist.trackCount} 首</span></span>
            ${icon("plus", 14)}
          </button>`,
        )
        .join("")}</div>` : `<div class="empty">没有可用的歌单</div>`}
    </div>
  </div>`;
}

function renderCoverPreview(): void {
  const root = qs("#cover-root");
  if (!root) return;
  if (!coverPreview) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = `<div class="cover-backdrop" data-act="closeCover">
    <div class="cover-modal" data-act="noop">
      <img src="${esc(coverPreview.url)}" alt="">
      <div class="cover-actions">
        <button class="btn primary" data-act="downloadCover">${icon("download", 13)} 下载封面</button>
        <button class="btn" data-act="closeCover">关闭</button>
      </div>
      <div class="muted tiny" style="margin-top:8px">${esc(coverPreview.name)} · ${esc(coverPreview.artist)}</div>
    </div>
  </div>`;
}

function renderPlaylist(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载歌单…</div>`;
  if (page.error) return banner("error", page.error);
  const detail = page.playlist;
  if (!detail) return empty("歌单不存在");
  const playlist = detail.playlist;
  if (playlistSortId !== playlist.id) {
    playlistSortId = playlist.id;
    playlistSort = [];
    playlistLikeOrder = "none";
    playlistQuery = "";
  }
  const tags = playlist.tags?.length ? `<div class="hero-tags">${playlist.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</div>` : "";
  const hero = `<div class="hero">
    <div class="hero-cover">
      <img src="${esc(cover(playlist.coverImgUrl, 360))}" alt="">
      <div class="mask">${icon("disc", 46)}</div>
    </div>
    <div class="hero-info">
      <div class="hero-kind">${icon("list", 11)} 歌单</div>
      <h1 class="hero-title">${esc(playlist.name)}</h1>
      ${playlist.creator ? `<div class="hero-creator"><img src="${esc(cover(playlist.creator.avatarUrl, 40))}" alt="" data-act="openUser" data-uid="${playlist.creator.userId}"><button class="link-btn name" data-act="openUser" data-uid="${playlist.creator.userId}">${esc(playlist.creator.nickname)}</button>${playlist.createTime ? `<span>创建于 ${esc(fmtDate(playlist.createTime))}</span>` : ""}</div>` : ""}
      <div class="hero-meta">
        <span>${playlist.trackCount} 首</span>
        ${playlist.playCount ? `<span>播放 ${fmtCount(playlist.playCount)} 次</span>` : ""}
        ${playlist.updateTime ? `<span>更新于 ${esc(fmtDate(playlist.updateTime))}</span>` : ""}
      </div>
      ${playlist.description ? `<div class="hero-desc">${esc(playlist.description)}</div>` : ""}
      <div class="hero-actions">
        <button class="btn primary play-all" data-act="playAll" data-list="playlist">${icon("play", 13)} 播放全部</button>
        <button class="btn" data-act="enqueuePlaylist" data-id="${playlist.id}">${icon("plus", 12)} 加入队列</button>
        <button class="btn" data-act="downloadPlaylist" data-id="${playlist.id}">${icon("download", 12)} 下载</button>
        <button class="btn" data-act="playlistMenu" data-id="${playlist.id}" title="更多操作">${icon("more", 12)} 更多</button>
        <button class="btn" data-act="refreshPage">${icon("refresh", 12)} 刷新</button>
      </div>
      ${tags}
    </div>
  </div>`;
  const activeTab = page.activeTab ?? "songs";
  const count = comments?.total ?? playlist.commentCount ?? 0;
  const subscriberTotal = subscribers?.total ?? playlist.subscriberCount ?? 0;
  const tabs = `<div class="page-tabs">
    <button class="page-tab ${activeTab === "songs" ? "active" : ""}" data-act="tab" data-tab="songs">歌曲<span class="num">${playlist.trackCount}</span></button>
    <button class="page-tab ${activeTab === "comments" ? "active" : ""}" data-act="tab" data-tab="comments">评论<span class="num">${count || ""}</span></button>
    <button class="page-tab ${activeTab === "subscribers" ? "active" : ""}" data-act="tab" data-tab="subscribers">收藏者<span class="num">${subscriberTotal || ""}</span></button>
  </div>`;
  if (activeTab === "comments") return `${hero}${tabs}${renderComments()}`;
  if (activeTab === "subscribers") return `${hero}${tabs}${renderSubscribers()}`;
  const currentTrackId = player?.track?.id;
  const locate = currentTrackId && detail.tracks.some((track) => track.id === currentTrackId)
    ? `<button class="locate-current" data-act="locateCurrent" title="定位到当前播放歌曲">${icon("compass", 14)} 定位播放</button>`
    : "";
  const tools = `<div class="playlist-tools">
    <div class="playlist-search"><input id="playlist-search" type="search" value="${esc(playlistQuery)}" placeholder="搜索当前歌单歌曲…" /><button class="icon-btn" data-act="playlistSearch" title="搜索">${icon("search", 13)}</button></div>
  </div>`;
  return `${hero}${tabs}${tools}${locate}${playlistTable(playlistDisplayTracks())}`;
}

function playlistDisplayTracks(): Track[] {
  const detail = page.playlist;
  if (!detail) return [];
  let tracks = detail.tracks.slice();
  const query = playlistQuery.trim().toLowerCase();
  if (query) {
    tracks = tracks.filter((track) =>
      `${track.name} ${track.artists.map((artist) => artist.name).join(" ")} ${track.album?.name ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }
  if (playlistLikeOrder !== "none") {
    tracks.sort((a, b) => (playlistLikeOrder === "first" ? 1 : -1) * (Number(isLiked(b)) - Number(isLiked(a))));
  }
  const priorities: Array<"artist" | "album" | "title" | "duration"> = ["artist", "album", "title", "duration"];
  const activeSorts = priorities
    .map((key) => playlistSort.find((entry) => entry.key === key))
    .filter((entry): entry is { key: "title" | "artist" | "album" | "duration"; dir: 1 | -1 } => Boolean(entry));
  if (activeSorts.length) {
    tracks.sort((a, b) => {
      for (const sort of activeSorts) {
        let result = 0;
        if (sort.key === "title") result = a.name.localeCompare(b.name, "zh-CN");
        else if (sort.key === "artist") result = (a.artists[0]?.name ?? "").localeCompare(b.artists[0]?.name ?? "", "zh-CN");
        else if (sort.key === "album") result = (a.album?.name ?? "").localeCompare(b.album?.name ?? "", "zh-CN");
        else result = (a.duration ?? 0) - (b.duration ?? 0);
        if (result) return result * sort.dir;
      }
      return a.id - b.id;
    });
  }
  return tracks;
}

function playlistTable(tracks: Track[]): string {
  if (!tracks.length) return `<div class="empty">${playlistQuery ? "没有匹配的歌曲" : "空歌单"}</div>`;
  const label = (key: "title" | "artist" | "album" | "duration", text: string): string => {
    const item = playlistSort.find((entry) => entry.key === key);
    return `${text}${item ? (item.dir === 1 ? " ↑" : " ↓") : ""}`;
  };
  return `<div class="table-head playlist-head">
      <span><button class="sort-default" data-act="resetPlaylistSort">默认</button></span>
      <span><button class="head-sort" data-act="sortPlaylist" data-key="title">${label("title", "标题")}</button></span>
      <span><button class="head-sort" data-act="sortPlaylist" data-key="artist">${label("artist", "歌手")}</button></span>
      <span class="album-head"><button class="head-sort" data-act="sortPlaylist" data-key="album">${label("album", "专辑")}</button></span>
      <span style="text-align:right"><button class="head-sort" data-act="sortPlaylist" data-key="duration">${label("duration", "时长")}</button></span>
      <span><button class="head-sort ${playlistLikeOrder !== "none" ? "active" : ""}" data-act="toggleLikedFirst" title="喜欢优先/靠后">喜欢${likeOrderMark(playlistLikeOrder)}</button></span>
      <span></span>
    </div><div>${tracks.map((track, index) => trackRow(track, index, "playlist")).join("")}</div>`;
}

function requestMoreComments(): void {
  if (commentsLoadingMore || !comments?.more) return;
  commentsLoadingMore = true;
  setTimeout(() => {
    commentsLoadingMore = false;
  }, 8000);
  if (page.kind === "song" || page.kind === "now") {
    send("loadComments", {
      resource: page.song ? `R_SO_4_${page.song.track.id}` : "",
      id: page.song?.track.id ?? 0,
      offset: comments?.comments.length ?? 0,
    });
  } else {
    send("loadComments", {
      resource: commentsResource(),
      id: currentResourceId(),
      offset: comments?.comments.length ?? 0,
    });
  }
}

function renderComments(): string {
  if (!comments || comments.loading) return `<div class="empty"><span class="spinner"></span>正在加载评论…</div>`;
  if (comments.error) return banner("error", comments.error);
  const hot = comments.hot.length
    ? `<div class="section-head" style="margin-top:14px"><span class="section-title">精彩评论</span></div>${comments.hot.map(commentItem).join("")}`
    : "";
  const list = comments.comments.length
    ? comments.comments.map(commentItem).join("")
    : `<div class="empty">还没有评论，来抢沙发吧</div>`;
  const more = comments.more
    ? `<div class="comment-more muted tiny">${commentsLoadingMore ? "正在加载更多评论…" : "滚动到此处继续加载评论"}</div>`
    : "";
  return `<div class="comments">${hot}<div class="section-head" style="margin-top:14px"><span class="section-title">最新评论</span><span class="section-sub">${comments.total} 条</span></div>${list}${more}</div>`;
}

function renderSubscribers(): string {
  if (!subscribers || subscribers.loading) return `<div class="empty"><span class="spinner"></span>正在加载收藏者…</div>`;
  if (subscribers.error) return banner("error", subscribers.error);
  if (!subscribers.subscribers.length) return empty("还没有收藏者");
  const more = subscribers.more
    ? `<div style="text-align:center;padding:14px"><button class="btn small" data-act="loadMoreSubscribers">加载更多</button></div>`
    : "";
  return `<div class="subscribers">${subscribers.subscribers
    .map(
      (subscriber) => `<div class="subscriber">
        <img src="${esc(cover(subscriber.avatarUrl, 80))}" alt="" data-act="openUser" data-uid="${subscriber.userId}" title="查看主页">
        <div style="min-width:0">
          <button class="link-btn name" data-act="openUser" data-uid="${subscriber.userId}">${esc(subscriber.nickname)}</button>
          <div class="sub">${subscriber.follows !== undefined ? `关注 ${subscriber.follows} · 粉丝 ${subscriber.followeds ?? 0}` : ""}</div>
        </div>
      </div>`,
    )
    .join("")}</div>${more}`;
}

function renderAlbum(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载专辑…</div>`;
  if (page.error) return banner("error", page.error);
  const album = page.album;
  if (!album) return empty("专辑不存在");
  return `<div class="hero">
    <div class="hero-cover"><img src="${esc(cover(album.picUrl, 360))}" alt=""><div class="mask">${icon("disc", 46)}</div></div>
    <div class="hero-info">
      <div class="hero-kind">${icon("album", 11)} 专辑</div>
      <h1 class="hero-title">${esc(album.name)}</h1>
      <div class="hero-creator">${album.artists.map((artist) => `<a href="#" class="name" data-act="openArtist" data-id="${artist.id}">${esc(artist.name)}</a>`).join(" / ")}</div>
      <div class="hero-meta"><span>${album.size} 首</span>${album.publishTime ? `<span>发行于 ${esc(fmtDate(album.publishTime))}</span>` : ""}${album.company ? `<span>${esc(album.company)}</span>` : ""}</div>
      ${album.description ? `<div class="hero-desc">${esc(album.description)}</div>` : ""}
      <div class="hero-actions"><button class="btn primary play-all" data-act="playAll" data-list="album">${icon("play", 13)} 播放全部</button></div>
    </div>
  </div>${trackTable(album.tracks, "album", "空专辑")}`;
}

function renderArtist(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载歌手…</div>`;
  if (page.error) return banner("error", page.error);
  const artist = page.artist;
  if (!artist) return empty("歌手不存在");
  if (artistTabId !== artist.id) {
    artistTabId = artist.id;
    artistTab = "songs";
  }
  const tabs = `<div class="page-tabs">
    <button class="page-tab ${artistTab === "songs" ? "active" : ""}" data-act="artistTab" data-tab="songs">歌曲</button>
    <button class="page-tab ${artistTab === "albums" ? "active" : ""}" data-act="artistTab" data-tab="albums">专辑<span class="num">${artist.albumSize || artist.albums?.length || ""}</span></button>
    <button class="page-tab ${artistTab === "detail" ? "active" : ""}" data-act="artistTab" data-tab="detail">歌手详情</button>
    <button class="page-tab ${artistTab === "similar" ? "active" : ""}" data-act="artistTab" data-tab="similar">相似歌手</button>
  </div>`;
  const hero = `<div class="hero">
    <div class="hero-cover" style="border-radius:50%;width:150px;height:150px"><img src="${esc(cover(artist.avatarUrl, 320))}" alt=""></div>
    <div class="hero-info">
      <div class="hero-kind">${icon("mic", 11)} 歌手</div>
      <h1 class="hero-title">${esc(artist.name)}</h1>
      <div class="hero-meta"><span>${artist.musicSize} 首歌曲</span><span>${artist.albumSize} 张专辑</span></div>
      ${artist.briefDesc ? `<div class="hero-desc">${esc(artist.briefDesc)}</div>` : ""}
      <div class="hero-actions"><button class="btn primary play-all" data-act="playAll" data-list="artist">${icon("play", 13)} 播放热门</button><button class="btn" data-act="openArtistSongs" data-id="${artist.id}" data-name="${esc(artist.name)}">${icon("list", 12)} 展示全部歌曲（${artist.musicSize} 首）</button></div>
    </div>
  </div>`;
  if (artistTab === "albums") {
    const albums = artist.albums ?? [];
    return `${hero}${tabs}${albums.length ? `<div class="card-grid">${albums.map((album) => `<button class="card" data-act="openAlbum" data-id="${album.id}"><div class="art"><img src="${esc(cover(album.picUrl, 240))}" alt=""></div><div class="name">${esc(album.name)}</div></button>`).join("")}</div>` : empty("暂无专辑")}`;
  }
  if (artistTab === "detail") {
    return `${hero}${tabs}<div class="section-head"><span class="section-title">${esc(artist.name)}简介</span></div><div class="hero-desc" style="font-size:12px;line-height:1.9">${esc(artist.briefDesc || "暂无歌手简介")}</div>`;
  }
  if (artistTab === "similar") {
    const similar = artist.similar ?? [];
    return `${hero}${tabs}${similar.length ? `<div class="artist-grid">${similar.map((item) => artistCard(item)).join("")}</div>` : empty("暂无相似歌手")}`;
  }
  if (artistPreviewSortId !== artist.id) {
    artistPreviewSortId = artist.id;
    artistPreviewSort = [];
    artistPreviewLikeOrder = "none";
  }
  return `${hero}${tabs}${artistPreviewTable(artist.songs.slice(0, 50))}`;
}

function artistPreviewDisplayTracks(): Track[] {
  const tracks = (page.artist?.songs ?? []).slice(0, 50);
  if (artistPreviewLikeOrder !== "none") tracks.sort((a, b) => (artistPreviewLikeOrder === "first" ? 1 : -1) * (Number(isLiked(b)) - Number(isLiked(a))));
  const priorities: Array<"artist" | "album" | "title" | "duration"> = ["artist", "album", "title", "duration"];
  const active = priorities
    .map((key) => artistPreviewSort.find((entry) => entry.key === key))
    .filter((entry): entry is { key: "title" | "artist" | "album" | "duration"; dir: 1 | -1 } => Boolean(entry));
  if (active.length) {
    tracks.sort((a, b) => {
      for (const sort of active) {
        let result = 0;
        if (sort.key === "title") result = a.name.localeCompare(b.name, "zh-CN");
        else if (sort.key === "artist") result = (a.artists[0]?.name ?? "").localeCompare(b.artists[0]?.name ?? "", "zh-CN");
        else if (sort.key === "album") result = (a.album?.name ?? "").localeCompare(b.album?.name ?? "", "zh-CN");
        else result = (a.duration ?? 0) - (b.duration ?? 0);
        if (result) return result * sort.dir;
      }
      return 0;
    });
  }
  return tracks;
}

function artistPreviewTable(tracks: Track[]): string {
  if (!tracks.length) return empty("暂无歌曲");
  const label = (key: "title" | "artist" | "album" | "duration", text: string): string => {
    const item = artistPreviewSort.find((entry) => entry.key === key);
    return `${text}${item ? (item.dir === 1 ? " ↑" : " ↓") : ""}`;
  };
  const display = artistPreviewDisplayTracks();
  return `<div class="table-head playlist-head">
    <span><button class="sort-default" data-act="resetArtistPreviewSort">默认</button></span>
    <span><button class="head-sort" data-act="artistPreviewSort" data-key="title">${label("title", "标题")}</button></span>
    <span><button class="head-sort" data-act="artistPreviewSort" data-key="artist">${label("artist", "歌手")}</button></span>
    <span class="album-head"><button class="head-sort" data-act="artistPreviewSort" data-key="album">${label("album", "专辑")}</button></span>
    <span style="text-align:right"><button class="head-sort" data-act="artistPreviewSort" data-key="duration">${label("duration", "时长")}</button></span>
    <span><button class="head-sort ${artistPreviewLikeOrder !== "none" ? "active" : ""}" data-act="toggleArtistPreviewLiked" title="喜欢优先/靠后">喜欢${likeOrderMark(artistPreviewLikeOrder)}</button></span>
    <span></span>
  </div><div>${display.map((track, index) => trackRow(track, index, "artist")).join("")}</div>`;
}

function renderSearch(): string {
  const search = page.search;
  if (!search) return empty("输入关键词开始搜索");
  const tab = (kind: string, label: string, count = 0): string =>
    `<button class="page-tab ${search.kind === kind ? "active" : ""}" data-act="searchKind" data-kind="${kind}">${label}<span class="num">${count || ""}</span></button>`;
  const tabs = `<div class="page-tabs search-tabs">
    ${tab("all", "综合")}${tab("song", "单曲", search.songs.length)}${tab("playlist", "歌单", search.playlists.length)}${tab("album", "专辑", search.albums?.length ?? 0)}${tab("artist", "歌手", search.artists?.length ?? 0)}${tab("user", "用户", search.users?.length ?? 0)}${tab("lyric", "歌词", search.lyrics?.length ?? 0)}${tab("radio", "声音", search.radios?.length ?? 0)}
  </div>`;
  if (search.loading) return `${tabs}<div class="empty"><span class="spinner"></span>搜索中…</div>`;
  if (search.error) return `${tabs}${banner("error", search.error)}`;
  if (search.kind === "song" || search.kind === "all") {
    return `${tabs}<div class="section-head"><span class="section-title">“${esc(search.query)}”的歌曲</span><span class="section-sub">${search.total ?? search.songs.length} 个结果</span></div>${trackTable(search.songs, "search", "没有找到歌曲")}`;
  }
  if (search.kind === "playlist") {
    return `${tabs}<div class="section-head"><span class="section-title">“${esc(search.query)}”的歌单</span><span class="section-sub">${search.total ?? search.playlists.length} 个结果</span></div>${search.playlists.length ? `<div class="card-grid">${search.playlists.map(playlistCard).join("")}</div>` : empty("没有找到歌单")}`;
  }
  if (search.kind === "album") {
    const albums = search.albums ?? [];
    return `${tabs}${albums.length ? `<div class="card-grid">${albums.map((album) => `<button class="card" data-act="openAlbum" data-id="${album.id}"><div class="art"><img src="${esc(cover(album.picUrl, 240))}" alt=""></div><div class="name">${esc(album.name)}</div></button>`).join("")}</div>` : empty("没有找到专辑")}`;
  }
  if (search.kind === "artist") {
    const artists = search.artists ?? [];
    return `${tabs}${artists.length ? `<div class="artist-grid">${artists.map((artist) => artistCard(artist)).join("")}</div>` : empty("没有找到歌手")}`;
  }
  if (search.kind === "user") {
    const users = search.users ?? [];
    return `${tabs}${users.length ? `<div class="artist-grid">${users.map((user) => `<button class="artist-card" data-act="openUser" data-uid="${user.userId}"><img src="${esc(cover(user.avatarUrl, 120))}" alt=""><div class="name">${esc(user.nickname)}</div></button>`).join("")}</div>` : empty("没有找到用户")}`;
  }
  if (search.kind === "lyric") {
    const lyrics = search.lyrics ?? [];
    return `${tabs}${lyrics.length ? `<div class="lyric-search-list">${lyrics.map((item) => `<button class="lyric-search-item" data-act="searchQuick" data-query="${esc(item.songName)}"><div class="name">${esc(item.songName)} <span class="muted">${esc(item.artist)}</span></div><div class="sub">${esc(item.lyric.slice(0, 160))}</div></button>`).join("")}</div>` : empty("没有找到歌词")}`;
  }
  const radios = search.radios ?? [];
  return `${tabs}${radios.length ? `<div class="radio-grid">${radios.map((radio) => radioCard(radio)).join("")}</div>` : empty("没有找到声音")}`;
}

function renderRadio(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载声音…</div>`;
  const radio = page.radio;
  if (!radio) return empty("声音不存在");
  const programs = page.radioPrograms ?? [];
  return `<div class="radio-detail">
    <div class="radio-info">
      <img src="${esc(cover(radio.picUrl, 360))}" alt="">
      <div class="hero-kind">${icon("radio", 11)} 播客 / 声音</div>
      <h1>${esc(radio.name)}</h1>
      <div class="muted">${esc(radio.dj?.nickname ?? "")}${radio.programCount ? ` · ${radio.programCount} 期` : ""}${radio.subCount ? ` · ${fmtCount(radio.subCount)} 订阅` : ""}</div>
      ${radio.desc ? `<div class="hero-desc">${esc(radio.desc)}</div>` : ""}
      <div class="hero-actions"><button class="btn primary" data-act="playAll" data-list="radio">${icon("play", 13)} 播放全部</button></div>
    </div>
    <div class="radio-programs">${trackTable(programs, "radio", "暂无节目")}</div>
  </div>`;
}

function artistAllDisplayTracks(): Track[] {
  let tracks = (page.artistAll ?? []).slice();
  const query = artistAllQuery.trim().toLowerCase();
  if (query) {
    tracks = tracks.filter((track) =>
      `${track.name} ${track.artists.map((artist) => artist.name).join(" ")} ${track.album?.name ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }
  if (artistAllLikeOrder !== "none") tracks.sort((a, b) => (artistAllLikeOrder === "first" ? 1 : -1) * (Number(isLiked(b)) - Number(isLiked(a))));
  const priorities: Array<"artist" | "album" | "title" | "duration"> = ["artist", "album", "title", "duration"];
  const active = priorities
    .map((key) => artistAllSort.find((entry) => entry.key === key))
    .filter((entry): entry is { key: "title" | "artist" | "album" | "duration"; dir: 1 | -1 } => Boolean(entry));
  if (active.length) {
    tracks.sort((a, b) => {
      for (const sort of active) {
        let result = 0;
        if (sort.key === "title") result = a.name.localeCompare(b.name, "zh-CN");
        else if (sort.key === "artist") result = (a.artists[0]?.name ?? "").localeCompare(b.artists[0]?.name ?? "", "zh-CN");
        else if (sort.key === "album") result = (a.album?.name ?? "").localeCompare(b.album?.name ?? "", "zh-CN");
        else result = (a.duration ?? 0) - (b.duration ?? 0);
        if (result) return result * sort.dir;
      }
      return 0;
    });
  }
  return tracks;
}

function renderArtistSongs(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载全部歌曲…</div>`;
  const artist = page.artist;
  const id = artist?.id ?? 0;
  if (artistAllSortId !== id) {
    artistAllSortId = id;
    artistAllSort = [];
    artistAllLikeOrder = "none";
    artistAllQuery = "";
  }
  const sorted = artistAllDisplayTracks();
  const name = artist?.name ?? page.title;
  const label = (key: "title" | "artist" | "album" | "duration", text: string): string => {
    const item = artistAllSort.find((entry) => entry.key === key);
    return `${text}${item ? (item.dir === 1 ? " ↑" : " ↓") : ""}`;
  };
  const head = `<div class="table-head playlist-head">
    <span><button class="sort-default" data-act="resetArtistSort">默认</button></span>
    <span><button class="head-sort" data-act="artistSort" data-key="title">${label("title", "标题")}</button></span>
    <span><button class="head-sort" data-act="artistSort" data-key="artist">${label("artist", "歌手")}</button></span>
    <span class="album-head"><button class="head-sort" data-act="artistSort" data-key="album">${label("album", "专辑")}</button></span>
    <span style="text-align:right"><button class="head-sort" data-act="artistSort" data-key="duration">${label("duration", "时长")}</button></span>
    <span><button class="head-sort ${artistAllLikeOrder !== "none" ? "active" : ""}" data-act="toggleArtistLiked" title="喜欢优先/靠后">喜欢${likeOrderMark(artistAllLikeOrder)}</button></span>
    <span></span>
  </div>`;
  const search = `<div class="playlist-tools artist-all-tools"><div class="playlist-search"><input id="artist-all-search" type="search" value="${esc(artistAllQuery)}" placeholder="在这个歌手界面查找歌曲…" /><button class="icon-btn" data-act="artistAllSearch" title="查找">${icon("search", 13)}</button></div></div>`;
  const rows = sorted.map((track, index) => trackRow(track, index, "artistAll")).join("");
  const loading = page.artistAllLoading
    ? `<div class="empty"><span class="spinner"></span>加载更多…</div>`
    : page.artistAllHasMore
      ? `<div class="show-more-row"><button class="btn small" data-act="loadMoreArtistSongs">加载更多</button></div>`
      : `<div class="show-more-row muted tiny">已加载全部 ${sorted.length} 首</div>`;
  return `<div class="section-head"><span class="section-title">${esc(name)} · 全部歌曲</span><span class="section-sub">${sorted.length} / ${page.artistAllTotal ?? sorted.length} 首</span><button class="btn small" data-act="back">返回</button></div>${search}${head}${rows ? `<div>${rows}</div>` : empty(artistAllQuery ? "没有匹配的歌曲" : "暂无歌曲")}${loading}`;
}

function renderQueue(): string {
  return `<div class="section-head"><span class="section-title">播放队列</span><span class="section-sub">${queue.length} 首</span><button class="btn small" data-act="clearQueue">清空</button></div>${trackTable(queue, "queue", "队列是空的", { remove: true })}`;
}

function renderRecent(): string {
  const tracks = page.recent ?? [];
  return `<div class="section-head"><span class="section-title">最近播放</span><span class="section-sub">${tracks.length} 首</span></div>${trackTable(tracks, "recent", "还没有播放记录")}`;
}

function renderCollections(): string {
  if (!account) return `${banner("info", "登录后可查看你收藏的歌单。")}<button class="btn primary" data-act="login">登录网易云音乐</button>`;
  const collections = page.collections ?? [];
  if (!collections.length) return empty("还没有收藏歌单");
  return `<div class="section-head"><span class="section-title">我的收藏</span><span class="section-sub">${collections.length} 个歌单</span></div><div class="card-grid">${collections.map(playlistCard).join("")}</div>`;
}

function renderLocal(): string {
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在扫描本地音乐…</div>`;
  const tracks = page.local ?? [];
  if (!tracks.length) return empty("本地音乐目录里没有找到音频文件。<br>可在设置 → 音质与下载 中修改「本地音乐目录」。");
  return `<div class="section-head"><span class="section-title">本地音乐</span><span class="section-sub">${tracks.length} 个文件</span><button class="btn small" data-act="openSettings" data-tab="quality">修改目录</button></div>
    <div class="table-head"><span>#</span><span>标题</span><span>歌手</span><span class="album-head">专辑</span><span style="text-align:right">大小</span><span></span><span></span></div>
    ${tracks
      .map(
        (item, index) => `<div class="track-row" data-act="playLocal" data-path="${esc(item.path)}">
          <div class="idx-cell"><span class="idx">${index + 1}</span><button class="thumb-btn" data-act="openSongDetail" data-id="${item.id}" title="查看本地音乐详情">${icon("music", 14)}</button></div>
          <div class="track-title"><span class="name">${esc(item.name)}</span><span class="q-tag free">${esc(item.ext.replace(".", "").toUpperCase())}</span></div>
          <div class="track-artist">${esc(item.artists || "本地音乐")}</div>
          <div class="track-album">${esc(item.album)}</div>
          <div class="track-duration">${(item.size / 1024 / 1024).toFixed(1)} MB</div>
          <span></span><span></span>
        </div>`,
      )
      .join("")}`;
}

function renderCloud(): string {
  if (!account) return `${banner("info", "登录后可查看我的音乐网盘。")}<button class="btn primary" data-act="login">登录网易云音乐</button>`;
  const tracks = page.cloud ?? [];
  if (page.loading) return `<div class="empty"><span class="spinner"></span>正在加载音乐网盘…</div>`;
  if (!tracks.length) return empty("音乐网盘里还没有歌曲，或当前接口暂不返回网盘内容。");
  return `<div class="section-head"><span class="section-title">我的音乐网盘</span><span class="section-sub">${tracks.length} 首</span></div>${trackTable(tracks, "cloud")}`;
}

function renderDownloads(): string {
  if (!downloads.length) return empty("没有下载任务。");
  return `<div class="section-head"><span class="section-title">下载管理</span><span class="section-sub">${downloads.length} 个任务</span><button class="btn small" data-act="openDownloadDir">${icon("folder", 11)} 打开目录</button><button class="btn small" data-act="clearDownloads">清理已完成</button></div>
    ${downloads
      .map((task) => {
        const percent = task.total ? Math.round((task.received / task.total) * 100) : 0;
        const status =
          task.status === "done"
            ? "已完成"
            : task.status === "error"
              ? `失败：${task.error ?? ""}`
              : task.status === "cancelled"
                ? "已取消"
                : task.status === "queued"
                  ? "排队中"
                  : `${percent}%`;
        return `<div class="task" style="padding:9px 10px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px"><span style="font-size:12.5px">${esc(task.name)}</span><span class="muted tiny">${esc(task.quality)}</span><span class="spacer"></span>${task.status === "downloading" || task.status === "queued" ? `<button class="icon-btn" data-act="cancelDownload" data-id="${esc(task.id)}">${icon("close", 12)}</button>` : ""}</div>
          <div class="muted tiny" style="margin-top:2px">${esc(task.artists)} · ${esc(status)}</div>
          <div style="height:3px;background:var(--hover);border-radius:2px;margin-top:5px"><i style="display:block;height:100%;width:${task.status === "done" ? 100 : percent}%;background:var(--red);border-radius:2px"></i></div>
        </div>`;
      })
      .join("")}`;
}

function renderNow(): string {
  if (!player?.track) {
    return `${empty("还没有正在播放的歌曲。<br>从推荐、歌单或搜索里挑一首吧。")}<div style="text-align:center"><button class="btn primary" data-act="nav" data-nav="recommend">去推荐音乐</button></div>`;
  }
  const track = player.track;
  const requested = QUALITY_TEXT[player.quality] ?? player.quality;
  const actual = QUALITY_TEXT[player.actualQuality] ?? player.actualQuality;
  const downgraded = player.actualQuality && player.actualQuality !== player.quality && player.actualQuality !== "local";
  const badges = `<span class="pill accent">音质 ${esc(actual || requested)}${downgraded ? ` · 请求 ${esc(requested)}` : ""}</span><span class="pill">${esc(outputLabel())}</span>${player.loading ? `<span class="pill">缓冲 ${player.preparing ? `${player.preparing}%` : ""}</span>` : ""}`;
  const lines = lyricLines.length
    ? lyricLines
        .map(
          (line, index) =>
            `<div class="lyric-line" data-idx="${index}">${esc(line.text) || "&nbsp;"}${line.translation ? `<span class="tr">${esc(line.translation)}</span>` : ""}</div>`,
        )
        .join("")
    : `<div class="lyric-line">暂无歌词</div>`;
  return `<div class="now-page">
    <div class="now-left">
      <img class="now-art" src="${esc(cover(track.album?.picUrl, 500))}" alt="">
      <div class="now-title">${esc(track.name)}</div>
      <div class="now-artists">${esc(track.artists.map((artist) => artist.name).join(" / "))}</div>
      <div class="now-badges">${badges}</div>
      <div class="now-actions">
        <button class="btn small ${player.liked ? "primary" : ""}" data-act="likeTrack" data-id="${track.id}">${icon("heart", 12)} ${player.liked ? "已喜欢" : "喜欢"}</button>
        <button class="btn small" data-act="downloadCurrent">${icon("download", 12)} 下载</button>
        <button class="btn small" data-act="openQueue">${icon("list", 12)} 队列 ${queue.length}</button>
      </div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:16px">
        <span class="tiny muted" id="now-cur">${fmtTime(player.position)}</span>
        <input id="now-seek" type="range" min="0" max="${Math.max(1, player.duration)}" value="${Math.min(player.position, player.duration || player.position)}" step="0.5" style="flex:1" />
        <span class="tiny muted" id="now-dur">${fmtTime(player.duration)}</span>
      </div>
      ${player.error ? banner("error", player.error) : ""}
    </div>
    <div class="now-right">
      <div class="lyric-box" id="lyric-box">${lines}</div>
    </div>
  </div>`;
}

// ------------------------------------------------------------- interactions

function onClick(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (queuePopupOpen && !target.closest(".queue-popup") && !target.closest('[data-act="openQueue"]')) {
    queuePopupOpen = false;
    renderQueuePopup();
  }
  if (!target.closest(".ctx-menu")) closeContextMenu();
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
    case "openAlbum":
      event.preventDefault();
      send("openAlbum", { id: Number(el.dataset.id) });
      break;
    case "openArtist":
      event.preventDefault();
      send("openArtist", { id: Number(el.dataset.id) });
      break;
    case "openArtistSongs":
      send("openArtistSongs", { id: Number(el.dataset.id), name: el.dataset.name ?? "" });
      break;
    case "openRadio": {
      const id = Number(el.dataset.id);
      const radio =
        page.home?.radios.find((item) => item.id === id) ??
        page.search?.radios?.find((item) => item.id === id);
      if (radio) send("openRadio", { radio });
      break;
    }
    case "openSettings":
      send("openSettings", { tab: el.dataset.tab ?? "account" });
      break;
    case "openNow":
      send("openNow");
      break;
    case "openSongDetail":
      send("openSongDetail", { id: Number(el.dataset.id) });
      break;
    case "toggleSongComments":
      songCommentsOpen = !songCommentsOpen;
      if (songCommentsOpen) send("openSongComments", { id: page.song?.track.id });
      render();
      break;
    case "sendComment": {
      const input = qs<HTMLTextAreaElement>("#comment-input");
      const content = input?.value.trim() ?? "";
      if (!content) {
        toast("请输入评论内容", "error");
        break;
      }
      send("postComment", { id: page.song?.track.id, content });
      break;
    }
    case "loadMoreSongComments":
      send("loadComments", {
        resource: page.song ? `R_SO_4_${page.song.track.id}` : "",
        id: page.song?.track.id ?? 0,
        offset: comments?.comments.length ?? 0,
      });
      break;
    case "seekLyric":
      send("seek", { value: Number(el.dataset.time ?? 0) });
      break;
    case "openMyProfile":
      send("openMyProfile");
      break;
    case "openUser":
      send("openUser", { uid: Number(el.dataset.uid) });
      break;
    case "openArtistByName":
      send("openArtistByName", { name: el.dataset.name });
      break;
    case "fixSampleRate":
      send("fixSampleRate");
      break;
    case "openQueue":
      send("openQueue");
      break;
    case "locateQueuePlaylist": {
      const source = player?.index != null ? queueSources[player.index] : undefined;
      if (!source) {
        toast("当前歌曲没有可定位的来源", "info");
        break;
      }
      pendingLocate = true;
      if (source.kind === "album") send("openAlbum", { id: source.id });
      else if (source.kind === "artist") send("openArtistSongs", { id: source.id, name: source.name });
      else if (source.kind === "playlist" || !source.kind) send("openPlaylist", { id: source.id });
      else {
        pendingLocate = false;
        toast("当前来源不支持定位", "info");
      }
      break;
    }
    case "locateQueueCurrent": {
      const row = qs<HTMLElement>(".queue-row.current");
      if (!row) {
        toast("播放列表里没有当前歌曲", "info");
        break;
      }
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("flash");
      window.setTimeout(() => row.classList.remove("flash"), 900);
      break;
    }
    case "closeQueuePopup":
      queuePopupOpen = false;
      renderQueuePopup();
      break;
    case "playQueueIndex":
      send("playQueueIndex", { index: Number(el.dataset.index) });
      break;
    case "cycleMode":
      if (player) send("mode", { mode: nextPlayMode(player.mode ?? "order") });
      break;
    case "playNext": {
      const track = findTrack(Number(el.dataset.id));
      if (track) send("playNext", { track, source: currentPlaybackSource() });
      break;
    }
    case "openFavorite":
      send("openFavorite", { id: Number(el.dataset.id ?? player?.track?.id ?? 0) });
      break;
    case "artistTab":
      artistTab = (el.dataset.tab as typeof artistTab) ?? "songs";
      render();
      break;
    case "artistPreviewSort": {
      const key = el.dataset.key as "title" | "artist" | "album" | "duration";
      const existing = artistPreviewSort.find((entry) => entry.key === key);
      if (existing) existing.dir = existing.dir === 1 ? -1 : 1;
      else artistPreviewSort.push({ key, dir: 1 });
      render();
      break;
    }
    case "resetArtistPreviewSort":
      artistPreviewSort = [];
      artistPreviewLikeOrder = "none";
      render();
      break;
    case "toggleArtistPreviewLiked":
      artistPreviewLikeOrder = nextLikeOrder(artistPreviewLikeOrder);
      render();
      break;
    case "artistSort": {
      const key = el.dataset.key as "title" | "artist" | "album" | "duration";
      const existing = artistAllSort.find((entry) => entry.key === key);
      if (existing) existing.dir = existing.dir === 1 ? -1 : 1;
      else artistAllSort.push({ key, dir: 1 });
      render();
      break;
    }
    case "resetArtistSort":
      artistAllSort = [];
      artistAllLikeOrder = "none";
      artistAllQuery = "";
      render();
      break;
    case "artistAllSearch": {
      const input = qs<HTMLInputElement>("#artist-all-search");
      artistAllQuery = input?.value.trim() ?? "";
      render();
      break;
    }
    case "toggleArtistLiked":
      artistAllLikeOrder = nextLikeOrder(artistAllLikeOrder);
      render();
      break;
    case "loadMoreArtistSongs":
      if (!page.artistAllLoading && page.artistAllHasMore) send("loadMoreArtistSongs");
      break;
    case "zoomCover":
      coverPreview = {
        url: el.dataset.src ?? "",
        name: el.dataset.name ?? "",
        artist: el.dataset.artist ?? "",
      };
      renderCoverPreview();
      break;
    case "downloadCover":
      if (coverPreview) send("downloadCover", coverPreview);
      break;
    case "closeCover":
      coverPreview = null;
      renderCoverPreview();
      break;
    case "sortPlaylist": {
      const key = el.dataset.key as "title" | "artist" | "album" | "duration";
      const existing = playlistSort.find((entry) => entry.key === key);
      if (existing) existing.dir = existing.dir === 1 ? -1 : 1;
      else playlistSort.push({ key, dir: 1 });
      render();
      break;
    }
    case "resetPlaylistSort":
      playlistSort = [];
      playlistLikeOrder = "none";
      playlistQuery = "";
      render();
      break;
    case "toggleLikedFirst":
      playlistLikeOrder = nextLikeOrder(playlistLikeOrder);
      render();
      break;
    case "playlistSearch": {
      const input = qs<HTMLInputElement>("#playlist-search");
      playlistQuery = input?.value.trim() ?? "";
      render();
      break;
    }
    case "locateCurrent": {
      const id = player?.track?.id;
      const row = id ? qs<HTMLElement>(`.track-row[data-track-id="${id}"]`) : null;
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.add("locate-flash");
        setTimeout(() => row.classList.remove("locate-flash"), 1600);
      } else if (page.kind === "artist" && page.artist) {
        pendingLocate = true;
        send("openArtistSongs", { id: page.artist.id, name: page.artist.name });
      } else {
        toast("当前播放歌曲不在这个列表里", "info");
      }
      break;
    }
    case "favoriteTo":
      send("favoriteTo", {
        trackId: Number(el.dataset.trackId ?? 0),
        playlistId: Number(el.dataset.playlistId ?? 0),
      });
      favoritePicker = null;
      renderFavoritePicker();
      break;
    case "closeFavorite":
      favoritePicker = null;
      renderFavoritePicker();
      break;
    case "noop":
      break;
    case "back":
      send("back");
      break;
    case "login":
      send("login");
      break;
    case "refreshPage":
      send("refreshPage");
      break;
    case "playTrack": {
      const id = Number(el.dataset.trackId ?? el.dataset.id);
      const track = findTrack(id);
      if (!track) break;
      const kind = el.dataset.list ?? "";
      const fallback = listForTrack(track);
      const list = kind ? currentList(kind) : fallback.list;
      const index = kind ? Number(el.dataset.index ?? 0) : fallback.index;
      send("playTrack", { track, list, index, source: currentPlaybackSource() });
      break;
    }
    case "trackMenu": {
      const track = findTrack(Number(el.dataset.id));
      if (!track) break;
      const rect = el.getBoundingClientRect();
      showContextMenu(track, rect.left, rect.bottom + 4);
      break;
    }
    case "playAll": {
      const tracks = currentList(el.dataset.list ?? "");
      if (tracks.length) send("playAll", { tracks, index: 0, source: currentPlaybackSource() });
      break;
    }
    case "enqueuePlaylist":
      send("enqueuePlaylist", { id: Number(el.dataset.id) });
      break;
    case "downloadPlaylist": {
      const tracks = page.playlist?.tracks ?? [];
      for (const track of tracks) send("downloadTrack", { track });
      break;
    }
    case "playlistMenu": {
      const id = Number(el.dataset.id ?? 0);
      const rect = el.getBoundingClientRect();
      showPlaylistMenu(id, rect.left, rect.bottom + 4);
      break;
    }
    case "likeTrack": {
      const id = Number(el.dataset.id);
      const track = findTrack(id);
      if (!track) break;
      const wasLiked = isLiked(track);
      if (wasLiked) likedIds.delete(id);
      else likedIds.add(id);
      send("likeTrack", { id });
      if (page.kind === "now") render();
      else updateRowLikes();
      break;
    }
    case "downloadTrack": {
      const track = findTrack(Number(el.dataset.id));
      if (track) send("downloadTrack", { track });
      break;
    }
    case "downloadCurrent":
      send("downloadCurrent");
      break;
    case "cancelDownload":
      send("cancelDownload", { id: el.dataset.id });
      break;
    case "clearDownloads":
      send("clearDownloads");
      break;
    case "openDownloadDir":
      send("openDownloadDir");
      break;
    case "tab":
      send("tab", { tab: el.dataset.tab });
      break;
    case "loadMoreComments":
      send("loadComments", {
        resource: commentsResource(),
        id: currentResourceId(),
        offset: comments?.comments.length ?? 0,
      });
      break;
    case "loadMoreSubscribers":
      send("loadSubscribers", { id: page.playlist?.playlist.id, offset: subscribers?.subscribers.length ?? 0 });
      break;
    case "searchQuick":
      send("search", { query: el.dataset.query ?? "", kind: "song" });
      break;
    case "searchKind":
      send("searchKind", { kind: el.dataset.kind, query: page.search?.query });
      break;
    case "clearQueue":
      send("clearQueue");
      break;
    case "removeQueue":
      send("removeFromQueue", { index: Number(el.dataset.index) });
      break;
    case "playLocal":
      send("playLocal", { path: el.dataset.path });
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
    case "ctx-play":
      if (contextTrack) send("playTrack", { track: contextTrack, list: contextList, index: contextIndex, source: currentPlaybackSource() });
      closeContextMenu();
      break;
    case "ctx-like":
      if (contextTrack) send("likeTrack", { id: contextTrack.id });
      closeContextMenu();
      break;
    case "ctx-favorite":
      if (contextTrack) send("openFavorite", { id: contextTrack.id });
      closeContextMenu();
      break;
    case "ctx-remove":
      if (contextTrack && page.kind === "playlist" && page.playlist) {
        send("removeFromPlaylist", { playlistId: page.playlist.playlist.id, trackId: contextTrack.id });
      }
      closeContextMenu();
      break;
    case "ctx-next":
      if (contextTrack) send("playNext", { track: contextTrack, source: currentPlaybackSource() });
      closeContextMenu();
      break;
    case "ctx-detail":
      if (contextTrack) send("openSongDetail", { id: contextTrack.id });
      closeContextMenu();
      break;
    case "ctx-copy-name":
      if (contextTrack) send("copy", { text: contextTrack.name });
      closeContextMenu();
      break;
    case "ctx-copy-artist":
      if (contextTrack) send("copy", { text: contextTrack.artists.map((artist) => artist.name).join(" / ") });
      closeContextMenu();
      break;
    case "ctx-album":
      if (contextTrack) send("openAlbum", { id: contextTrack.album.id });
      closeContextMenu();
      break;
    case "ctx-artist":
      if (contextTrack?.artists[0]) send("openArtist", { id: contextTrack.artists[0].id });
      closeContextMenu();
      break;
    case "ctx-download":
      if (contextTrack) send("downloadTrack", { track: contextTrack });
      closeContextMenu();
      break;
    case "ctx-refresh":
      send("refreshPage");
      closeContextMenu();
      break;
    case "ctx-copy-link":
      if (page.playlist) send("copy", { text: `https://music.163.com/#/playlist?id=${page.playlist.playlist.id}` });
      closeContextMenu();
      break;
    case "ctx-subscribe":
      if (page.playlist) send("playlistSubscribe", { id: page.playlist.playlist.id });
      closeContextMenu();
      break;
    default:
      break;
  }
}

function commentsResource(): string {
  const kind = page.kind;
  const id = currentResourceId();
  if (kind === "playlist") return `A_PL_0_${id}`;
  if (kind === "album") return `R_AL_3_${id}`;
  if (kind === "artist") return `R_AL_3_${id}`;
  return "";
}

function currentResourceId(): number {
  if (page.kind === "playlist") return page.playlist?.playlist.id ?? 0;
  if (page.kind === "album") return page.album?.id ?? 0;
  if (page.kind === "artist") return page.artist?.id ?? 0;
  return 0;
}

function updateRowHighlights(): void {
  const current = player?.track?.id;
  qsa<HTMLElement>(".track-row").forEach((row) => row.classList.toggle("current", Number(row.dataset.trackId) === current));
}

function updateRowLikes(): void {
  qsa<HTMLElement>(".track-like").forEach((button) => {
    const id = Number(button.dataset.id);
    button.classList.toggle("active", likedIds.has(id) || player?.track?.id === id && Boolean(player.liked));
  });
}

function showContextMenu(track: Track, x: number, y: number): void {
  const root = qs("#ctx-root");
  if (!root) return;
  contextTrack = track;
  const found = listForTrack(track);
  contextList = found.list;
  contextIndex = found.index;
  root.innerHTML = `<div class="ctx-menu" style="left:${Math.min(x, window.innerWidth - 210)}px;top:${Math.min(y, window.innerHeight - 260)}px">
    <button class="ctx-item" data-act="ctx-play">${icon("play", 12)} 播放</button>
    <button class="ctx-item" data-act="ctx-next">${icon("plus", 12)} 下一首播放</button>
    <button class="ctx-item" data-act="ctx-detail">${icon("comment", 12)} 歌曲详情与评论</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-act="ctx-copy-name">${icon("music", 12)} 复制歌曲名</button>
    <button class="ctx-item" data-act="ctx-copy-artist">${icon("mic", 12)} 复制歌手名</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-act="ctx-album">${icon("album", 12)} 查看专辑</button>
    <button class="ctx-item" data-act="ctx-artist">${icon("users", 12)} 查看歌手</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-act="ctx-like">${icon("heart", 12)} ${isLiked(track) ? "取消喜欢" : "添加喜欢"}</button>
    <button class="ctx-item" data-act="ctx-favorite">${icon("star", 12)} 收藏到歌单</button>
    ${page.kind === "playlist" && page.playlist ? `<button class="ctx-item danger" data-act="ctx-remove">${icon("trash", 12)} 从歌单删除</button>` : ""}
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-act="ctx-download">${icon("download", 12)} 下载</button>
  </div>`;
}

function closeContextMenu(): void {
  const root = qs("#ctx-root");
  if (root) root.innerHTML = "";
  contextTrack = null;
}

function showPlaylistMenu(id: number, x: number, y: number): void {
  const root = qs("#ctx-root");
  if (!root) return;
  contextTrack = null;
  root.innerHTML = `<div class="ctx-menu" style="left:${Math.min(x, window.innerWidth - 210)}px;top:${Math.min(y, window.innerHeight - 220)}px">
    <button class="ctx-item" data-act="ctx-subscribe">${icon("star", 12)} 收藏歌单</button>
    <button class="ctx-item" data-act="ctx-copy-link">${icon("external", 12)} 复制歌单链接</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" data-act="ctx-refresh">${icon("refresh", 12)} 刷新歌单</button>
  </div>`;
}

function onContextMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const row = target?.closest<HTMLElement>(".track-row");
  if (!row) return;
  event.preventDefault();
  const track = findTrack(Number(row.dataset.trackId));
  if (track) showContextMenu(track, event.clientX, event.clientY);
}

// --------------------------------------------------------------------- lyric

function rebuildLyric(): void {
  const lines = parseLrc(lyric.lrc);
  const trans = parseLrc(lyric.translation);
  lyricLines = lines.map((line) => {
    const match = trans.find((item) => Math.abs(item.time - line.time) < 0.15);
    return { time: line.time, text: line.text, translation: match?.text };
  });
  lastLyricIndex = -1;
}

function updateLyricHighlight(force = false): void {
  if (page.kind !== "now") return;
  const box = qs("#lyric-box");
  if (!box || !player) return;
  let index = -1;
  for (let i = 0; i < lyricLines.length; i += 1) {
    if (lyricLines[i].time <= player.position + 0.15) index = i;
    else break;
  }
  if (index === lastLyricIndex && !force) return;
  lastLyricIndex = index;
  const nodes = qsa<HTMLElement>(".lyric-line", box);
  nodes.forEach((node, i) => node.classList.toggle("active", i === index));
}

// --------------------------------------------------------------------- state

function applyInit(state: InitState): void {
  player = state.player;
  account = state.account;
  queue = state.queue ?? [];
  queueSources = state.queueSources ?? [];
  page = state.page;
  if (page.kind === "song") songPageId = page.song?.track.id ?? 0;
  downloads = state.downloads ?? [];
  lastTrackId = player?.track?.id ?? 0;
  if (player?.likedIds) likedIds = new Set(player.likedIds);
  if (player?.track) likedIds.add(player.track.id);
  render();
}

function updateProgress(): void {
  if (!player) return;
  updateBottomProgress();
  if (page.kind === "now") {
    const seek = qs<HTMLInputElement>("#now-seek");
    const cur = qs("#now-cur");
    const dur = qs("#now-dur");
    if (seek && document.activeElement !== seek) {
      seek.max = String(Math.max(1, player.duration));
      seek.value = String(Math.min(player.position, player.duration || player.position));
    }
    if (cur) cur.textContent = fmtTime(player.position);
    if (dur) dur.textContent = fmtTime(player.duration);
    updateLyricHighlight();
  } else if (page.kind === "song") {
    updateSongLyricHighlight();
  }
}

function updateBottomProgress(): void {
  if (!player) return;
  const seek = qs<HTMLInputElement>("#bp-seek");
  const cur = qs("#bp-cur");
  const dur = qs("#bp-dur");
  if (seek && document.activeElement !== seek) {
    seek.max = String(Math.max(1, player.duration));
    seek.value = String(Math.min(player.position, player.duration || player.position));
  }
  if (cur) cur.textContent = fmtTime(player.position);
  if (dur) dur.textContent = fmtTime(player.duration);
  const range = qs<HTMLElement>("#bp-range");
  const played = qs<HTMLElement>("#bp-played");
  const buffered = qs<HTMLElement>("#bp-buffered");
  if (!range || !played || !buffered) return;
  const inner = Math.max(1, range.clientWidth - 10);
  const duration = Math.max(0.1, player.duration || 0);
  const playPct = Math.max(0, Math.min(1, player.position / duration));
  const bufPct = Math.max(playPct, Math.min(1, (player.buffered ?? 0) / duration));
  played.style.width = `${inner * playPct}px`;
  buffered.style.width = `${inner * bufPct}px`;
}

function updateSongLyricHighlight(): void {
  if (page.kind !== "song" || !page.song || !player) return;
  if (player.track?.id !== page.song.track.id) return;
  const box = qs<HTMLElement>("#song-lyric") ?? qs<HTMLElement>(".song-detail .lyric-box");
  if (!box) return;
  if (songLyricTrackId !== page.song.track.id) {
    songLyricTrackId = page.song.track.id;
    songLyricIndex = -1;
    lyricManualUntil = 0;
    if (lyricManualTimer) {
      clearTimeout(lyricManualTimer);
      lyricManualTimer = undefined;
    }
  }
  const lines = parseLrc(page.song.lyric.lrc);
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= player.position + 0.15) index = i;
    else break;
  }
  const nodes = qsa<HTMLElement>(".lyric-line", box);
  nodes.forEach((node, i) => node.classList.toggle("active", i === index));
  if (index !== songLyricIndex) {
    songLyricIndex = index;
    if (Date.now() >= lyricManualUntil) scrollLyricToIndex(box, index, true);
  }
}

function scrollLyricToIndex(box: HTMLElement, index: number, smooth: boolean): void {
  if (index < 0) return;
  const nodes = qsa<HTMLElement>(".lyric-line", box);
  const node = nodes[index];
  if (!node || !box.clientHeight) return;
  const top = node.offsetTop - box.clientHeight / 2 + node.offsetHeight / 2;
  const next = Math.max(0, top);
  if (typeof box.scrollTo === "function") box.scrollTo({ top: next, behavior: smooth ? "smooth" : "auto" });
  else box.scrollTop = next;
}

function onLyricWheelScroll(event: WheelEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest("#song-lyric")) return;
  lyricManualUntil = Date.now() + 5000;
  if (lyricManualTimer) clearTimeout(lyricManualTimer);
  lyricManualTimer = setTimeout(() => {
    lyricManualTimer = undefined;
    if (page.kind !== "song" || !player) return;
    const box = qs<HTMLElement>("#song-lyric");
    if (!box) return;
    updateSongLyricHighlight();
    scrollLyricToIndex(box, songLyricIndex, true);
  }, 5000);
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "init":
      applyInit(msg.state);
      break;
    case "page":
      if (page.kind !== msg.page.kind || page.title !== msg.page.title) {
        comments = null;
        subscribers = null;
      }
      if (msg.page.kind === "song") {
        const id = msg.page.song?.track.id ?? 0;
        if (songPageId !== id) {
          songPageId = id;
          songCommentsOpen = false;
          comments = null;
        }
      } else {
        songCommentsOpen = false;
      }
      page = msg.page;
      render();
      if (pendingLocate) {
        pendingLocate = false;
        requestAnimationFrame(() => {
          const id = player?.track?.id;
          const row = id ? qs<HTMLElement>(`.track-row[data-track-id="${id}"]`) : null;
          row?.scrollIntoView({ block: "center", behavior: "smooth" });
          row?.classList.add("locate-flash");
          if (row) setTimeout(() => row.classList.remove("locate-flash"), 1600);
        });
      }
      break;
    case "state": {
      const previous = player;
      player = msg.state;
      if (player?.likedIds) likedIds = new Set(player.likedIds);
      const songChanged = (player?.track?.id ?? 0) !== lastTrackId;
      if (songChanged) {
        lastTrackId = player?.track?.id ?? 0;
        lyric = { lrc: "", translation: "" };
        rebuildLyric();
        if (player?.track) likedIds.add(player.track.id);
      }
      if (page.kind === "now") {
        if (songChanged) render();
        else updateProgress();
      } else if (page.kind === "song") {
        if (songChanged || previous?.error !== player?.error) render();
        else updateProgress();
      } else if (songChanged) {
        updateRowHighlights();
      }
      renderBottomPlayer();
      if (previous && previous.liked !== player.liked) {
        if (player.liked && player.track) likedIds.add(player.track.id);
        else if (player.track) likedIds.delete(player.track.id);
        updateRowLikes();
      }
      break;
    }
    case "account":
      account = msg.account;
      renderAccount();
      if (page.kind === "following" || page.kind === "cloud") render();
      break;
    case "queue":
      queue = msg.tracks;
      queueSources = msg.sources ?? [];
      if (page.kind === "queue" || page.kind === "now") render();
      renderQueuePopup();
      break;
    case "toggleQueue":
      queuePopupOpen = !queuePopupOpen;
      renderQueuePopup();
      break;
    case "queuePopup":
      queuePopupOpen = msg.open;
      renderQueuePopup();
      break;
    case "favoritePicker":
      favoritePicker = { trackId: msg.trackId, playlists: msg.playlists };
      renderFavoritePicker();
      break;
    case "comments":
      comments = msg.view;
      commentsLoadingMore = false;
      if (page.kind === "playlist" || page.kind === "album" || page.kind === "artist" || page.kind === "song" || page.kind === "now") render();
      break;
    case "subscribers":
      subscribers = msg.view;
      if (page.kind === "playlist") render();
      break;
    case "downloads":
      downloads = msg.tasks;
      if (page.kind === "downloads") render();
      break;
    case "lyric":
      if (msg.songId === player?.track?.id) {
        lyric = { lrc: msg.lrc, translation: msg.translation };
        rebuildLyric();
        if (page.kind === "now") render();
      }
      break;
    case "toast":
      toast(msg.message, msg.kind);
      break;
    case "theme":
      document.body.dataset.theme = msg.kind;
      break;
    case "load":
      void editorAudio.load(msg.request);
      break;
    case "control":
      editorAudio.control(msg.action, msg.value);
      break;
    case "loginResult":
      toast(msg.message, msg.ok ? "success" : "error");
      break;
    case "openLogin":
      send("login");
      break;
    case "switchTab":
      if (msg.tab) send("tab", { tab: msg.tab });
      break;
  }
});

document.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | null;
  if (target?.id === "now-seek" && player) {
    const value = Number(target.value);
    const label = qs("#now-cur");
    if (label) label.textContent = fmtTime(value);
  }
  if (target?.id === "bp-seek" && player) {
    const value = Number(target.value);
    const label = qs("#bp-cur");
    if (label) label.textContent = fmtTime(value);
    if (bpSeekTimer) clearTimeout(bpSeekTimer);
    bpSeekTimer = setTimeout(() => send("seek", { value }), 160);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement | null;
  if (target?.id === "now-seek") send("seek", { value: Number(target.value) });
  if (target?.id === "bp-seek") {
    if (bpSeekTimer) clearTimeout(bpSeekTimer);
    send("seek", { value: Number(target.value) });
  }
});

document.addEventListener("pointerup", (event) => {
  const target = event.target as HTMLInputElement | null;
  if (target?.id === "bp-seek" && player) {
    if (bpSeekTimer) clearTimeout(bpSeekTimer);
    send("seek", { value: Number(target.value) });
  }
});

function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  const box = qs("#toasts");
  if (!box) return;
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  item.addEventListener("click", () => item.remove());
  box.appendChild(item);
  while (box.children.length > 3) box.firstElementChild?.remove();
  window.setTimeout(() => item.remove(), 2600);
}

boot();
