import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export type WebviewSurface = "sidebar" | "main" | "settings" | "extras";

export function nonce(): string {
  return randomBytes(16).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
}

const SCRIPT_BY_SURFACE: Record<WebviewSurface, string> = {
  sidebar: "dist/sidebar.js",
  main: "dist/webview.js",
  settings: "dist/settings.js",
  extras: "dist/webview.js",
};

const TITLE_BY_SURFACE: Record<WebviewSurface, string> = {
  sidebar: "网易云音乐",
  main: "网易云音乐",
  settings: "网易云音乐 · 设置",
  extras: "网易云音乐 · 扩展组件",
};

export function buildHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview, surface: WebviewSurface): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(ctx.extensionUri, ...SCRIPT_BY_SURFACE[surface].split("/")),
  );
  const style = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "dist", "webview.css"));
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.png"));
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `media-src ${webview.cspSource} https: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `connect-src ${webview.cspSource} https:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>${TITLE_BY_SURFACE[surface]}</title>
</head>
<body data-surface="${surface}">
<div id="app" data-logo="${logo}">
  <div class="boot"><span class="spinner"></span>正在加载网易云音乐…</div>
</div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
