/** Minimal cookie jar with Set-Cookie parsing that works on Node 18 and 20+. */
export class CookieJar {
  private cookies = new Map<string, string>();

  constructor(initial?: Record<string, string> | string) {
    if (typeof initial === "string") this.mergeCookieHeader(initial);
    else if (initial) for (const [k, v] of Object.entries(initial)) this.cookies.set(k, v);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    if (!name) return;
    if (value === "" || value === "deleted") this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  clear(): void {
    this.cookies.clear();
  }

  isEmpty(): boolean {
    return this.cookies.size === 0;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.cookies.entries());
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  mergeCookieHeader(header: string): void {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) this.set(name, value);
    }
  }

  /** Returns true when anything changed. */
  absorbSetCookie(headers: Headers): boolean {
    const list = getSetCookieList(headers);
    let changed = false;
    for (const line of list) {
      const first = line.split(";", 1)[0];
      const idx = first.indexOf("=");
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (!name) continue;
      const expired = /expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0(;|$)/i.test(line);
      if (expired) {
        if (this.cookies.delete(name)) changed = true;
        continue;
      }
      // Domain/path attributes are ignored: this jar only ever talks to music.163.com.
      if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        changed = true;
      }
    }
    return changed;
  }
}

function getSetCookieList(headers: Headers): string[] {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[]; raw?: () => Record<string, string[]> };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie() ?? [];
  }
  if (typeof anyHeaders.raw === "function") {
    return anyHeaders.raw()["set-cookie"] ?? [];
  }
  const merged = headers.get("set-cookie");
  if (!merged) return [];
  // Fallback split: a new cookie starts with `name=` at a comma boundary.
  return merged.split(/,(?=\s*[A-Za-z0-9_\-]+=)/g).map((s) => s.trim());
}
