export interface ArtistRef {
  id: number;
  name: string;
}

export interface AlbumRef {
  id: number;
  name: string;
  picUrl: string;
}

/** NetEase privilege summary attached to songs returned by search / playlist APIs. */
export interface SongPrivilege {
  maxBrLevel?: string;
  fee?: number;
  st?: number;
  pl?: number;
  dl?: number;
  subp?: number;
  fl?: number;
  maxbr?: number;
  flag?: number;
}

export interface Track {
  id: number;
  name: string;
  artists: ArtistRef[];
  album: AlbumRef;
  /** milliseconds */
  duration: number;
  fee?: number;
  alia?: string[];
  mvid?: number;
  privilege?: SongPrivilege;
  commentCount?: number;
  /** local-only tracks */
  localPath?: string;
  liked?: boolean;
}

export interface UserProfile {
  userId: number;
  nickname: string;
  avatarUrl: string;
  backgroundUrl?: string;
  signature?: string;
  vipType?: number;
  level?: number;
  listenSongs?: number;
  follows?: number;
  followeds?: number;
  createTime?: number;
  gender?: number;
}

export interface UserPage {
  user: UserProfile;
  playlists: PlaylistRef[];
  isSelf: boolean;
}

export interface SongPage {
  track: Track;
  lyric: LyricPayload;
  composerNames: string[];
}

export interface PlaylistRef {
  id: number;
  name: string;
  coverImgUrl: string;
  description?: string;
  trackCount: number;
  playCount?: number;
  commentCount?: number;
  subscriberCount?: number;
  createTime?: number;
  updateTime?: number;
  tags?: string[];
  creator?: { userId: number; nickname: string; avatarUrl?: string };
  subscribed?: boolean;
  specialType?: number;
}

export interface PlaylistDetail {
  playlist: PlaylistRef;
  tracks: Track[];
  trackIds?: number[];
  privileges?: Record<number, SongPrivilege>;
}

export interface Account {
  userId: number;
  nickname: string;
  avatarUrl: string;
  backgroundUrl?: string;
  signature?: string;
  vipType?: number;
  follows?: number;
  followeds?: number;
  createTime?: number;
}

export interface UserPlaylist {
  id: number;
  name: string;
  coverImgUrl: string;
  trackCount: number;
  playCount: number;
  subscribed: boolean;
  creatorId: number;
  /** 5 = the built-in "我喜欢的音乐" playlist. */
  specialType?: number;
}

export interface LyricPayload {
  lrc: string;
  translation: string;
  roma?: string;
}

export interface SongUrlResult {
  id: number;
  url: string | null;
  br: number;
  size: number;
  type: string | null;
  level: string | null;
  fee?: number;
  code?: number;
  freeTrialInfo?: { start: number; end: number } | null;
  /** source sample rate reported by the API (Hz) */
  sampleRate?: number;
  /** ReplayGain in dB reported by the API */
  gain?: number;
  /** signed URL TTL in seconds (usually 1200) */
  expi?: number;
}

export interface QrLoginState {
  key: string;
  qrContent: string;
  /** raw NetEase code: 800 expired, 801 waiting, 802 scanned, 803 authorised */
  code: number;
  message: string;
  nickname?: string;
}

export interface SearchResult {
  songs: Track[];
  playlists: PlaylistRef[];
  albums?: AlbumRef[];
  artists?: ArtistRef[];
  users?: UserProfile[];
  lyrics?: LyricHit[];
  radios?: DjRadio[];
  songCount: number;
  playlistCount: number;
}

export interface LyricHit {
  songId: number;
  songName: string;
  artist: string;
  lyric: string;
}

export interface CommentUser {
  userId: number;
  nickname: string;
  avatarUrl: string;
  vipType?: number;
  title?: string;
}

export interface Comment {
  id: number;
  user: CommentUser;
  content: string;
  /** milliseconds */
  time: number;
  likedCount: number;
  liked: boolean;
  replied?: { user: CommentUser; content: string };
}

export interface Subscriber {
  userId: number;
  nickname: string;
  avatarUrl: string;
  signature?: string;
  follows?: number;
  followeds?: number;
}

export interface AlbumDetail {
  id: number;
  name: string;
  picUrl: string;
  description?: string;
  publishTime?: number;
  company?: string;
  artists: ArtistRef[];
  size: number;
  tracks: Track[];
}

export interface ArtistDetail {
  id: number;
  name: string;
  avatarUrl: string;
  briefDesc?: string;
  albumSize: number;
  musicSize: number;
  followed?: boolean;
  songs: Track[];
  albums?: AlbumRef[];
  similar?: ArtistRef[];
}

export interface Toplist {
  id: number;
  name: string;
  coverImgUrl: string;
  updateFrequency?: string;
  trackCount: number;
  playCount: number;
  description?: string;
}

export interface DjRadio {
  id: number;
  name: string;
  picUrl: string;
  desc?: string;
  programCount: number;
  subCount: number;
  category?: string;
  rcmdtext?: string;
  dj?: { userId: number; nickname: string; avatarUrl?: string };
}

export interface HomeFeed {
  personalized: PlaylistRef[];
  newSongs: Track[];
  dailySongs: Track[];
  toplists: Toplist[];
  radios: DjRadio[];
  roamSongs: Track[];
  followedArtists: ArtistRef[];
}
