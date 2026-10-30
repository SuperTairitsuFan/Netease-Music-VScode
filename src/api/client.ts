import { createHash } from "node:crypto";
import type { MusicConfig, Quality } from "../config";
import { log } from "../util/logger";
import { CookieJar } from "./cookies";
import { ApiError, EapiTransport, requireOk } from "./http";
import {
  asArray,
  mapPrivileges,
  normalizeAlbum,
  normalizeArtist,
  normalizeComments,
  normalizeDjRadio,
  normalizePlaylist,
  normalizeSubscribers,
  normalizeToplist,
  normalizeTrack,
  normalizeTracks,
  normalizeUserProfile,
} from "./normalize";
import type {
  Account,
  AlbumDetail,
  ArtistDetail,
  ArtistRef,
  Comment,
  DjRadio,
  LyricPayload,
  PlaylistDetail,
  PlaylistRef,
  QrLoginState,
  SearchResult,
  SongPrivilege,
  SongUrlResult,
  Subscriber,
  Toplist,
  Track,
  UserPlaylist,
  UserProfile,
} from "./types";

function idsParam(ids: number[]): string {
  return JSON.stringify(ids.map((id) => Number(id)));
}

function translateLoginError(err: unknown): unknown {
  if (err instanceof ApiError) {
    if (err.code === 502) return new ApiError("手机号或密码错误", err.code, err.status, err.body);
    if (err.code === 503) return new ApiError("验证码错误或已过期", err.code, err.status, err.body);
    if (err.code === 406) return new ApiError("操作过于频繁，请稍后再试", err.code, err.status, err.body);
    if (err.code === 301) return new ApiError("未登录或登录已过期", err.code, err.status, err.body);
  }
  return err;
}

export class NeteaseClient {
  readonly http: EapiTransport;

  constructor(
    private readonly getConfig: () => MusicConfig,
    jar?: CookieJar,
    onCookiesChange?: () => void,
  ) {
    this.http = new EapiTransport(getConfig, jar, onCookiesChange);
  }

  get jar(): CookieJar {
    return this.http.jar;
  }

  // ---------------------------------------------------------------- login

  async qrKey(): Promise<string> {
    const data = await this.http.post<{ code: number; unikey: string }>("/api/login/qrcode/unikey", {
      type: 1,
    });
    requireOk(data, "获取二维码");
    return data.unikey;
  }

  qrContent(key: string): string {
    return `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
  }

  async qrCheck(key: string): Promise<QrLoginState> {
    const data = await this.http.post<{ code: number; message?: string; nickname?: string }>(
      "/api/login/qrcode/client/login",
      { key, type: 1 },
    );
    return {
      key,
      qrContent: this.qrContent(key),
      code: data.code,
      message: data.message ?? "",
      nickname: data.nickname,
    };
  }

  async captchaSent(phone: string, countryCode = "86"): Promise<void> {
    const data = await this.http.post<{ code: number; message?: string }>("/api/sms/captcha/sent", {
      ctcode: countryCode,
      secrete: "music_middleuser_pclogin",
      cellphone: phone,
    });
    requireOk(data, "发送验证码");
  }

  async loginCellphone(params: {
    phone: string;
    countryCode?: string;
    captcha?: string;
    password?: string;
  }): Promise<Account> {
    const body: Record<string, unknown> = {
      type: "1",
      https: "true",
      phone: params.phone,
      countrycode: params.countryCode ?? "86",
      remember: "true",
    };
    if (params.captcha) body.captcha = params.captcha;
    else body.password = md5Hex(params.password ?? "");
    try {
      const data = await this.http.post<{ code: number; account?: any; profile?: any }>(
        "/api/w/login/cellphone",
        body,
      );
      requireOk(data, "手机登录");
      return accountFrom(data);
    } catch (err) {
      throw translateLoginError(err);
    }
  }

  async loginEmail(username: string, password: string): Promise<Account> {
    const body = {
      type: "0",
      https: "true",
      username,
      password: md5Hex(password),
      rememberLogin: "true",
    };
    try {
      const data = await this.http.post<{ code: number; account?: any; profile?: any }>("/api/w/login", body);
      requireOk(data, "邮箱登录");
      return accountFrom(data);
    } catch (err) {
      throw translateLoginError(err);
    }
  }

  async logout(): Promise<void> {
    try {
      await this.http.post("/api/logout", {});
    } catch (err) {
      log.warn("logout request failed", String(err));
    }
    this.jar.clear();
    this.jar.set("__csrf", "");
  }

  // -------------------------------------------------------------- account

  async account(): Promise<Account | null> {
    if (!this.isLoggedIn()) return null;
    const data = await this.http.post<{ code: number; account?: any; profile?: any }>("/api/nuser/account/get", {});
    if (data.code !== 200 || !data.account) return null;
    if (data.account.id && !data.profile) {
      return {
        userId: Number(data.account.id),
        nickname: `用户 ${data.account.id}`,
        avatarUrl: "",
        vipType: data.account.vipType,
      };
    }
    return accountFrom(data);
  }

  isLoggedIn(): boolean {
    return Boolean(this.jar.get("MUSIC_U"));
  }

  async userPlaylists(uid: number): Promise<UserPlaylist[]> {
    const data = await this.http.post<{ code: number; playlist?: any[] }>("/api/user/playlist", {
      uid,
      limit: 1000,
      offset: 0,
    });
    requireOk(data, "获取歌单");
    return asArray(data.playlist).map((p) => ({
      id: Number(p.id),
      name: p.name ?? "",
      coverImgUrl: p.coverImgUrl ?? "",
      trackCount: Number(p.trackCount ?? 0),
      playCount: Number(p.playCount ?? 0),
      subscribed: Boolean(p.subscribed),
      creatorId: Number(p.creator?.userId ?? 0),
      specialType: p.specialType === undefined ? undefined : Number(p.specialType),
    }));
  }

  async userDetail(uid: number): Promise<{ user: UserProfile; playlists: UserPlaylist[] }> {
    const [detail, playlists] = await Promise.all([
      this.http.post<{ code: number; profile?: any; level?: number; listenSongs?: number }>(
        `/api/v1/user/detail/${uid}`,
        {},
      ),
      this.userPlaylists(uid).catch(() => []),
    ]);
    requireOk(detail, "获取用户主页");
    const user = normalizeUserProfile(detail.profile, detail.level, detail.listenSongs);
    if (!user) throw new Error("用户不存在");
    return { user, playlists };
  }

  // -------------------------------------------------------------- catalog

  async search(keyword: string, type: "all" | "song" | "playlist" | "album" | "artist" | "user" | "lyric" | "radio" = "song", limit = 30, offset = 0): Promise<SearchResult> {
    const code: Record<string, number> = { all: 1, song: 1, playlist: 1000, album: 10, artist: 100, user: 1002, lyric: 1006, radio: 1009 };
    const data = await this.http.post<any>("/api/cloudsearch/pc", {
      s: keyword,
      type: code[type] ?? 1,
      limit,
      offset,
    });
    requireOk(data, "搜索");
    const result = data.result ?? {};
    if (type === "song" || type === "all") {
      return {
        songs: normalizeTracks(result.songs),
        playlists: [],
        songCount: Number(result.songCount ?? 0),
        playlistCount: 0,
      };
    }
    if (type === "playlist") {
      return {
        songs: [],
        playlists: asArray(result.playlists)
          .map((p) => normalizePlaylist(p as Record<string, unknown>))
          .filter((p): p is PlaylistRef => p !== null),
        songCount: 0,
        playlistCount: Number(result.playlistCount ?? 0),
      };
    }
    if (type === "album") {
      const albums = asArray(result.albums)
        .map((album) => normalizeAlbum(album as Record<string, unknown>))
        .filter((album): album is NonNullable<typeof album> => Boolean(album))
        .map((album) => ({ id: album.id, name: album.name, picUrl: album.picUrl }));
      return { songs: [], playlists: [], albums, songCount: 0, playlistCount: 0 };
    }
    if (type === "artist") {
      const artists = asArray(result.artists)
        .map((artist) => normalizeArtist(artist as Record<string, unknown>))
        .filter((artist): artist is NonNullable<typeof artist> => Boolean(artist))
        .map((artist) => ({ id: artist.id, name: artist.name, avatarUrl: artist.avatarUrl }));
      return { songs: [], playlists: [], artists, songCount: 0, playlistCount: 0 };
    }
    if (type === "user") {
      const users = asArray(result.userprofiles)
        .map((user) => normalizeUserProfile(user as Record<string, unknown>))
        .filter((user): user is NonNullable<typeof user> => Boolean(user));
      return { songs: [], playlists: [], users, songCount: 0, playlistCount: 0 };
    }
    if (type === "lyric") {
      const lyrics = asArray(result.lyrics).map((item: any) => ({
        songId: Number(item.id ?? item.songId ?? 0),
        songName: String(item.songName ?? item.name ?? ""),
        artist: String(item.artistName ?? item.artist ?? ""),
        lyric: String(item.lyric ?? item.content ?? ""),
      }));
      return { songs: [], playlists: [], lyrics, songCount: 0, playlistCount: 0 };
    }
    const radios = asArray(result.djRadios ?? result.radios)
      .map((radio) => normalizeDjRadio(radio as Record<string, unknown>))
      .filter((radio): radio is NonNullable<typeof radio> => Boolean(radio));
    return { songs: [], playlists: [], radios, songCount: 0, playlistCount: 0 };
  }

  async searchArtists(name: string, limit = 3): Promise<ArtistRef[]> {
    const data = await this.http.post<any>("/api/cloudsearch/pc", {
      s: name,
      type: 100,
      limit,
      offset: 0,
    });
    requireOk(data, "搜索歌手");
    return asArray(data.result?.artists)
      .filter((artist: any) => artist && typeof artist.id === "number")
      .map((artist: any) => ({ id: Number(artist.id), name: artist.name ?? "" }));
  }

  async songDetail(ids: number[]): Promise<Track[]> {
    if (!ids.length) return [];
    const data = await this.http.post<{ code: number; songs?: any[]; privileges?: any[] }>(
      "/api/v3/song/detail",
      { c: JSON.stringify(ids.map((id) => ({ id }))) },
    );
    requireOk(data, "获取歌曲详情");
    const privileges = mapPrivileges(data.privileges);
    return normalizeTracks(data.songs, privileges);
  }

  async privileges(ids: number[]): Promise<Record<number, SongPrivilege>> {
    if (!ids.length) return {};
    const merged: Record<number, SongPrivilege> = {};
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const data = await this.http.post<{ code: number; data?: any[] }>("/api/song/enhance/privilege", {
        ids: idsParam(chunk),
      });
      requireOk(data, "获取歌曲权限");
      Object.assign(merged, mapPrivileges(data.data));
    }
    return merged;
  }

  async playlistDetail(id: number): Promise<PlaylistDetail> {
    const data = await this.http.post<{ code: number; playlist?: any }>("/api/v6/playlist/detail", {
      id,
      n: 1000,
      s: 8,
    });
    requireOk(data, "获取歌单详情");
    const raw = data.playlist;
    const playlist = normalizePlaylist(raw);
    if (!playlist) throw new Error("歌单不存在或不可见");
    const privileges = mapPrivileges(raw?.privileges);
    let tracks = normalizeTracks(raw?.tracks, privileges);
    const trackIds = asArray(raw?.trackIds)
      .map((entry: any) => Number(entry?.id ?? entry))
      .filter((value: number) => Number.isFinite(value) && value > 0);
    if (playlist.trackCount > tracks.length && trackIds.length) {
      const loaded = new Map(tracks.map((track) => [track.id, track]));
      for (let i = 0; i < trackIds.length; i += 500) {
        const chunk = trackIds.slice(i, i + 500);
        const songs = await this.songDetail(chunk);
        for (const song of songs) loaded.set(song.id, song);
      }
      tracks = trackIds.map((trackId) => loaded.get(trackId)).filter((track): track is Track => Boolean(track));
      if (!tracks.length) tracks = [...loaded.values()];
    }
    if (tracks.length && Object.keys(privileges).length === 0) {
      try {
        const fetched = await this.privileges(tracks.map((track) => track.id));
        Object.assign(privileges, fetched);
        tracks = tracks.map((track) => ({ ...track, privilege: fetched[track.id] ?? track.privilege }));
      } catch (err) {
        log.debug("privilege lookup failed", String(err));
      }
    }
    return { playlist, tracks, trackIds, privileges };
  }

  async personalizedPlaylists(limit = 12): Promise<PlaylistRef[]> {
    const data = await this.http.post<{ code: number; result?: any[] }>("/api/personalized/playlist", {
      limit,
      total: true,
      n: 1000,
    });
    requireOk(data, "获取推荐歌单");
    return asArray(data.result)
      .map((p) => normalizePlaylist(p as Record<string, unknown>))
      .filter((p): p is PlaylistRef => p !== null);
  }

  async newSongs(limit = 12): Promise<Track[]> {
    const data = await this.http.post<{ code: number; result?: any[] }>("/api/personalized/newsong", { limit });
    requireOk(data, "获取新歌");
    const tracks = asArray(data.result)
      .map((entry) => normalizeTrack(entry.song ?? entry))
      .filter((t): t is Track => t !== null);
    return this.attachPrivileges(tracks);
  }

  async dailySongs(limit = 30): Promise<Track[]> {
    const data = await this.http.post<{ code: number; data?: { dailySongs?: any[] } }>(
      "/api/v3/discovery/recommend/songs",
      { limit },
    );
    if (data.code === 301) return [];
    requireOk(data, "获取每日推荐");
    const tracks = normalizeTracks(data.data?.dailySongs);
    return this.attachPrivileges(tracks);
  }

  private async attachPrivileges(tracks: Track[]): Promise<Track[]> {
    if (!tracks.length) return tracks;
    try {
      const privileges = await this.privileges(tracks.map((track) => track.id));
      return tracks.map((track) => ({ ...track, privilege: privileges[track.id] ?? track.privilege }));
    } catch (err) {
      log.debug("privilege lookup failed", String(err));
      return tracks;
    }
  }

  async toplists(): Promise<Toplist[]> {
    const data = await this.http.post<{ code: number; list?: any[] }>("/api/toplist", {});
    requireOk(data, "获取排行榜");
    return asArray(data.list)
      .map((item) => normalizeToplist(item as Record<string, unknown>))
      .filter((item): item is Toplist => item !== null);
  }

  async djRadios(limit = 20, offset = 0): Promise<DjRadio[]> {
    const data = await this.http.post<{ code: number; djRadios?: any[] }>("/api/djradio/recommend/v1", {
      limit,
      offset,
    });
    requireOk(data, "获取播客");
    return asArray(data.djRadios)
      .map((item) => normalizeDjRadio(item as Record<string, unknown>))
      .filter((item): item is DjRadio => item !== null);
  }

  async roamSongs(): Promise<Track[]> {
    const data = await this.http.post<{ code: number; data?: any[] }>("/api/v1/radio/get", {});
    requireOk(data, "获取漫游歌曲");
    return normalizeTracks(data.data);
  }

  async followedArtists(limit = 50, offset = 0): Promise<ArtistRef[]> {
    if (!this.isLoggedIn()) return [];
    const data = await this.http.post<{ code: number; data?: any[] }>("/api/artist/sublist", { limit, offset });
    if (data.code === 301) return [];
    requireOk(data, "获取关注歌手");
    return asArray(data.data)
      .filter((item) => item && typeof item.id === "number")
      .map((item) => ({ id: Number(item.id), name: item.name ?? "" }));
  }

  async artistDetail(id: number): Promise<ArtistDetail> {
    const [detail, songs] = await Promise.all([
      this.http.post<{ code: number; artist?: any }>(`/api/v1/artist/${id}`, {}),
      this.http.post<{ code: number; songs?: any[] }>("/api/v1/artist/songs", {
        id,
        limit: 100,
        offset: 0,
        order: "hot",
      }),
    ]);
    requireOk(detail, "获取歌手详情");
    let tracks = normalizeTracks(songs.songs);
    try {
      const privileges = await this.privileges(tracks.map((track) => track.id));
      tracks = tracks.map((track) => ({ ...track, privilege: privileges[track.id] ?? track.privilege }));
    } catch (err) {
      log.debug("artist privilege lookup failed", String(err));
    }
    const artist = normalizeArtist(detail.artist, tracks);
    if (!artist) throw new Error("歌手不存在");
    return artist;
  }

  async artistAlbums(id: number, limit = 500): Promise<import("./types").AlbumRef[]> {
    const normalize = (items: any[]): import("./types").AlbumRef[] =>
      asArray(items)
        .map((item) => normalizeAlbum(item as Record<string, unknown>))
        .filter((album): album is NonNullable<typeof album> => Boolean(album))
        .map((album) => ({ id: album.id, name: album.name, picUrl: album.picUrl }));
    try {
      const data = await this.http.post<{ code: number; hotAlbums?: any[] }>(
        `/api/artist/albums/${id}?limit=${limit}&offset=0`,
        {},
      );
      requireOk(data, "获取歌手专辑");
      const albums = normalize(data.hotAlbums ?? []);
      if (albums.length) return albums;
    } catch (err) {
      log.debug("EAPI artist albums failed, trying web fallback", String(err));
    }
    // The desktop EAPI occasionally returns an empty list for label/artist
    // accounts. The public web endpoint serves the same data; fall back to it.
    try {
      const response = await fetch(`https://music.163.com/api/artist/albums/${id}?limit=${limit}&offset=0`, {
        headers: {
          "User-Agent": this.http.userAgent,
          Referer: "https://music.163.com/",
          Cookie: this.http.jar.header(),
        },
      });
      if (response.ok) {
        const data = (await response.json()) as { hotAlbums?: any[] };
        const albums = normalize(data.hotAlbums ?? []);
        if (albums.length) return albums;
      }
    } catch (err) {
      log.debug("web artist albums fallback failed", String(err));
    }
    // Last resort: search albums by the artist name, then keep exact artist ids.
    try {
      const detail = await this.http.post<{ code: number; artist?: any }>(`/api/v1/artist/${id}`, {});
      const name = String(detail.artist?.name ?? "");
      if (name) {
        const data = await this.http.post<any>("/api/cloudsearch/pc", {
          s: name,
          type: 10,
          limit: 200,
          offset: 0,
        });
        return normalize(
          asArray(data.result?.albums).filter((album: any) =>
            asArray(album.artists).some((artist: any) => Number(artist.id) === id),
          ),
        );
      }
    } catch (err) {
      log.debug("artist album search fallback failed", String(err));
    }
    return [];
  }

  async artistSongs(id: number, limit = 200, offset = 0): Promise<Track[]> {
    const data = await this.http.post<{ code: number; songs?: any[] }>("/api/v1/artist/songs", {
      id,
      limit,
      offset,
      order: "hot",
    });
    requireOk(data, "获取歌手歌曲");
    return normalizeTracks(data.songs);
  }

  async similarArtists(id: number): Promise<ArtistRef[]> {
    const data = await this.http.post<{ code: number; artists?: any[] }>("/api/discovery/simiArtist", {
      artistid: id,
    });
    requireOk(data, "获取相似歌手");
    return asArray(data.artists).map((item: any) => ({ id: Number(item.id), name: String(item.name ?? "") }));
  }

  async radioPrograms(id: number, limit = 50): Promise<Track[]> {
    const data = await this.http.post<{ code: number; programs?: any[] }>("/api/dj/program", {
      rid: id,
      limit,
      offset: 0,
      asc: false,
    });
    requireOk(data, "获取播客节目");
    const songs = asArray(data.programs)
      .map((program) => program?.mainSong ?? program?.mainTrack)
      .filter(Boolean);
    return normalizeTracks(songs);
  }

  async albumDetail(id: number): Promise<AlbumDetail> {
    const data = await this.http.post<{ code: number; album?: any; songs?: any[] }>(`/api/v1/album/${id}`, {});
    requireOk(data, "获取专辑详情");
    const album = normalizeAlbum({ ...(data.album ?? {}), songs: data.songs ?? data.album?.songs });
    if (!album) throw new Error("专辑不存在");
    try {
      const privileges = await this.privileges(album.tracks.map((track) => track.id));
      album.tracks = album.tracks.map((track) => ({
        ...track,
        privilege: privileges[track.id] ?? track.privilege,
      }));
    } catch (err) {
      log.debug("album privilege lookup failed", String(err));
    }
    return album;
  }

  async comments(resource: string, id: number, limit = 30, offset = 0): Promise<{ comments: Comment[]; hot: Comment[]; total: number }> {
    const data = await this.http.post<{
      code: number;
      comments?: any[];
      hotComments?: any[];
      total?: number;
    }>(`/api/v1/resource/comments/${resource}`, { rid: id, limit, offset });
    requireOk(data, "获取评论");
    return {
      comments: normalizeComments(data.comments),
      hot: normalizeComments(data.hotComments),
      total: Number(data.total ?? 0),
    };
  }

  async subscribers(id: number, limit = 30, offset = 0): Promise<{ subscribers: Subscriber[]; total: number }> {
    const data = await this.http.post<{ code: number; subscribers?: any[]; total?: number }>(
      "/api/playlist/subscribers",
      { id, limit, offset },
    );
    requireOk(data, "获取收藏者");
    return { subscribers: normalizeSubscribers(data.subscribers), total: Number(data.total ?? 0) };
  }

  async playlistSubscribe(id: number, subscribe: boolean): Promise<void> {
    const data = await this.http.post<{ code: number; message?: string }>("/api/playlist/subscribe", {
      id,
      t: subscribe ? 1 : 2,
    });
    requireOk(data, subscribe ? "收藏歌单" : "取消收藏");
  }

  async addTrackToPlaylist(playlistId: number, trackId: number): Promise<void> {
    const data = await this.http.post<{ code: number; message?: string; msg?: string }>(
      "/api/playlist/manipulate/tracks",
      {
        op: "add",
        pid: playlistId,
        trackIds: JSON.stringify([trackId]),
        implicitly: "true",
      },
    );
    requireOk(data, "收藏到歌单");
  }

  async removeTrackFromPlaylist(playlistId: number, trackId: number): Promise<void> {
    const data = await this.http.post<{ code: number; message?: string; msg?: string }>(
      "/api/playlist/manipulate/tracks",
      {
        op: "del",
        pid: playlistId,
        trackIds: JSON.stringify([trackId]),
      },
    );
    requireOk(data, "从歌单删除");
  }

  async createPlaylist(name: string): Promise<number> {
    const data = await this.http.post<{ code: number; id?: number; playlist?: { id?: number } }>(
      "/api/playlist/create",
      { name },
    );
    requireOk(data, "创建歌单");
    return Number(data.id ?? data.playlist?.id ?? 0);
  }

  async deletePlaylist(id: number): Promise<void> {
    const data = await this.http.post<{ code: number }>("/api/playlist/delete", { id });
    requireOk(data, "删除歌单");
  }

  async songUrl(id: number, quality: Quality): Promise<SongUrlResult> {
    const data = await this.http.post<{ code: number; data?: any[] }>("/api/song/enhance/player/url/v1", {
      ids: idsParam([id]),
      level: quality,
      encodeType: "flac",
      ...(quality === "sky" ? { immerseType: "c51" } : {}),
    });
    const item = data.data?.[0];
    if (data.code !== 200 || !item) throw new Error("无法获取播放地址");
    return {
      id: Number(item.id ?? id),
      url: item.url ? String(item.url).replace(/^http:/, "https:") : null,
      br: Number(item.br ?? 0),
      size: Number(item.size ?? 0),
      type: item.type ?? null,
      level: item.level ?? null,
      fee: item.fee,
      code: item.code,
      freeTrialInfo: item.freeTrialInfo ?? null,
      sampleRate: Number(item.sr ?? 0),
      gain: Number(item.gain ?? 0),
      expi: Number(item.expi ?? 1200),
    };
  }

  async lyric(id: number): Promise<LyricPayload> {
    const data = await this.http.post<{
      code: number;
      lrc?: { lyric: string };
      tlyric?: { lyric: string };
      romalrc?: { lyric: string };
    }>("/api/song/lyric", { id, lv: -1, kv: -1, tv: -1 });
    requireOk(data, "获取歌词");
    return {
      lrc: data.lrc?.lyric ?? "",
      translation: data.tlyric?.lyric ?? "",
      roma: data.romalrc?.lyric ?? "",
    };
  }

  async like(id: number, like: boolean): Promise<void> {
    const data = await this.http.post<{ code: number; msg?: string; message?: string }>("/api/radio/like", {
      alg: "itembased",
      trackId: id,
      like,
      time: 3,
    });
    if (data.code === 301) throw new ApiError("请先登录后再收藏", 301);
    requireOk(data, like ? "红心" : "取消红心");
  }

  /** Post a comment. `threadId` is e.g. R_SO_4_<songId> or A_PL_0_<playlistId>. */
  async addComment(threadId: string, content: string): Promise<void> {
    const text = content.trim();
    if (!text) throw new Error("评论内容不能为空");
    if (text.length > 140) throw new Error("评论最多 140 个字符");
    const data = await this.http.post<{ code: number; message?: string; msg?: string }>(
      "/api/v1/resource/comments/add",
      { threadId, content: text, csrf_token: this.jar.get("__csrf") ?? "" },
    );
    if (data.code === 301) throw new ApiError("请先登录后再发表评论", 301);
    requireOk(data, "发表评论");
  }

  async userLevel(): Promise<{ level: number; nowPlayCount: number } | null> {
    if (!this.isLoggedIn()) return null;
    try {
      const data = await this.http.post<{ code: number; data?: any }>("/api/user/level", {});
      if (data.code !== 200 || !data.data) return null;
      return { level: Number(data.data.level ?? 0), nowPlayCount: Number(data.data.nowPlayCount ?? 0) };
    } catch {
      return null;
    }
  }

  async cloudSongs(limit = 100, offset = 0): Promise<Track[]> {
    if (!this.isLoggedIn()) return [];
    try {
      const data = await this.http.post<{ code: number; data?: any[]; songs?: any[] }>("/api/v1/cloud", {
        limit,
        offset,
      });
      if (data.code === 404) return [];
      return normalizeTracks(data.data ?? data.songs);
    } catch (err) {
      log.debug("cloud songs unavailable", String(err));
      return [];
    }
  }
}

function md5Hex(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function accountFrom(data: { account?: any; profile?: any }): Account {
  const profile = data.profile ?? {};
  const account = data.account ?? {};
  return {
    userId: Number(profile.userId ?? account.id ?? 0),
    nickname: profile.nickname ?? account.userName ?? "网易云用户",
    avatarUrl: profile.avatarUrl ?? "",
    backgroundUrl: profile.backgroundUrl ?? undefined,
    signature: profile.signature ?? undefined,
    vipType: Number(profile.vipType ?? account.vipType ?? 0),
    follows: profile.follows,
    followeds: profile.followeds,
    createTime: profile.createTime ? Number(profile.createTime) : undefined,
  };
}

/** Resource id prefix used by the comment API. */
export function commentResource(kind: "playlist" | "song" | "album" | "artist", id: number): string {
  switch (kind) {
    case "playlist":
      return `A_PL_0_${id}`;
    case "song":
      return `R_SO_4_${id}`;
    case "album":
      return `R_AL_3_${id}`;
    case "artist":
      return `R_AL_3_${id}`;
  }
}

export type { SongPrivilege };
