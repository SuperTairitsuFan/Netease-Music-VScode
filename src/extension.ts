import * as vscode from "vscode";
import { App } from "./app";
import { initLogger, log } from "./util/logger";

let app: App | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  log.info("activating netease-music", {
    version: context.extension.packageJSON.version,
    platform: process.platform,
    arch: process.arch,
  });
  app = new App(context);
  context.subscriptions.push(app);
  try {
    await app.activate();
    log.info("netease-music activated");
  } catch (err) {
    log.error("activation failed", String(err));
    void vscode.window.showErrorMessage(`网易云音乐启动失败：${(err as Error).message}`);
  }
}

export function deactivate(): void {
  app?.dispose();
  app = undefined;
}
