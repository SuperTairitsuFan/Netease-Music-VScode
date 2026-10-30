import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../protocol";
import { buildHtml } from "./surface";

export interface MainPanelDeps {
  handleCommand: (cmd: string, payload?: unknown, surface?: "main") => Promise<void> | void;
  onVisibility?: (visible: boolean) => void;
}

/** Editor-area content area: playlist / album / artist / search / home pages. */
export class MainPanelProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: MainPanelDeps,
  ) {}

  get visible(): boolean {
    return Boolean(this.panel?.visible);
  }

  get isReady(): boolean {
    return this.ready && Boolean(this.panel);
  }

  createOrShow(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "neteaseMusic.main",
      "网易云音乐",
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.ctx.extensionUri, this.ctx.globalStorageUri],
      },
    );
    this.ready = false;
    this.panel.webview.html = buildHtml(this.ctx, this.panel.webview, "main");
    this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "icon.png");
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.visible) this.deps.onVisibility?.(false);
      else {
        this.deps.onVisibility?.(true);
        this.post({ type: "theme", kind: String(vscode.window.activeColorTheme.kind) });
      }
    });
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
  }

  async reveal(): Promise<void> {
    this.createOrShow();
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === "ready") {
      this.ready = true;
      await this.deps.handleCommand("ready", undefined, "main");
      return;
    }
    if (msg.type === "cmd") {
      await this.deps.handleCommand(msg.cmd, msg.payload, "main");
    }
  }

  post(msg: HostMessage): void {
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(msg);
  }

  postRaw(msg: unknown): void {
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(msg);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.panel?.dispose();
    this.panel = undefined;
  }
}
