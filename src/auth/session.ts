import * as vscode from "vscode";
import { NeteaseClient } from "../api/client";
import { CookieJar } from "../api/cookies";
import { ApiError } from "../api/http";
import type { Account, QrLoginState } from "../api/types";
import type { MusicConfig } from "../config";
import { log } from "../util/logger";

const SECRET_KEY = "neteaseMusic.session.v1";
const ACCOUNT_KEY = "neteaseMusic.account.v1";

export interface SessionSnapshot {
  loggedIn: boolean;
  account: Account | null;
}

export class SessionManager implements vscode.Disposable {
  readonly client: NeteaseClient;
  readonly jar: CookieJar;
  private account: Account | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<SessionSnapshot>();
  readonly onDidChange = this.emitter.event;
  private ready = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly getConfig: () => MusicConfig,
  ) {
    this.jar = new CookieJar();
    this.client = new NeteaseClient(getConfig, this.jar, () => this.scheduleSave());
  }

  snapshot(): SessionSnapshot {
    return { loggedIn: Boolean(this.jar.get("MUSIC_U")), account: this.account };
  }

  get accountInfo(): Account | null {
    return this.account;
  }

  get loggedIn(): boolean {
    return Boolean(this.jar.get("MUSIC_U"));
  }

  get vip(): "none" | "vip" | "svip" {
    const type = Number(this.account?.vipType ?? 0);
    if (type >= 10) return "svip";
    if (type > 0) return "vip";
    return "none";
  }

  async init(): Promise<void> {
    try {
      const raw = await this.ctx.secrets.get(SECRET_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { cookies?: Record<string, string> };
        if (parsed.cookies) {
          for (const [name, value] of Object.entries(parsed.cookies)) this.jar.set(name, value);
        }
      }
      const stored = this.ctx.globalState.get<Account>(ACCOUNT_KEY);
      if (stored) this.account = stored;
      log.info("session restored", {
        loggedIn: Boolean(this.jar.get("MUSIC_U")),
        cookies: Object.keys(this.jar.toJSON()).length,
      });
    } catch (err) {
      log.warn("failed to restore session", String(err));
    }
    this.ready = true;
    if (this.jar.get("MUSIC_U")) {
      void this.refreshAccount().catch((err) => log.warn("account refresh failed", String(err)));
    }
  }

  async startQrLogin(): Promise<{ key: string; qrContent: string }> {
    const key = await this.client.qrKey();
    return { key, qrContent: this.client.qrContent(key) };
  }

  async pollQrLogin(key: string): Promise<QrLoginState> {
    const state = await this.client.qrCheck(key);
    if (state.code === 803) {
      await this.afterLogin();
    }
    return state;
  }

  async loginWithCellphone(input: {
    phone: string;
    countryCode?: string;
    captcha?: string;
    password?: string;
  }): Promise<Account> {
    const account = await this.client.loginCellphone(input);
    await this.afterLogin(account);
    return account;
  }

  async loginWithEmail(username: string, password: string): Promise<Account> {
    const account = await this.client.loginEmail(username, password);
    await this.afterLogin(account);
    return account;
  }

  async afterLogin(account?: Account): Promise<void> {
    const resolved = account ?? (await this.client.account());
    if (!resolved) throw new ApiError("登录成功但无法读取账户信息，请重试");
    this.account = resolved;
    await this.ctx.globalState.update(ACCOUNT_KEY, resolved);
    await this.saveNow();
    this.emitter.fire(this.snapshot());
    log.info("logged in", { userId: resolved.userId, nickname: resolved.nickname, vipType: resolved.vipType });
  }

  async refreshAccount(): Promise<Account | null> {
    if (!this.jar.get("MUSIC_U")) {
      this.account = null;
      await this.ctx.globalState.update(ACCOUNT_KEY, undefined);
      this.emitter.fire(this.snapshot());
      return null;
    }
    const account = await this.client.account();
    this.account = account;
    await this.ctx.globalState.update(ACCOUNT_KEY, account ?? undefined);
    this.emitter.fire(this.snapshot());
    return account;
  }

  async logout(): Promise<void> {
    await this.client.logout();
    this.account = null;
    await this.ctx.globalState.update(ACCOUNT_KEY, undefined);
    await this.ctx.secrets.delete(SECRET_KEY);
    this.emitter.fire(this.snapshot());
  }

  private scheduleSave(): void {
    if (!this.ready) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 800);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      await this.ctx.secrets.store(SECRET_KEY, JSON.stringify({ cookies: this.jar.toJSON(), savedAt: Date.now() }));
    } catch (err) {
      log.warn("failed to persist session", String(err));
    }
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.emitter.dispose();
  }
}
