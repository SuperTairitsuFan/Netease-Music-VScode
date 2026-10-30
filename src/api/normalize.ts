import type {
  AlbumDetail,
  AlbumRef,
  ArtistDetail,
  ArtistRef,
  Comment,
  DjRadio,
  PlaylistRef,
  SongPrivilege,
  Subscriber,
  Toplist,
  Track,
  UserProfile,
} from "./types";

type AnyRecord = Record<string, any>;

export function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function artistsOf(raw: AnyRecord): ArtistRef[] {
  if (Array.isArray(raw.ar)) {
    return raw.ar
      .filter((a: AnyRecord) => a && a.name)
      .map((a: AnyRecord) => ({ id: Number(a.id ?? 0), name: String(a.name) }));
  }
  if (Array.isArray(raw.artists)) {
    return raw.artists
      .filter((a: AnyRecord) => a && a.name)
      .map((a: AnyRecord) => ({ id: Number(a.id ?? 0), name: String(a.name) }));
  }
  return [];
}

function albumOf(raw: AnyRecord): AlbumRef {
  if (raw.al) return { id: Number(raw.al.id ?? 0), name: raw.al.name ?? "", picUrl: raw.al.picUrl ?? "" };
  if (raw.album) {
    return {
      id: Number(raw.album.id ?? 0),
      name: raw.album.name ?? "",
      picUrl: raw.album.picUrl ?? raw.album.blurPicUrl ?? "",
    };
  }
  return { id: 0, name: "", picUrl: "" };
}

function privilegeOf(raw: AnyRecord | undefined): SongPrivilege | undefined {
  const p = raw?.privilege ?? raw?.priv;
  if (!p || typeof p !== "object") return undefined;
  return {
    maxBrLevel: p.maxBrLevel === undefined || p.maxBrLevel === null ? undefined : String(p.maxBrLevel),
    fee: p.fee,
    st: p.st,
    pl: p.pl,
    dl: p.dl,
    subp: p.subp,
    fl: p.fl,
    maxbr: p.maxbr,
    flag: p.flag,
  };
}

export function normalizeTrack(raw: AnyRecord | null | undefined, privilege?: SongPrivilege): Track | null {
  if (!raw || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    name: raw.name ?? "",
    artists: artistsOf(raw),
    album: albumOf(raw),
    duration: Number(raw.dt ?? raw.duration ?? 0),
    fee: raw.fee,
    commentCount: raw.commentCount === undefined ? undefined : Number(raw.commentCount),
    alia: Array.isArray(raw.alia) ? raw.alia.filter(Boolean) : undefined,
    mvid: raw.mvid ?? raw.mv,
    privilege: privilege ?? privilegeOf(raw),
  };
}

export function normalizeTracks(
  raw: unknown[] | undefined | null,
  privileges?: Record<number, SongPrivilege>,
): Track[] {
  return asArray(raw)
    .map((item) => {
      const record = item as AnyRecord;
      return normalizeTrack(record, privileges?.[Number(record?.id)]);
    })
    .filter((t): t is Track => t !== null);
}

export function normalizePlaylist(raw: AnyRecord | null | undefined): PlaylistRef | null {
  if (!raw || typeof raw.id !== "number") return null;
  const creator = raw.creator ?? raw.creatorUser;
  return {
    id: raw.id,
    name: raw.name ?? "",
    coverImgUrl: raw.coverImgUrl ?? raw.picUrl ?? raw.coverImageUrl ?? "",
    description: raw.description ?? undefined,
    trackCount: Number(raw.trackCount ?? 0),
    playCount: Number(raw.playCount ?? raw.playcount ?? 0),
    commentCount: raw.commentCount === undefined ? undefined : Number(raw.commentCount),
    subscriberCount: raw.subscribedCount === undefined ? undefined : Number(raw.subscribedCount),
    createTime: raw.createTime ? Number(raw.createTime) : undefined,
    updateTime: raw.updateTime ? Number(raw.updateTime) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : undefined,
    creator: creator
      ? {
          userId: Number(creator.userId ?? 0),
          nickname: creator.nickname ?? "",
          avatarUrl: creator.avatarUrl,
        }
      : undefined,
    subscribed: raw.subscribed,
    specialType: raw.specialType === undefined ? undefined : Number(raw.specialType),
  };
}

export function normalizeToplist(raw: AnyRecord): Toplist | null {
  if (!raw || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    name: raw.name ?? "",
    coverImgUrl: raw.coverImgUrl ?? raw.coverImageUrl ?? raw.cover ?? "",
    updateFrequency: raw.updateFrequency ?? undefined,
    trackCount: Number(raw.trackCount ?? 0),
    playCount: Number(raw.playCount ?? raw.playcount ?? 0),
    description: raw.description ?? undefined,
  };
}

export function normalizeDjRadio(raw: AnyRecord): DjRadio | null {
  if (!raw || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    name: raw.name ?? "",
    picUrl: raw.picUrl ?? raw.picUrl ?? "",
    desc: raw.desc ?? raw.description ?? undefined,
    programCount: Number(raw.programCount ?? 0),
    subCount: Number(raw.subCount ?? 0),
    category: raw.category ?? undefined,
    rcmdtext: raw.rcmdtext ?? undefined,
    dj: raw.dj
      ? {
          userId: Number(raw.dj.userId ?? 0),
          nickname: raw.dj.nickname ?? "",
          avatarUrl: raw.dj.avatarUrl,
        }
      : undefined,
  };
}

export function normalizeComment(raw: AnyRecord): Comment | null {
  const id = Number(raw?.commentId ?? raw?.id ?? 0);
  if (!raw || !Number.isFinite(id) || id <= 0) return null;
  const user = raw.user ?? {};
  const replied = raw.beReplied?.[0];
  return {
    id,
    user: {
      userId: Number(user.userId ?? 0),
      nickname: user.nickname ?? "网易云用户",
      avatarUrl: user.avatarUrl ?? "",
      vipType: Number(user.vipType ?? 0),
      title: Array.isArray(user.expertTags) && user.expertTags.length ? String(user.expertTags[0]) : undefined,
    },
    content: raw.content ?? "",
    time: Number(raw.time ?? 0),
    likedCount: Number(raw.likedCount ?? 0),
    liked: Boolean(raw.liked),
    replied: replied
      ? {
          user: {
            userId: Number(replied.user?.userId ?? 0),
            nickname: replied.user?.nickname ?? "",
            avatarUrl: replied.user?.avatarUrl ?? "",
          },
          content: replied.content ?? "",
        }
      : undefined,
  };
}

export function normalizeComments(raw: unknown[] | undefined | null): Comment[] {
  return asArray(raw)
    .map((item) => normalizeComment(item as AnyRecord))
    .filter((c): c is Comment => c !== null);
}

export function normalizeSubscriber(raw: AnyRecord): Subscriber | null {
  if (!raw || typeof raw.userId !== "number") return null;
  return {
    userId: raw.userId,
    nickname: raw.nickname ?? "网易云用户",
    avatarUrl: raw.avatarUrl ?? "",
    signature: raw.signature ?? undefined,
    follows: raw.follows,
    followeds: raw.followeds,
  };
}

export function normalizeSubscribers(raw: unknown[] | undefined | null): Subscriber[] {
  return asArray(raw)
    .map((item) => normalizeSubscriber(item as AnyRecord))
    .filter((s): s is Subscriber => s !== null);
}

export function normalizeAlbum(raw: AnyRecord | null | undefined): AlbumDetail | null {
  if (!raw || typeof raw.id !== "number") return null;
  const artists = Array.isArray(raw.artists)
    ? raw.artists.filter(Boolean).map((a: AnyRecord) => ({ id: Number(a.id ?? 0), name: a.name ?? "" }))
    : [];
  return {
    id: raw.id,
    name: raw.name ?? "",
    picUrl: raw.picUrl ?? raw.blurPicUrl ?? "",
    description: raw.description ?? raw.briefDesc ?? undefined,
    publishTime: raw.publishTime ? Number(raw.publishTime) : undefined,
    company: raw.company ?? undefined,
    artists,
    size: Number(raw.size ?? raw.songs?.length ?? 0),
    tracks: normalizeTracks(raw.songs),
  };
}

export function normalizeArtist(raw: AnyRecord | null | undefined, songs: Track[] = []): ArtistDetail | null {
  if (!raw || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    name: raw.name ?? "",
    avatarUrl: raw.avatar ?? raw.picUrl ?? raw.img1v1Url ?? "",
    briefDesc: raw.briefDesc ?? raw.description ?? undefined,
    albumSize: Number(raw.albumSize ?? 0),
    musicSize: Number(raw.musicSize ?? 0),
    followed: Boolean(raw.followed),
    songs,
  };
}

export function normalizeUserProfile(
  raw: AnyRecord | null | undefined,
  level?: number,
  listenSongs?: number,
): UserProfile | null {
  if (!raw || typeof raw.userId !== "number") return null;
  return {
    userId: raw.userId,
    nickname: raw.nickname ?? "网易云用户",
    avatarUrl: raw.avatarUrl ?? "",
    backgroundUrl: raw.backgroundUrl ?? undefined,
    signature: raw.signature ?? undefined,
    vipType: Number(raw.vipType ?? 0),
    level: level === undefined ? undefined : Number(level),
    listenSongs: listenSongs === undefined ? undefined : Number(listenSongs),
    follows: raw.follows === undefined ? undefined : Number(raw.follows),
    followeds: raw.followeds === undefined ? undefined : Number(raw.followeds),
    createTime: raw.createTime ? Number(raw.createTime) : undefined,
    gender: raw.gender === undefined ? undefined : Number(raw.gender),
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, "")}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
  return String(n);
}

export function parseLrc(lrc: string): Array<{ time: number; text: string }> {
  const lines: Array<{ time: number; text: string }> = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const timeTags = [...rawLine.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!timeTags.length) continue;
    const text = rawLine.replace(/\[[^\]]*\]/g, "").trim();
    for (const tag of timeTags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      const frac = tag[3] ? Number(`0.${tag[3]}`) : 0;
      lines.push({ time: minutes * 60 + seconds + frac, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

export function mapPrivileges(raw: unknown): Record<number, SongPrivilege> {
  const result: Record<number, SongPrivilege> = {};
  for (const item of asArray(raw as AnyRecord[])) {
    if (!item || typeof item.id !== "number") continue;
    result[item.id] = {
      maxBrLevel: item.maxBrLevel,
      fee: item.fee,
      st: item.st,
      pl: item.pl,
      dl: item.dl,
      subp: item.subp,
      fl: item.fl,
      maxbr: item.maxbr,
      flag: item.flag,
    };
  }
  return result;
}
