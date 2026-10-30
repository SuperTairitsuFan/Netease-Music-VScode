import * as path from "node:path";
import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../protocol";
import { defaultCacheDir, defaultMusicDir, getConfig } from "../config";
import { buildHtml } from "./surface";

export interface WebviewHostDeps {
  handleCommand: (cmd: string, payload?: unknown, surface?: "sidebar" | "main" | "settings" | "extras") => Promise<void> | void;
  onAudio?: (msg: WebviewMessage) => void;
  onVisibility?: (visible: boolean) => void;
}

/**
 * The PC-client-style left sidebar. It is also the persistent audio host:
 * the hidden <audio> element / PCM bridge lives here so closing the editor
 * panel does not stop WebAudio playback.
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private ready = false;
  private pending?: { resolve: () => void; timer: NodeJS.Timeout };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: WebviewHostDeps,
  ) {}

  get visible(): boolean {
    return Boolean(this.view?.visible);
  }

  get isReady(): boolean {
    return this.ready && Boolean(this.view);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const cfg = getConfig();
    const roots = new Map<string, vscode.Uri>();
    roots.set(this.ctx.extensionUri.fsPath, this.ctx.extensionUri);
    roots.set(this.ctx.globalStorageUri.fsPath, this.ctx.globalStorageUri);
    for (const dir of [
      cfg.download.dir,
      cfg.cache.dir,
      cfg.localMusic.dir,
      defaultCacheDir(this.ctx),
      defaultMusicDir(),
      path.join(defaultMusicDir(), "网易云音乐"),
    ]) {
      if (dir && !roots.has(dir)) roots.set(dir, vscode.Uri.file(dir));
    }
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [...roots.values()],
    };
    view.webview.html = buildHtml(this.ctx, view.webview, "sidebar");
    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg)),
      view.onDidChangeVisibility(() => {
        this.deps.onVisibility?.(view.visible);
        if (view.visible) this.post({ type: "theme", kind: String(vscode.window.activeColorTheme.kind) });
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === "ready") {
      this.ready = true;
      this.pending?.resolve();
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending = undefined;
      }
      await this.deps.handleCommand("ready", undefined, "sidebar");
      return;
    }
    if (msg.type === "cmd") {
      await this.deps.handleCommand(msg.cmd, msg.payload, "sidebar");
      return;
    }
    this.deps.onAudio?.(msg);
  }

  post(msg: HostMessage): void {
    if (!this.view || !this.ready) return;
    void this.view.webview.postMessage(msg);
  }

  postRaw(msg: unknown): void {
    if (!this.view || !this.ready) return;
    void this.view.webview.postMessage(msg);
  }

  resourceUri(filePath: string): string {
    if (!this.view) return "";
    return this.view.webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
  }

  /** Reveal the sidebar and wait for its webview to be ready (used before the first play). */
  async ensureReady(): Promise<boolean> {
    if (this.ready && this.view) return true;
    // `neteaseMusic.sidebar.focus` is the auto-generated view command; the
    // container command is the reliable way to reveal a hidden view.
    for (const command of [
      "neteaseMusic.sidebar.focus",
      "workbench.view.extension.neteaseMusic",
      "neteaseMusic.focus",
    ]) {
      try {
        await vscode.commands.executeCommand(command);
      } catch {
        /* command may be unavailable before the container is registered */
      }
      if (this.ready && this.view) return true;
    }
    if (this.ready && this.view) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        resolve(this.ready && Boolean(this.view));
      }, 30000);
      this.pending = {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        timer,
      };
      // A fast webview can send `ready` between the check above and the
      // assignment of `pending`; resolve immediately in that case.
      if (this.ready && this.view) {
        clearTimeout(timer);
        this.pending = undefined;
        resolve(true);
      }
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.view = undefined;
  }
}
