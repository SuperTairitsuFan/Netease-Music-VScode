import { randomBytes } from "node:crypto";
import type { MusicConfig } from "../config";
import { log } from "../util/logger";
import { CookieJar } from "./cookies";
import { eapi as encryptEapi, eapiDecrypt } from "./crypto";

/** Desktop Chromium UA; the EAPI payload itself carries the client fingerprint. */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const DEFAULT_HOST = "https://interface.music.163.com";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface EapiOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  retryOnRisk?: boolean;
  /** Set false for endpoints where a non-200 outer code is expected. */
  requireOk?: boolean;
}

/** Tolerant JSON parse: the server occasionally concatenates two JSON objects. */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const boundary = trimmed.indexOf("}{");
    if (boundary > 0) {
      try {
        return JSON.parse(trimmed.slice(0, boundary + 1));
      } catch {
        /* fall through */
      }
    }
    throw err;
  }
}

/**
 * The only transport used by the client: EAPI (encrypted desktop client
 * protocol). No webplayer endpoint and no HTML bootstrap are involved.
 */
export class EapiTransport {
  readonly jar: CookieJar;
  private readonly deviceId: string;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly getConfig: () => MusicConfig,
    jar?: CookieJar,
    private readonly onCookiesChange?: () => void,
  ) {
    this.jar = jar ?? new CookieJar();
    this.deviceId = this.jar.get("deviceId") ?? randomDeviceId();
    this.applyFingerprint();
  }

  get host(): string {
    const configured = this.getConfig().api.baseUrl?.trim();
    if (!configured || configured === "https://music.163.com") return DEFAULT_HOST;
    return configured.replace(/\/+$/, "");
  }

  get userAgent(): string {
    return this.getConfig().api.userAgent || DESKTOP_UA;
  }

  /**
   * Device fingerprint. The EAPI risk-control layer expects a complete set:
   * sending `os` alone is treated as a probe (-462).
   */
  private applyFingerprint(): void {
    if (!this.jar.get("os")) this.jar.set("os", "pc");
    if (!this.jar.get("appver")) this.jar.set("appver", "3.1.17.204416");
    if (!this.jar.get("osver")) this.jar.set("osver", "Microsoft-Windows-10-Professional-build-19045-64bit");
    if (!this.jar.get("channel")) this.jar.set("channel", "netease");
    if (!this.jar.get("deviceId")) this.jar.set("deviceId", this.deviceId);
    if (!this.jar.get("versioncode")) this.jar.set("versioncode", "140");
  }

  private buildHeader(): Record<string, string> {
    const now = Date.now();
    const header: Record<string, string> = {
      osver: this.jar.get("osver") ?? "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: this.jar.get("deviceId") ?? this.deviceId,
      os: this.jar.get("os") ?? "pc",
      appver: this.jar.get("appver") ?? "3.1.17.204416",
      versioncode: this.jar.get("versioncode") ?? "140",
      mobilename: this.jar.get("mobilename") ?? "",
      buildver: String(now).slice(0, 10),
      resolution: "1920x1080",
      __csrf: this.jar.get("__csrf") ?? "",
      channel: this.jar.get("channel") ?? "netease",
      requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    };
    const musicU = this.jar.get("MUSIC_U");
    const musicA = this.jar.get("MUSIC_A");
    if (musicU) header.MUSIC_U = musicU;
    if (musicA) header.MUSIC_A = musicA;
    return header;
  }

  private cookieHeader(): string {
    const parts: string[] = [];
    const manual = this.getConfig().api.cookie.trim();
    if (manual) parts.push(manual.replace(/;\s*$/, ""));
    if (!this.jar.isEmpty()) parts.push(this.jar.header());
    const header = this.buildHeader();
    const pairs = Object.entries(header)
      .filter(([key]) => key !== "requestId" && key !== "__csrf" && key !== "MUSIC_U" && key !== "MUSIC_A")
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value ?? ""))}`);
    parts.push(pairs.join("; "));
    return parts.filter(Boolean).join("; ");
  }

  private async throttle(): Promise<void> {
    const run = async (): Promise<void> => {
      const wait = Math.max(0, this.lastRequestAt + 180 - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async request<T = any>(path: string, body: Record<string, unknown> = {}, options: EapiOptions = {}): Promise<T> {
    try {
      return await this.perform<T>(path, body, options, 0);
    } catch (err) {
      if (
        options.retryOnRisk !== false &&
        err instanceof ApiError &&
        (err.code === 406 || err.code === -462 || err.code === -460)
      ) {
        log.warn("risk-control response, retrying once after 8s", { path, code: err.code });
        await new Promise((r) => setTimeout(r, 8_000));
        return this.perform<T>(path, body, options, 1);
      }
      throw err;
    }
  }

  private async perform<T>(
    path: string,
    body: Record<string, unknown>,
    options: EapiOptions,
    attempt: number,
  ): Promise<T> {
    await this.throttle();
    const cfg = this.getConfig();
    this.applyFingerprint();
    const header = this.buildHeader();
    const payload = encryptEapi(path, { ...body, header });
    const qs = new URLSearchParams();
    if (cfg.api.realIP) qs.set("realIP", cfg.api.realIP);
    const queryString = qs.toString();
    const url = `${this.host}/eapi${path.replace(/^\/api/, "")}${queryString ? `?${queryString}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: "https://music.163.com",
      Origin: "https://music.163.com",
      "User-Agent": this.userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.headers ?? {}),
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (cfg.api.realIP) {
      headers["X-Real-IP"] = cfg.api.realIP;
      headers["X-Forwarded-For"] = cfg.api.realIP;
    }

    const timeout = options.timeoutMs ?? cfg.api.timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: `params=${encodeURIComponent(payload)}`,
        signal: controller.signal,
      });
      if (this.jar.absorbSetCookie(res.headers)) this.onCookiesChange?.();
      let text = await res.text();
      if (text.trim().startsWith("#14")) text = eapiDecrypt(text.trim());
      log.debug(`eapi ${path}`, {
        status: res.status,
        ms: Date.now() - started,
        bytes: text.length,
        attempt,
      });
      if (!res.ok) {
        throw new ApiError(`HTTP ${res.status} for ${path}`, undefined, res.status, text.slice(0, 500));
      }
      let parsed: unknown;
      try {
        parsed = parseLooseJson(text);
      } catch {
        throw new ApiError(`Unexpected response for ${path}`, undefined, res.status, text.slice(0, 300));
      }
      const code = (parsed as { code?: number } | null)?.code;
      if (typeof code === "number" && code < 0) {
        throw new ApiError(`接口被风控拦截（code=${code}），请稍后再试`, code, res.status, parsed);
      }
      if (options.requireOk === false) return parsed as T;
      return parsed as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ApiError(`请求超时（${timeout}ms）：${path}`);
      }
      throw new ApiError(`网络错误：${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  post<T = any>(path: string, body: Record<string, unknown> = {}, options?: EapiOptions): Promise<T> {
    return this.request<T>(path, body, options);
  }
}

export function requireOk<T extends { code?: number }>(data: T, what: string): T {
  if (data.code !== undefined && data.code !== 200 && data.code !== 801) {
    const message =
      (data as { message?: string; msg?: string }).message ?? (data as { msg?: string }).msg;
    throw new ApiError(`${what}失败（code=${data.code}）${message ? `：${message}` : ""}`, data.code, undefined, data);
  }
  return data;
}

function randomDeviceId(): string {
  return randomBytes(26).toString("hex").toUpperCase();
}
