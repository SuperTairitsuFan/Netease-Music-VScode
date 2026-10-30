export const QUALITY_TEXT: Record<string, string> = {
  standard: "标准",
  higher: "较高",
  exhigh: "极高",
  lossless: "无损",
  hires: "Hi-Res",
  jyeffect: "高清臻音",
  sky: "沉浸环绕声",
  jymaster: "超清母带",
  local: "本地",
};

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function attr(value: unknown): string {
  return esc(value);
}

export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(Math.round(n));
}

export function fmtDate(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function fmtDateTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const now = Date.now();
  if (now - ms < 86_400_000) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return fmtDate(ms);
}

const PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#2a2a2a"/><path d="M52 76V44l24-4v28a6 6 0 1 1-4-5.6V48l-16 3v25a6 6 0 1 1-4-5.6V76z" fill="#777"/></svg>`,
  );

export function cover(url: string | undefined, size = 180): string {
  if (!url) return PLACEHOLDER;
  const https = url.replace(/^http:/, "https:");
  return `${https}${https.includes("?") ? "&" : "?"}param=${size}y${size}`;
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function escapeHtml(value: unknown): string {
  return esc(value);
}
