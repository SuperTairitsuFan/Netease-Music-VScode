import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../protocol";
import { buildHtml } from "./surface";

export interface SettingsPanelDeps {
  handleCommand: (cmd: string, payload?: unknown, surface?: "settings") => Promise<void> | void;
}

/** PC-client-style settings page with native-looking tabs. */
export class SettingsPanelProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private tab = "account";

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: SettingsPanelDeps,
  ) {}

  get activeTab(): string {
    return this.tab;
  }

  async open(tab?: string): Promise<void> {
    if (tab) this.tab = tab;
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (this.ready) {
        await this.deps.handleCommand("ready", undefined, "settings");
      }
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "neteaseMusic.settings",
      "网易云音乐 · 设置",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.ctx.extensionUri, this.ctx.globalStorageUri],
      },
    );
    this.ready = false;
    this.panel.webview.html = buildHtml(this.ctx, this.panel.webview, "settings");
    this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "settings.svg");
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
  }

  setTab(tab: string): void {
    this.tab = tab;
    if (this.ready) this.post({ type: "switchTab", tab });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === "ready") {
      this.ready = true;
      await this.deps.handleCommand("ready", undefined, "settings");
      return;
    }
    if (msg.type === "cmd") {
      await this.deps.handleCommand(msg.cmd, msg.payload, "settings");
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
    this.panel?.dispose();
    this.panel = undefined;
  }
}
