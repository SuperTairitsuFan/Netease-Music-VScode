import type { Account } from "../api/types";
import type {
  ComponentView,
  HostMessage,
  NativeStatusView,
  SettingsState,
  SettingsView,
  WebviewCommand,
  WebviewMessage,
} from "../protocol";
import { cover, esc, qs } from "./dom";
import { icon } from "./icons";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const send = (cmd: WebviewCommand, payload?: unknown): void => vscode.postMessage({ type: "cmd", cmd, payload });

const app = document.getElementById("app")!;
const logo = app.dataset.logo ?? "";

let state: SettingsState | null = null;
let settings: SettingsView | null = null;
let account: Account | null = null;
let components: ComponentView[] = [];
let native: NativeStatusView = { installed: false, enabled: false, ready: false };
let tab = "account";
let modal: "login" | null = null;
let loginMode: "qr" | "phone" | "email" = "qr";
let qr: { dataUrl: string; code: number; message: string } | null = null;
let qrBusy = false;
let captchaLeft = 0;
let lyricsDetailsOpen = false;
let cacheConfirm = false;
let captchaTimer: ReturnType<typeof setInterval> | undefined;

const TABS: Array<{ key: string; label: string; icon: string }> = [
  { key: "account", label: "账号", icon: "account" },
  { key: "system", label: "系统", icon: "device" },
  { key: "quality", label: "音质与下载", icon: "verified" },
  { key: "general", label: "常规", icon: "settings" },
  { key: "playback", label: "播放", icon: "play" },
  { key: "components", label: "组件", icon: "puzzle" },
];

function boot(): void {
  app.innerHTML = `<div class="settings">
    <div class="set-wrap">
      <div class="set-head">${logo ? `<img src="${esc(logo)}" alt="">` : ""}<h1>网易云音乐设置</h1><span class="ver" id="set-ver"></span><span class="spacer"></span><button class="btn small" data-act="openVscodeSettings">${icon("external", 11)} VS Code 设置</button></div>
      <div class="set-tabs" id="set-tabs"></div>
      <div id="set-content"></div>
    </div>
  </div>
  <div class="toasts" id="toasts"></div>
  <div id="modal-root"></div>`;
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
document.addEventListener("toggle", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.classList.contains("lyrics-details")) lyricsDetailsOpen = target.hasAttribute("open");
}, true);
document.addEventListener("keydown", captureShortcut, true);
  vscode.postMessage({ type: "ready" });
}

function onClick(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.classList.contains("modal-backdrop")) {
    closeModal();
    return;
  }
  const el = target.closest<HTMLElement>("[data-act]");
  if (!el) return;
  const act = el.dataset.act ?? "";
  switch (act) {
    case "tab":
      tab = el.dataset.tab ?? "account";
      render();
      send("tab", { tab });
      break;
    case "quality":
      send("quality", { quality: el.dataset.quality });
      break;
    case "downloadQuality":
      send("downloadQuality", { quality: el.dataset.quality });
      break;
    case "toggleConfig": {
      const key = el.dataset.key ?? "";
      const value = el.dataset.value === "true";
      send("setConfig", { key, value: !value });
      break;
    }
    case "chooseDir":
      send("chooseDir", { key: el.dataset.key });
      break;
    case "applyLyricsColor": {
      const input = qs<HTMLInputElement>("#lyrics-color");
      if (input) send("setConfig", { key: "lyricsOverlay.color", value: input.value });
      break;
    }
    case "resetLyricsSettings":
      send("resetLyricsSettings");
      break;
    case "applyLyricsBorderColor": {
      const input = qs<HTMLInputElement>("#lyrics-border-color");
      if (input) send("setConfig", { key: "lyricsOverlay.borderColor", value: input.value });
      break;
    }
    case "chooseFontFile":
      send("chooseFontFile");
      break;
    case "resetShortcuts":
      send("resetShortcuts");
      break;
    case "openConfigFile":
      send("openConfigFile");
      break;
    case "openVscodeSettings":
      send("openVscodeSettings");
      break;
    case "openDocs":
      send("openDocs");
      break;
    case "showLog":
      send("showLog");
      break;
    case "refreshAccount":
      send("refreshAccount");
      break;
    case "logout":
      send("logout");
      break;
    case "login":
      openLogin();
      break;
    case "openMyProfile":
      send("openMyProfile");
      break;
    case "loginMode":
      loginMode = (el.dataset.mode as typeof loginMode) ?? "qr";
      if (loginMode === "qr" && !qr) {
        qrBusy = true;
        send("qrStart");
      } else if (loginMode !== "qr") {
        send("qrStop");
      }
      renderModal();
      break;
    case "qrStart":
      qr = null;
      qrBusy = true;
      renderModal();
      send("qrStart");
      break;
    case "sendCaptcha": {
      const phone = qs<HTMLInputElement>("#login-phone")?.value.trim();
      if (!phone) {
        toast("请填写手机号", "error");
        break;
      }
      send("sendCaptcha", { phone });
      captchaLeft = 60;
      if (captchaTimer) clearInterval(captchaTimer);
      captchaTimer = setInterval(() => {
        captchaLeft -= 1;
        const button = qs<HTMLButtonElement>("#captcha-btn");
        if (button) {
          button.textContent = captchaLeft > 0 ? `${captchaLeft}s` : "发送验证码";
          button.disabled = captchaLeft > 0;
        }
        if (captchaLeft <= 0 && captchaTimer) {
          clearInterval(captchaTimer);
          captchaTimer = undefined;
        }
      }, 1000);
      break;
    }
    case "phoneLogin": {
      const phone = qs<HTMLInputElement>("#login-phone")?.value.trim() ?? "";
      const captcha = qs<HTMLInputElement>("#login-code")?.value.trim() ?? "";
      const password = qs<HTMLInputElement>("#login-password")?.value ?? "";
      if (!phone) {
        toast("请填写手机号", "error");
        break;
      }
      send("phoneLogin", { phone, captcha, password });
      break;
    }
    case "emailLogin": {
      const username = qs<HTMLInputElement>("#login-email")?.value.trim() ?? "";
      const password = qs<HTMLInputElement>("#login-password-email")?.value ?? "";
      send("emailLogin", { username, password });
      break;
    }
    case "closeModal":
      closeModal();
      break;
    case "probeAudio":
      send("probeAudio");
      break;
    case "restartApp":
      send("restartApp");
      break;
    case "openDir":
      send("openDir", { dir: el.dataset.dir });
      break;
    case "clearCache":
      cacheConfirm = true;
      render();
      break;
    case "cacheClearConfirm":
      cacheConfirm = false;
      send("clearCache");
      render();
      break;
    case "cacheClearCancel":
      cacheConfirm = false;
      render();
      break;
    case "selectDevice":
      send("selectDevice");
      break;
    case "installComponent":
      send("installComponent");
      break;
    case "moveSortPriority":
      send("moveSortPriority", { key: el.dataset.key, direction: Number(el.dataset.direction ?? 0) });
      break;
    case "resetImmersive":
      send("resetImmersive");
      break;
    case "resetHeadset":
      send("resetHeadset");
      break;
    case "refreshComponents":
      send("refreshComponents");
      break;
    case "enableComponent":
      send("enableComponent", { id: el.dataset.id });
      break;
    case "disableComponent":
      send("disableComponent", { id: el.dataset.id });
      break;
    case "removeComponent":
      send("removeComponent", { id: el.dataset.id });
      break;
    case "verifyComponent":
      send("verifyComponent", { id: el.dataset.id });
      break;
    case "locateComponent":
      send("locateComponent", { id: el.dataset.id });
      break;
    case "restoreBundled":
      send("restoreBundled");
      break;
    case "openComponentDir":
      send("openComponentDir", { id: el.dataset.id });
      break;
    default:
      break;
  }
}

function captureShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLInputElement | null;
  if (!target?.dataset.shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Backspace" || event.key === "Delete") {
    target.value = "";
    send("setShortcut", { id: target.dataset.shortcut + (target.dataset.scope === "global" ? "Global" : ""), value: "" });
    return;
  }
  const key = event.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Win");
  const keyName: Record<string, string> = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", " ": "Space", Escape: "Escape" };
  parts.push(keyName[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  target.value = parts.join("+");
  send("setShortcut", { id: target.dataset.shortcut + (target.dataset.scope === "global" ? "Global" : ""), value: target.value });
}

function onChange(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement | null;
  if (!target) return;
  if (target.dataset.shortcut) {
    const suffix = target.dataset.scope === "global" ? "Global" : "";
    send("setShortcut", { id: `${target.dataset.shortcut}${suffix}`, value: target.value });
    return;
  }
  if (target.dataset.sidebarKey) {
    send("setSidebarItem", { key: target.dataset.sidebarKey, visible: (target as HTMLInputElement).checked });
    return;
  }
  if (target.dataset.headsetIndex) {
    const payload: Record<string, unknown> = { index: Number(target.dataset.headsetIndex) };
    const field = target.dataset.headsetField;
    if (field === "count") payload.count = Number(target.value);
    else if (field === "type") payload.type = target.value;
    else if (field === "action") payload.action = target.value;
    send("setHeadsetGesture", payload);
    return;
  }
  if (!target.dataset.config) return;
  let value: unknown = target.value;
  if (target instanceof HTMLInputElement && target.type === "checkbox") value = target.checked;
  if (target instanceof HTMLInputElement && target.type === "number") value = Number(target.value);
  if (target instanceof HTMLInputElement && target.type === "range") value = Number(target.value);
  if (["output.bufferMs", "playback.volume", "download.concurrent", "cache.maxSizeMB"].includes(target.dataset.config) || /^lyricsOverlay\.(size|opacity|width|height|weight|x|y)$/.test(target.dataset.config)) {
    value = Number(target.value);
  }
  send("setConfig", { key: target.dataset.config, value });
}

// --------------------------------------------------------------------- render

function render(): void {
  if (!state) return;
  const version = qs("#set-ver");
  if (version) version.textContent = `v${state.version} · ${state.platform}/${state.arch}`;
  const tabs = qs("#set-tabs");
  if (tabs) {
    tabs.innerHTML = TABS.map(
      (item) => `<button class="set-tab ${tab === item.key ? "active" : ""}" data-act="tab" data-tab="${item.key}">${item.label}</button>`,
    ).join("");
  }
  const content = qs("#set-content");
  if (!content) return;
  switch (tab) {
    case "account":
      content.innerHTML = renderAccount();
      break;
    case "general":
      content.innerHTML = renderGeneral();
      break;
    case "system":
      content.innerHTML = renderSystem();
      break;
    case "playback":
      content.innerHTML = renderPlayback();
      break;
    case "quality":
      content.innerHTML = renderQuality();
      break;
    case "components":
      content.innerHTML = renderComponents();
      break;
  }
}

function accountBadge(): string {
  if (!account) return `<span class="vip-badge" style="background:var(--hover);color:var(--muted)">未登录</span>`;
  const vip = Number(account.vipType ?? 0);
  if (vip >= 10) return `<span class="vip-badge svip">SVIP</span>`;
  if (vip > 0) return `<span class="vip-badge">VIP</span>`;
  return `<span class="vip-badge" style="background:var(--hover);color:var(--muted)">普通用户</span>`;
}

function renderAccount(): string {
  const st = settings?.stats;
  const cfg = settings!;
  const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? (n / 1024 / 1024 / 1024).toFixed(2) + " GB" : (n / 1024 / 1024).toFixed(1) + " MB");
  const statsCard = st
    ? `<div class="set-card"><div class="set-card-head"><div class="t">本机资源占用</div><div class="d">实时读取当前配置目录</div></div>
      <div class="set-row"><div><div class="label">插件安装位置</div><div class="hint">${esc(st.extensionPath)}</div></div><div class="control"><button class="btn small" data-act="openDir" data-dir="extension">打开目录</button></div></div>
      <div class="set-row"><div><div class="label">插件本体</div><div class="hint">${mb(st.extensionBytes)}</div></div></div>
      <div class="set-row"><div><div class="label">下载歌曲</div><div class="hint">${st.downloadFiles} 首 · ${mb(st.downloadBytes)}</div></div><div class="control"><button class="btn small" data-act="openDir" data-dir="download">打开目录</button></div></div>
      <div class="set-row"><div><div class="label">下载封面</div><div class="hint">${st.coverFiles} 张 · ${mb(st.coverBytes)}</div></div><div class="control"><button class="btn small" data-act="openDir" data-dir="cover">打开目录</button></div></div>
      <div class="set-row"><div><div class="label">本地音乐</div><div class="hint">${st.localFiles} 首 · ${mb(st.localBytes)}</div></div><div class="control"><button class="btn small" data-act="openDir" data-dir="local">打开目录</button></div></div>
    </div>`
    : "";
  const cacheCard = `<div class="set-card"><div class="set-card-head"><div class="t">音频缓存</div><div class="d">播放缓存、容量与目录</div></div>
    <div class="set-row"><div><div class="label">当前缓存</div><div class="hint">${st ? `${st.cacheFiles} 首 · ${mb(st.cacheBytes)}` : "读取中"}</div></div><div class="control"><button class="btn small danger" data-act="clearCache">清除缓存</button><button class="btn small" data-act="openDir" data-dir="cache">打开目录</button></div></div>
    ${switchRow("启用音频缓存", "关闭后播放、切换歌曲和进度跳转需要重新下载，无法即点即播；使用原生引擎时不可修改，WebAudio 下可关闭。", "cache.enabled", cfg.cacheEnabled, cfg.cacheLocked)}
    ${switchRow("开启歌单缓存", "启用后在缓存目录下创建 library 目录，保存每日推荐和喜欢/收藏歌曲表格；关闭时直接使用网络数据。", "cache.libraryEnabled", cfg.libraryCacheEnabled)}
    <div class="set-row"><div><div class="label">歌单缓存文件</div><div class="hint">推荐缓存：netease-recommend.json · 歌单表格：netease-favorites.csv / netease-library.csv</div></div><div class="control"><button class="btn small" data-act="refreshRecommendCache">刷新推荐缓存</button><button class="btn small" data-act="refreshLibraryCache">刷新歌单缓存</button></div></div>
    ${cacheConfirm ? '<div class="set-row"><div><div class="label">确认清除音频缓存？</div><div class="hint">将删除当前缓存目录内的全部音频与 .part 文件，正在播放的文件可能被占用。</div></div><div class="control"><button class="btn small danger" data-act="cacheClearConfirm">确定清除</button><button class="btn small" data-act="cacheClearCancel">取消</button></div></div>' : ""}
    <div class="set-row"><div><div class="label">缓存上限</div><div class="hint">超出后按最近最少使用清理</div></div><div class="control"><input type="number" min="64" value="${cfg.cacheMaxSizeMB}" data-config="cache.maxSizeMB" style="width:100px" /> MB</div></div>
    <div class="set-row"><div><div class="label">缓存目录</div><div class="hint">${esc(cfg.cacheDir)}<br>歌曲文件实际保存在所选目录的 songs 子目录</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="cache.dir">${icon("folder", 11)} 更改目录</button></div></div>
  </div>`;
  if (!account) {
  return `<div class="set-card"><div class="set-card-head"><div class="t">账号</div><div class="d">当前插件版本 v${esc(settings?.version ?? "")}</div><div class="d">登录后可同步歌单、收藏与会员音质</div></div>
      <div class="account-card">
        <div style="width:72px;height:72px;border-radius:50%;background:var(--hover);display:flex;align-items:center;justify-content:center;color:var(--muted)">${icon("login", 28)}</div>
        <div><div class="name">未登录</div><div class="id">使用网易云音乐 App 扫码，或手机验证码 / 密码登录</div></div>
        <div class="actions"><button class="btn primary" data-act="login">${icon("login", 12)} 登录</button></div>
      </div>
    </div>` + statsCard + cacheCard;
  }
  return `<div class="set-card"><div class="set-card-head"><div class="t">账号</div><div class="d">登录状态、会员标识与退出登录</div></div>
    <div class="account-card">
      <img src="${esc(cover(account.avatarUrl, 160))}" alt="" data-act="openMyProfile" title="查看我的主页">
      <div style="min-width:0">
        <div class="name">${esc(account.nickname)} ${accountBadge()}</div>
        <div class="id">用户 ID：${account.userId}${account.createTime ? ` · 注册于 ${new Date(account.createTime).toLocaleDateString("zh-CN")}` : ""}</div>
        ${account.signature ? `<div class="sig">${esc(account.signature)}</div>` : ""}
        ${account.follows !== undefined ? `<div class="sig">关注 ${account.follows} · 粉丝 ${account.followeds ?? 0}</div>` : ""}
      </div>
      <div class="actions">
        <button class="btn small" data-act="refreshAccount">${icon("refresh", 11)} 刷新</button>
        <button class="btn small" data-act="logout">${icon("logout", 11)} 退出登录</button>
      </div>
    </div>
    <div class="set-row"><div><div class="label">会员音质</div><div class="hint">SVIP 可使用高清臻音 / 超清母带；当前版本不支持沉浸环绕声、EQ 与音效调整。</div></div><div class="control">${accountBadge()}</div></div>
  </div>` + statsCard + cacheCard;
}

function switchRow(label: string, hint: string, key: string, value: boolean, disabled = false): string {
  return `<div class="set-row ${disabled ? "disabled-row" : ""}"><div><div class="label">${esc(label)}</div><div class="hint">${esc(hint)}</div></div><div class="control"><button class="switch ${value ? "on" : ""}" data-act="toggleConfig" data-key="${key}" data-value="${value}" title="切换" ${disabled ? "disabled" : ""}></button></div></div>`;
}

function selectRow(
  label: string,
  hint: string,
  key: string,
  value: string,
  options: Array<{ value: string; label: string; disabled?: boolean }>,
  disabled = false,
): string {
  return `<div class="set-row ${disabled ? "disabled-row" : ""}"><div><div class="label">${esc(label)}</div><div class="hint">${esc(hint)}</div></div><div class="control"><select data-config="${key}" ${disabled ? "disabled" : ""}>${options
    .map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""} ${option.disabled ? "disabled" : ""}>${esc(option.label)}</option>`)
    .join("")}</select></div></div>`;
}

function renderGeneral(): string {
  const cfg = settings!;
  return `<div class="set-card"><div class="set-card-head"><div class="t">常规</div><div class="d">启动行为与外观</div></div>
    ${switchRow("启动时打开主界面", "关闭后只在侧边栏中显示，点击状态栏或命令再打开主界面", "ui.autoOpen", cfg.autoOpen)}
    ${switchRow("启动时自动开始播放", "VS Code 启动后自动恢复上次队列并开始播放；WebAudio 首次播放可能被浏览器拦截，失败时点击播放按钮继续。需要保留“恢复上次队列”。", "playback.startOnLaunch", cfg.startOnLaunch)}
    ${selectRow("外观", "跟随 VS Code 主题，或强制深色 / 浅色控件", "ui.theme", cfg.themeMode, [
      { value: "auto", label: "跟随 VS Code" },
      { value: "dark", label: "深色" },
      { value: "light", label: "浅色" },
    ])}
    ${switchRow("紧凑模式", "隐藏大封面、压缩间距，适合较窄的侧边栏", "ui.compact", cfg.compact)}
    ${switchRow("显示歌词", "在正在播放页显示歌词面板", "ui.showLyrics", cfg.showLyrics)}
    <div class="set-row"><div><div class="label">高级配置</div><div class="hint">所有参数都在 settings.json 中，可直接编辑。</div></div><div class="control"><button class="btn small" data-act="openConfigFile">打开 settings.json</button><button class="btn small" data-act="openVscodeSettings">扩展设置</button></div></div>
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">关于与诊断</div><div class="d">EAPI 客户端与原生音频输出</div></div>
    <div class="set-row"><div><div class="label">构建信息</div><div class="hint">${esc(state?.version ?? "")} · ${esc(state?.platform ?? "")}/${esc(state?.arch ?? "")} · EAPI 直连 · 原生引擎 ${native.ready ? "就绪" : "未就绪"}</div></div><div class="control"><button class="btn small" data-act="showLog">${icon("list", 11)} 日志</button><button class="btn small" data-act="openDocs">${icon("info", 11)} 文档</button></div></div>
  </div>`;
}

function outputChainCard(): string {
  const output = state?.output;
  const actual = state?.actualQuality || settings?.quality || "";
  const nativeOut = output?.kind === "native";
  const format = output?.format;
  const formatText = format ? `${(format.sampleRate / 1000).toFixed(1)} kHz · ${format.bits} bit · ${format.channels} ch` : "";
  const backend = (output?.backend ?? settings?.nativeBackend ?? "wasapi").toUpperCase();
  const source = output?.kind === "none"
    ? esc(output.detail || "未开始播放")
    : actual === "local" ? "本地文件 · 直接读取" : `网易云流 · ${esc(QUALITY_TEXT_FALLBACK(actual))}`;
  const decode = nativeOut ? "Native Engine 解码 → PCM" : "Chromium / WebAudio 解码 → PCM";
  const out = nativeOut ? `${backend} · ${formatText || output?.detail || "原生输出"}` : "WebAudio 共享输出";
  const device = output?.deviceName || (settings?.device && settings.device !== "default" ? settings.device : "系统默认输出设备");
  return `<div class="set-card"><div class="set-card-head"><div class="t">输出链路</div><div class="d">实时读取当前播放路径${output?.kind === "none" ? " · 未播放" : ""}</div></div>
    <div class="set-row stack"><div class="control" style="display:block"><div class="chain">
      <div class="node active">${source}</div>
      <div class="arrow">▼</div>
      <div class="node">${decode}</div>
      <div class="arrow">▼</div>
      <div class="node ${nativeOut ? "active" : ""}">${out}<div class="chain-sub">${esc(output?.detail ?? "")}</div></div>
      <div class="arrow">▼</div>
      <div class="node">${esc(device)}<div class="chain-sub">${nativeOut ? "WASAPI / ASIO 端点" : "系统共享混音器 · Chromium 输出"}</div></div>
    </div></div></div>
  </div>`;
}

function renderSystem(): string {
  const cfg = settings!;
  const isLinux = state?.platform === "linux";
  const devices = native.devices ?? [];
  const hasAsio = devices.some((device) => device.backend === "asio");
  const backendDevices = devices.filter((device) => device.backend === cfg.nativeBackend);
  const defaultDevice = backendDevices.find((device) => device.isDefault) ?? backendDevices[0];
  const selectedDevice =
    (cfg.device === "default" ? defaultDevice : devices.find((device) => device.id === cfg.device && device.backend === cfg.nativeBackend)) ??
    defaultDevice;
  const bluetooth = /bluetooth|蓝牙|hands-free|airpods|buds|wh-1000|wf-1000/i.test(selectedDevice?.name ?? "");
  const formatOptions = ["auto", "44100", "48000", "88200", "96000", "176400", "192000", "352800", "384000"];
  const bitOptions = ["auto", "16", "24", "32"];
  const sampleFormats = ["auto", "s16le", "s24le", "s32le", "f32le"];
  return `<div class="set-card"><div class="set-card-head"><div class="t">音频输出</div><div class="d">原生引擎由独立组件提供，可启用 / 禁用 / 卸载</div></div>
    ${isLinux ? `<div class="set-row"><div><div class="label">Linux 支持</div><div class="hint">当前 Linux 使用 ALSA 原生输出；WASAPI / ASIO 为 Windows 专用，ASIO 选项不可用。请等后续完善。</div></div></div>` : ""}
    ${selectRow("输出模式", bluetooth ? "蓝牙可使用原生 WASAPI 共享模式；独占和 Bit-perfect 不可用" : "默认 WebAudio；native 强制原生，失败不回退", "output.mode", cfg.outputMode, [
      { value: "auto", label: "自动（优先 WebAudio，开箱即用）" },
      { value: "webaudio", label: "仅 WebAudio（免驱动，可能被浏览器拦截）" },
      { value: "native", label: "仅原生引擎（蓝牙建议 WASAPI 共享）" },
    ])}
    <div class="set-row"><div><div class="label">输出设备</div><div class="hint">${esc(selectedDevice?.name ?? (cfg.device || "系统默认设备"))}${bluetooth ? " · 蓝牙设备" : ""}</div></div><div class="control"><button class="btn small" data-act="probeAudio">${icon("pulse", 11)} 探测</button><button class="btn small" data-act="selectDevice">${icon("device", 11)} 选择设备</button></div></div>
    ${selectRow("原生后端", isLinux ? "当前 Linux 不支持 ASIO，请等后续完善" : hasAsio ? "检测到 ASIO 驱动，可手动选择；默认使用 WASAPI" : "未检测到 ASIO 驱动，只能使用 WASAPI", "output.backend", cfg.nativeBackend, [
      { value: "wasapi", label: "WASAPI（兼容好，支持共享/独占）" },
      { value: "asio", label: "ASIO（需厂商驱动）", disabled: !hasAsio || isLinux },
    ])}
    <div class="set-row"><div><div class="label">怎么选</div><div class="hint">默认使用 WebAudio；原生后端默认 WASAPI。检测到 ASIO 驱动后可手动选择 ASIO。独占、Bit-perfect 与长驻 seek 默认关闭。</div></div></div>
    <div class="set-row"><div><div class="label">重启 VS Code</div><div class="hint">关闭所有 VS Code 窗口后自动重新启动，组件/设置改动会生效</div></div><div class="control"><button class="btn small" data-act="restartApp">重启生效</button></div></div>
    ${switchRow("独占模式", bluetooth ? "蓝牙设备默认使用 WebAudio，独占模式不可用" : "Windows WASAPI Exclusive / Linux ALSA hw: 直连，绕过系统混音器", "output.exclusive", cfg.exclusive, bluetooth)}
    ${switchRow("Bit-perfect（严格）", bluetooth ? "蓝牙链路会重采样，Bit-perfect 不可用" : "强制原生 Exclusive + 源采样率/位深；音量固定 100%，不做增益", "output.bitPerfect", cfg.bitPerfect, bluetooth)}
    ${switchRow("双声道空间增强（HRTF）", "交叉馈电 + 耳间延迟 + 轻微声场扩展，让耳机更接近音箱；仅原生引擎生效，会改变原声，与 Bit-perfect 互斥", "output.hrtf", cfg.hrtf, bluetooth)}
    <div class="set-row"><div><div class="label">长驻 seek 说明</div><div class="hint">作用：同一首歌、同一设备内拖动进度条更快，不再反复释放和打开 WASAPI/ASIO。<br>可能的问题：暂停后仍占用独占设备，其他软件可能没有声音；切换设备或后端仍会重开；下载中的 .part 文件仍走原逻辑。<br>解决：没有声音时关闭此选项并重新播放；需要释放设备时暂停并关闭此选项，或改用 WASAPI 共享。</div></div></div>
    ${switchRow("长驻原生 seek","开启后同一设备内点击进度条只重新定位解码，不重启原生进程、不重新打开 DAC；会持续占用独占设备。切换设备/后端仍会重新打开。","output.persistentSeek",cfg.persistentSeek)}
    ${selectRow("采样率", "auto 跟随音源；手动值必须与音源一致（引擎不做重采样）", "output.sampleRate", cfg.sampleRate, formatOptions.map((value) => ({ value, label: value === "auto" ? "auto（跟随音源）" : `${Number(value) / 1000} kHz` })))}
    ${selectRow("位深", "32 bit 是否可用取决于 USB DAC 与驱动", "output.bitDepth", cfg.bitDepth, bitOptions.map((value) => ({ value, label: value === "auto" ? "auto" : `${value} bit` })))}
    ${selectRow("样本格式", "设备端格式；引擎输入永远是 float32 PCM", "output.sampleFormat", cfg.sampleFormat, sampleFormats.map((value) => ({ value, label: value === "auto" ? "auto" : value })))}
    <div class="set-row"><div><div class="label">缓冲区</div><div class="hint">${cfg.bufferMs} ms · 独占模式建议 3–20 ms</div></div><div class="control"><input type="number" min="3" max="500" step="1" value="${cfg.bufferMs}" data-config="output.bufferMs" style="width:90px" /></div></div>
    <div class="set-row"><div><div class="label">原生引擎</div><div class="hint">${native.ready ? `就绪 · ${esc(native.backend ?? "")}${native.version ? ` · v${esc(native.version)}` : ""}` : esc(native.reason ?? "未安装或未启用")}<br>${esc(native.path ?? "")}</div></div><div class="control"><button class="btn small" data-act="enableComponent" data-id="native-audio-output">启用</button><button class="btn small" data-act="installComponent">安装组件</button></div></div>
    ${devices.length ? `<div class="set-row stack"><div><div class="label">已探测设备</div><div class="hint">设备支持的实际格式</div></div><div class="control" style="display:block"><div class="device-list">${devices
      .map(
        (device) => `<div class="device"><span class="status-dot ${device.isDefault ? "ready" : "disabled"}"></span><span>${esc(device.name)}</span><span class="muted tiny">${esc(device.backend)}${device.isDefault && device.backend === cfg.nativeBackend ? " · 默认" : ""}</span><span class="formats">${device.formats.map((format) => `${format.sampleRate / 1000}k/${format.bits}bit`).join(" · ")}</span></div>`,
      )
      .join("")}</div></div></div>` : ""}
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">音频故障排查</div><div class="d">无声、无法播放或设备切换失败时按顺序检查</div></div>
    <div class="set-row"><div><div class="label">耳机不支持 ASIO，却选中了 ASIO</div><div class="hint">切到 WASAPI 后端，再选择该耳机的 WASAPI 设备；没有 ASIO 驱动时不要强行使用 ASIO。</div></div></div>
    <div class="set-row"><div><div class="label">ASIO 无声、打开失败或被占用</div><div class="hint">关闭其他正在独占声卡的软件；仍失败时改用 WASAPI。ASIO 同时只能被一个程序占用。</div></div></div>
    <div class="set-row"><div><div class="label">WASAPI 无法播放</div><div class="hint">关闭“独占模式”和“Bit-perfect”，把输出模式改为 WebAudio 后重新播放；如果恢复，说明设备的独占格式不可用。</div></div></div>
    <div class="set-row"><div><div class="label">采样率或位深不支持</div><div class="hint">把采样率、位深、样本格式都改为 auto；仍失败时把位深改为 16 bit，或切换 WASAPI。</div></div></div>
    <div class="set-row"><div><div class="label">蓝牙耳机无声</div><div class="hint">蓝牙可以使用原生 WASAPI 共享模式；不要开启独占或 Bit-perfect。设备切换后重新选择蓝牙端点。</div></div></div>
    <div class="set-row"><div><div class="label">拔掉 DAC 后列表还有旧设备</div><div class="hint">重新插拔后点“探测”，再选择当前存在的设备；不要继续使用已拔掉的 ASIO/WASAPI ID。</div></div></div>
    <div class="set-row"><div><div class="label">进度条不走或一直无声</div><div class="hint">关闭其他播放器释放独占；仍卡住时退出所有 VS Code 窗口后重开，并清除残留缓存。</div></div></div>
  </div>
  ${outputChainCard()}
`;
}

function QUALITY_TEXT_FALLBACK(value: string): string {
  const map: Record<string, string> = {
    standard: "标准",
    higher: "较高",
    exhigh: "极高",
    lossless: "无损",
    hires: "Hi-Res",
    jyeffect: "高清臻音",
    sky: "沉浸环绕声",
    jymaster: "超清母带",
  };
  return map[value] ?? value ?? "";
}

function renderPlayback(): string {
  const cfg = settings!;
  return `<div class="set-card"><div class="set-card-head"><div class="t">播放</div><div class="d">音量、模式与后台行为</div></div>
    <div class="set-row"><div><div class="label">音量</div><div class="hint">${cfg.volume}%</div></div><div class="control"><input type="range" min="0" max="100" step="1" value="${cfg.volume}" data-config="playback.volume" style="width:240px" /></div></div>
    ${selectRow("播放模式", "顺序 / 列表循环 / 单曲循环 / 随机", "playback.mode", cfg.mode, [
      { value: "order", label: "顺序播放" },
      { value: "repeat", label: "列表循环" },
      { value: "repeatOne", label: "单曲循环" },
      { value: "shuffle", label: "随机播放" },
    ])}
    ${switchRow("后台播放", "收起侧边栏或隐藏主界面时继续播放；原生引擎由宿主进程输出", "playback.backgroundPlay", cfg.backgroundPlay)}
    ${switchRow("恢复上次队列", "重启 VS Code 后恢复播放队列与当前曲目", "playback.rememberQueue", cfg.rememberQueue)}
    ${switchRow("自动继续播放", "打开播放器时自动继续上次的播放", "playback.autoPlay", cfg.autoPlay)}
    <div class="set-row"><div><div class="label">状态栏</div><div class="hint">上一首 / 播放暂停 / 下一首 / 歌名跑马灯 / 音质 / 音量</div></div><div class="control"><span class="muted tiny">状态栏右侧常驻</span></div></div>
  </div>`;
}

function qualityRow(key: string, label: string, description: string, tier: string, active: boolean, action: "quality" | "downloadQuality"): string {
  return `<div class="quality-row ${active ? "active" : ""}" data-act="${action}" data-quality="${key}">
    <span class="radio"></span>
    <span class="name">${esc(label)}</span>
    <span class="desc">${esc(description)}</span>
    <span class="spacer"></span>
    ${tier === "svip" ? `<span class="vip-badge svip">SVIP</span>` : tier === "vip" ? `<span class="vip-badge">VIP</span>` : ""}
  </div>`;
}

function renderQuality(): string {
  const cfg = settings!;
  const options = state?.qualityOptions ?? [];
  const playbackRows = options
    .map((option) => qualityRow(option.key, option.label, option.description, option.tier, cfg.quality === option.key, "quality"))
    .join("");
  const downloadRows = `<div class="quality-row ${cfg.downloadQuality === "auto" ? "active" : ""}" data-act="downloadQuality" data-quality="auto">
      <span class="radio"></span><span class="name">跟随播放音质</span><span class="desc">自动使用当前播放档位</span><span class="spacer"></span>
    </div>${options
    .map((option) => qualityRow(option.key, option.label, option.description, option.tier, cfg.downloadQuality === option.label, "downloadQuality"))
    .join("")}`;
  return `<div class="set-card"><div class="set-card-head"><div class="t">音质播放设置</div><div class="d">当前账号：${account ? esc(account.nickname) : "未登录"} ${accountBadge()}</div></div>
    <div class="quality-list">${playbackRows}</div>
    <div class="set-row"><div><div class="label">实际音质</div><div class="hint">服务端可能按版权与会员权益降级；状态栏显示实际返回的档位。参数为常见上限，实际以服务端返回为准。</div></div></div>
    <div class="set-row"><div><div class="label">当前版本限制</div><div class="hint">当前版本不支持沉浸环绕声、EQ 与音效调整；只提供 WebAudio / WASAPI / ASIO 的原始音频输出，不做音效处理。</div></div></div>
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">音质下载设置</div><div class="d">下载任务使用的音质档位</div></div>
    <div class="quality-list">${downloadRows}</div>
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">目录与文件</div><div class="d">下载 / 缓存 / 本地音乐目录</div></div>
    <div class="set-row"><div><div class="label">下载目录</div><div class="hint">${esc(cfg.downloadDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="download.dir">${icon("folder", 11)} 更改目录</button><button class="btn small" data-act="openDownloadDir">打开</button></div></div>
    <div class="set-row"><div><div class="label">封面保存目录</div><div class="hint">${esc(cfg.coverDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="cover.dir">${icon("folder", 11)} 更改目录</button></div></div>
    <div class="set-row"><div><div class="label">封面文件名</div><div class="hint">可用变量：{name}（曲名）、{artist}（歌手）</div></div><div class="control"><input type="text" value="${esc(cfg.coverFilenameTemplate)}" data-config="cover.filenameTemplate" /></div></div>

    <div class="set-row"><div><div class="label">本地音乐目录</div><div class="hint">${esc(cfg.localMusicDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="localMusic.dir">${icon("folder", 11)} 更改目录</button></div></div>
    <div class="set-row"><div><div class="label">文件名模板</div><div class="hint">可用变量：{artist} {name} {album} {id} {quality} {ext}</div></div><div class="control"><input type="text" value="${esc(cfg.filenameTemplate)}" data-config="download.filenameTemplate" /></div></div>
    <div class="set-row"><div><div class="label">并发下载</div><div class="hint">1–4 个任务</div></div><div class="control"><input type="number" min="1" max="4" value="${cfg.downloadConcurrent}" data-config="download.concurrent" style="width:80px" /></div></div>
    ${switchRow("写入 ID3 标签", "MP3 下载后写入标题、歌手、专辑与封面", "download.writeMetadata", cfg.writeMetadata)}
    ${switchRow("保存歌词", "下载时同时保存同名 .lrc 文件", "download.saveLyric", cfg.saveLyric)}
  </div>
`;
}

function componentCard(item: ComponentView): string {
  const status = item.kind === "builtin"
    ? "就绪"
    : item.status === "ready" ? "就绪" : item.status === "disabled" ? "已禁用" : item.status === "invalid" ? "异常" : item.status === "removed" ? "已移除" : "不兼容";
  const actions: string[] = [];
  if (item.kind !== "builtin" && item.removable) {
    actions.push(
      item.enabled
        ? `<button class="btn small" data-act="disableComponent" data-id="${esc(item.id)}">禁用</button>`
        : `<button class="btn small primary" data-act="enableComponent" data-id="${esc(item.id)}">启用</button>`,
    );
    if (item.kind === "native") actions.push(`<button class="btn small" data-act="locateComponent" data-id="${esc(item.id)}">重新定位</button>`);
    actions.push(`<button class="btn small" data-act="verifyComponent" data-id="${esc(item.id)}">校验</button>`);
    actions.push(`<button class="btn small" data-act="openComponentDir" data-id="${esc(item.id)}">目录</button>`);
    actions.push(`<button class="btn small" data-act="removeComponent" data-id="${esc(item.id)}">卸载</button>`);
  }
  return `<div class="component-card">
    <div class="component-head"><span class="status-dot ${item.status}"></span><span class="name">${esc(item.name)}</span><span class="meta">${esc(item.version)} · ${status} · ${esc(item.kind)}</span></div>
    <div class="component-desc">${esc(item.description ?? "")}${item.reason ? `<br><span style="color:var(--red)">${esc(item.reason)}</span>` : ""}</div>
    <div class="component-actions">${actions.join("")}</div>
  </div>`;
}

function fontOptions(current: string, key: string): string {
  const list = [...(settings?.fonts ?? [])];
  if (current && !list.includes(current)) list.unshift(current);
  if (!list.length) list.push("Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "SimSun");
  return '<select data-config="' + key + '">' + list.map((name) => '<option value="' + esc(name) + '"' + (name === current ? ' selected' : '') + '>' + esc(name) + '</option>').join("") + '</select>';
}

function sidebarItemRows(): string {
  const items: Array<[string, string]> = [
    ["account", "账号详细"],
    ["recommend", "推荐"], ["featured", "精选"], ["podcast", "播客"], ["roam", "漫游"],
    ["following", "关注"], ["friends", "好友"], ["all", "全部音乐"], ["liked", "我喜欢的音乐"],
    ["recent", "最近播放"], ["collections", "我的收藏"], ["downloads", "下载管理"],
    ["local", "本地音乐"], ["cloud", "我的音乐网盘"], ["created", "创建的歌单"], ["subscribed", "收藏的歌单"],
  ];
  const visible = new Set(state?.sidebarVisible ?? items.map(([key]) => key));
  return `<div class="set-card headless" style="margin:0;border:0;border-top:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">侧边栏按钮</div><div class="d">勾选后在侧边栏显示；取消勾选即隐藏</div></div>
    <div class="sidebar-toggle-grid">${items.map(([key, label]) => `<label class="sidebar-toggle"><span><span class="sidebar-toggle-label">${label}</span><span class="sidebar-toggle-key">${key}</span></span><input type="checkbox" data-sidebar-key="${key}" ${visible.has(key) ? "checked" : ""} /></label>`).join("")}</div>
  </div>`;
}

function headsetRows(): string {
  const gestures = state?.headsetGestures ?? [
    { type: "clicks", count: 1, action: "toggle" },
    { type: "clicks", count: 2, action: "next" },
    { type: "clicks", count: 3, action: "previous" },
    { type: "long", count: 1, action: "none" },
  ];
  const actionRows: Array<[string, string]> = [
    ["toggle", "播放 / 暂停"],
    ["previous", "上一首"],
    ["next", "下一首"],
  ];
  const types: Array<[string, string]> = [
    ["clicks", "短按"],
    ["long", "长按"],
  ];
  return `<div class="set-card headless" style="margin:0;border:0;border-top:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">单按钮耳机控制自定义</div><div class="d">左边是功能，右边选择短按或长按</div></div>
    ${actionRows.map(([action, label]) => {
      const index = gestures.findIndex((gesture) => gesture.action === action);
      if (index < 0) return "";
      const gesture = gestures[index];
      return `<div class="set-row"><div><div class="label">${label}</div><div class="hint">${gesture.type === "clicks" ? `短按 ${gesture.count} 次` : gesture.type === "long" ? "长按" : `长按 + ${gesture.count} 次点击 + 长按`}</div></div><div class="control" style="gap:6px;flex-wrap:wrap;justify-content:flex-end"><select data-headset-index="${index}" data-headset-field="type">${types.map(([key, text]) => `<option value="${key}"${key === gesture.type ? " selected" : ""}>${text}</option>`).join("")}</select><input type="number" min="1" max="9" value="${gesture.count}" data-headset-index="${index}" data-headset-field="count" style="width:58px" ${gesture.type === "long" ? "disabled" : ""} /></div></div>`;
    }).join("")}
    <div class="set-row"><div><div class="label">恢复默认</div><div class="hint">播放暂停短按 1 次，上一首 3 次，下一首 2 次，长按默认不执行</div></div><div class="control"><button class="btn small" data-act="resetHeadset">恢复默认</button></div></div>
  </div>`;
}

function immersiveRows(): string {
  const cfg = settings!;
  return `<div class="set-card headless" style="margin:0;border:0;border-top:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">沉浸歌词</div><div class="d">侧边栏、频谱、歌词样式与偏移</div></div>
    ${switchRow("进入沉浸歌词时自动隐藏侧边栏", "新用户默认开启；返回普通歌曲页时恢复侧边栏", "immersive.autoHideSidebar", cfg.immersiveAutoHide)}
    ${switchRow("显示频谱", "在沉浸歌词界面显示音频频谱", "immersive.spectrum", cfg.immersiveSpectrum)}
    ${switchRow("启用歌词设置", "在歌曲详细页普通歌词栏右下角显示紧凑的偏移调节", "immersive.lyricSettings", cfg.immersiveLyricSettings)}
    <div class="set-row"><div><div class="label">歌词字体</div><div class="hint">支持系统字体名称</div></div><div class="control"><input type="text" data-config="immersive.font" value="${esc(cfg.immersiveFont)}" style="width:220px" /></div></div>
    <div class="set-row"><div><div class="label">字体颜色</div><div class="hint">沉浸歌词主文字颜色</div></div><div class="control"><input type="color" data-config="immersive.color" value="${esc(cfg.immersiveColor)}" /></div></div>
    <div class="set-row"><div><div class="label">透明度</div><div class="hint">0.2 到 1.0</div></div><div class="control"><input type="number" min="0.2" max="1" step="0.05" data-config="immersive.opacity" value="${cfg.immersiveOpacity}" style="width:90px" /></div></div>
    ${switchRow("歌词发光", "为歌词文字增加柔和发光", "immersive.glow", cfg.immersiveGlow)}
    <div class="set-row"><div><div class="label">恢复默认</div><div class="hint">字体、颜色、透明度、发光与偏移设置</div></div><div class="control"><button class="btn small" data-act="resetImmersive">恢复默认</button></div></div>
  </div>`;
}

function sortPriorityRows(): string {
  const keys = state?.sortPriority ?? ["artist", "album", "title", "duration", "liked"];
  const labels: Record<string, string> = { artist: "歌手", album: "专辑", title: "标题", duration: "时长", liked: "喜欢" };
  return `<div class="set-card headless" style="margin:0;border:0;border-top:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">列表排序权重</div><div class="d">数值越小优先级越高；所有歌单和歌手歌曲表共用</div></div>
    ${keys.map((key, index) => `<div class="set-row"><div><div class="label">${index + 1}. ${labels[key] ?? key}</div><div class="hint">${key}</div></div><div class="control"><button class="btn small" data-act="moveSortPriority" data-key="${key}" data-direction="-1" ${index === 0 ? "disabled" : ""}>↑ 上移</button><button class="btn small" data-act="moveSortPriority" data-key="${key}" data-direction="1" ${index === keys.length - 1 ? "disabled" : ""}>↓ 下移</button></div></div>`).join("")}
  </div>`;
}

function renderComponents(): string {
  const isLinux = state?.platform === "linux";
  const builtins = components.filter((item) => item.kind === "builtin");
  const natives = components.filter((item) => item.kind === "native");
  const uis = components.filter((item) => item.kind === "ui");
  return `<div class="set-card"><div class="set-card-head"><div class="t">组件管理</div><div class="d">原生引擎、内置模块与第三方 UI 组件均可独立启用 / 禁用 / 卸载</div></div>
    <div class="set-row"><div><div class="label">组件目录</div><div class="hint">${esc(settings?.componentsDir ?? "")}</div></div><div class="control"><button class="btn small" data-act="refreshComponents">${icon("refresh", 11)} 刷新</button><button class="btn small primary" data-act="installComponent">${icon("plus", 11)} 安装组件</button></div></div>
    ${native.ready ? `<div class="set-row"><div><div class="label">原生音频输出</div><div class="hint">${esc(native.backend ?? "")} · ${native.devices?.length ?? 0} 个设备</div></div><div class="control"><span class="pill accent">就绪</span></div></div>` : `<div class="set-row"><div><div class="label">原生音频输出</div><div class="hint">${esc(native.reason ?? "未安装或未启用")}</div></div><div class="control"><span class="pill">未就绪</span></div></div>`}
    <div class="set-card headless" style="margin:0;border:0;border-bottom:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">原生组件</div></div>${natives.length ? natives.map(componentCard).join("") : `<div class="empty">未安装 Native Audio Output Engine<br><button class="btn small" data-act="restoreBundled" style="margin-top:8px">${icon("refresh", 11)} 恢复随包原生引擎</button></div>`}</div>
    <div class="set-card headless" style="margin:0;border:0;border-bottom:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">内置模块</div></div>${builtins.map(componentCard).join("")}</div>
    <div class="set-card headless" style="margin:0;border:0;border-radius:0"><div class="set-card-head"><div class="t">组件 UI</div></div>
    <div class="set-section-title">沉浸歌词</div>
    ${immersiveRows()}
    <div class="set-section-title">耳机线控</div>
    ${headsetRows()}
    <div class="set-section-title">侧边栏</div>
    ${sidebarItemRows()}
    <div class="set-section-title">排序与状态栏</div>
    ${sortPriorityRows()}
    ${switchRow("状态栏：歌名跑马灯","显示/隐藏状态栏歌名","status.showTitle",settings!.showTitle)}
    ${switchRow("状态栏：歌词","显示/隐藏状态栏歌词悬浮窗按钮","status.showLyrics",settings!.showLyricsButton)}${isLinux ? `<div class="set-row"><div><div class="label">Linux 支持</div><div class="hint">当前 Linux 不支持桌面歌词悬浮窗，请等后续完善。状态栏按钮仍可显示，但不会创建悬浮窗。</div></div></div>` : ""}
    ${switchRow("状态栏：缓冲","显示/隐藏状态栏缓冲框","status.showBuffer",settings!.showBuffer)}
    ${switchRow("状态栏：喜欢","显示/隐藏状态栏喜欢按钮","status.showLike",settings!.showLike)}
    ${switchRow("状态栏：收藏","显示/隐藏状态栏收藏到歌单按钮","status.showFavorite",settings!.showFavorite)}
    ${switchRow("状态栏：播放模式","显示/隐藏状态栏循环模式按钮","status.showMode",settings!.showMode)}
    ${switchRow("状态栏：上一首/播放/下一首","显示/隐藏状态栏导航按钮","status.showNavigation",settings!.showNavigation)}
    ${switchRow("状态栏：播放队列","显示/隐藏状态栏队列按钮","status.showQueue",settings!.showQueue)}
    <details class="lyrics-details" ${lyricsDetailsOpen ? "open" : ""}><summary>歌词悬浮窗</summary>
      ${isLinux ? `<div class="set-row"><div><div class="label">Linux 支持</div><div class="hint">当前 Linux 不支持歌词悬浮窗，请等后续完善。</div></div></div>` : ""}
      <div class="set-section-title">开关</div>
      ${switchRow("启用歌词悬浮窗","关闭后不启动原生悬浮窗进程","lyricsOverlay.enabled",settings!.lyricsEnabled, isLinux)}
      ${switchRow("启动 VS Code 时自动打开","开启后由启动流程自动显示歌词悬浮窗；关闭则只在手动打开时显示","lyricsOverlay.startOnLaunch",settings!.lyricsStartOnLaunch, isLinux)}
      <div class="set-section-title">第一行歌词</div>
      <div class="set-row"><div><div class="label">颜色</div><div class="hint">当前歌词颜色</div></div><div class="control"><input id="lyrics-color" type="color" value="${settings!.lyricsColor}" /><button class="btn small" data-act="applyLyricsColor">确定</button></div></div>
      <div class="set-row"><div><div class="label">字号</div><div class="hint">12–96</div></div><div class="control"><input type="number" min="12" max="96" value="${settings!.lyricsSize}" data-config="lyricsOverlay.size" style="width:90px" /></div></div>
      <div class="set-row"><div><div class="label">粗细</div><div class="hint">100–900</div></div><div class="control"><input type="number" min="100" max="900" step="100" value="${settings!.lyricsWeight}" data-config="lyricsOverlay.weight" style="width:90px" /></div></div>
      <div class="set-row"><div><div class="label">字体</div><div class="hint">系统字体下拉</div></div><div class="control">${fontOptions(settings!.lyricsFont, "lyricsOverlay.font")}</div></div>
      <div class="set-section-title">窗口与位置</div>
      <div class="set-row"><div><div class="label">透明度</div><div class="hint">${settings!.lyricsOpacity}%</div></div><div class="control"><input type="range" min="10" max="100" value="${settings!.lyricsOpacity}" data-config="lyricsOverlay.opacity" style="width:200px" /></div></div>
      <div class="set-row"><div><div class="label">窗口大小</div><div class="hint">宽 × 高</div></div><div class="control"><input type="number" min="200" value="${settings!.lyricsWidth}" data-config="lyricsOverlay.width" style="width:90px" /> × <input type="number" min="60" value="${settings!.lyricsHeight}" data-config="lyricsOverlay.height" style="width:90px" /></div></div>
      ${switchRow("锁定窗口","锁定后鼠标穿透，不能拖动","lyricsOverlay.locked",settings!.lyricsLocked)}
      <div class="set-row"><div><div class="label">位置</div><div class="hint">-1 为自动；解锁后可拖动，位置会自动保存</div></div><div class="control"><input type="number" value="${settings!.lyricsX}" data-config="lyricsOverlay.x" style="width:90px" /> , <input type="number" value="${settings!.lyricsY}" data-config="lyricsOverlay.y" style="width:90px" /></div></div>
      <div class="set-section-title">边框与字体文件</div>
      <div class="set-row"><div><div class="label">边框粗细</div><div class="hint">0 为无边框，最大 8</div></div><div class="control"><input type="number" min="0" max="8" value="${settings!.lyricsBorderWidth}" data-config="lyricsOverlay.borderWidth" style="width:90px" /></div></div>
      <div class="set-row"><div><div class="label">边框颜色</div><div class="hint">悬浮面板边框</div></div><div class="control"><input id="lyrics-border-color" type="color" value="${esc(settings!.lyricsBorderColor)}" /><button class="btn small" data-act="applyLyricsBorderColor">确定</button></div></div>
      <div class="set-row"><div><div class="label">自定义字体文件</div><div class="hint">${settings!.lyricsFontFile ? esc(settings!.lyricsFontFile) : "可选 ttf / otf / ttc；字体名称需与文件内名称一致"}</div></div><div class="control"><button class="btn small" data-act="chooseFontFile">选择字体文件</button><button class="btn small" data-act="resetLyricsSettings" style="margin-left:8px">恢复默认</button></div></div>
    </details>
    <div class="shortcut-card"><div class="shortcut-title">快捷键</div><div class="shortcut-head"><span>功能说明</span><span>快捷键</span><span>全局快捷键</span></div><div class="shortcut-row"><span>播放/暂停</span><input readonly class="shortcut-input" data-shortcut="playPause" data-scope="local" value="${settings!.shortcuts?.["playPause"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="playPause" data-scope="global" value="${settings!.shortcuts?.["playPauseGlobal"] ?? ""}" /></div><div class="shortcut-row"><span>歌词悬浮窗</span><input readonly class="shortcut-input" data-shortcut="lyrics" data-scope="local" value="${settings!.shortcuts?.["lyrics"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="lyrics" data-scope="global" value="${settings!.shortcuts?.["lyricsGlobal"] ?? ""}" /></div><div class="shortcut-row"><span>上一首</span><input readonly class="shortcut-input" data-shortcut="previous" data-scope="local" value="${settings!.shortcuts?.["previous"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="previous" data-scope="global" value="${settings!.shortcuts?.["previousGlobal"] ?? ""}" /></div><div class="shortcut-row"><span>下一首</span><input readonly class="shortcut-input" data-shortcut="next" data-scope="local" value="${settings!.shortcuts?.["next"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="next" data-scope="global" value="${settings!.shortcuts?.["nextGlobal"] ?? ""}" /></div><div class="shortcut-row"><span>音量加</span><input readonly class="shortcut-input" data-shortcut="volumeUp" data-scope="local" value="${settings!.shortcuts?.["volumeUp"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="volumeUp" data-scope="global" value="${settings!.shortcuts?.["volumeUpGlobal"] ?? ""}" /></div><div class="shortcut-row"><span>音量减</span><input readonly class="shortcut-input" data-shortcut="volumeDown" data-scope="local" value="${settings!.shortcuts?.["volumeDown"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="volumeDown" data-scope="global" value="${settings!.shortcuts?.["volumeDownGlobal"] ?? ""}" /></div><div class="shortcut-row"><span>喜欢歌曲</span><input readonly class="shortcut-input" data-shortcut="like" data-scope="local" value="${settings!.shortcuts?.["like"] ?? ""}" /><input readonly class="shortcut-input" data-shortcut="like" data-scope="global" value="${settings!.shortcuts?.["likeGlobal"] ?? ""}" /></div><div class="shortcut-actions"><button class="btn small" data-act="resetShortcuts">恢复默认快捷键</button></div></div>${uis.length ? uis.map(componentCard).join("") : `<div class="empty">安装包含 component.json 的组件目录后显示在这里</div>`}</div>
  </div>`;
}

// --------------------------------------------------------------------- modal

function openLogin(): void {
  if (account) {
    send("refreshAccount");
    return;
  }
  modal = "login";
  loginMode = "qr";
  qr = null;
  qrBusy = true;
  renderModal();
  send("qrStart");
}

function closeModal(): void {
  modal = null;
  qrBusy = false;
  qr = null;
  send("qrStop");
  if (captchaTimer) {
    clearInterval(captchaTimer);
    captchaTimer = undefined;
  }
  renderModal();
}

function renderModal(): void {
  const root = qs("#modal-root");
  if (!root) return;
  if (!modal) {
    root.innerHTML = "";
    return;
  }
  const modeTabs = `<div class="login-tabs">
    <button class="tab ${loginMode === "qr" ? "active" : ""}" data-act="loginMode" data-mode="qr">扫码</button>
    <button class="tab ${loginMode === "phone" ? "active" : ""}" data-act="loginMode" data-mode="phone">手机</button>
    <button class="tab ${loginMode === "email" ? "active" : ""}" data-act="loginMode" data-mode="email">邮箱</button>
  </div>`;
  let body = "";
  if (loginMode === "qr") {
    body = `<div class="qr-box">${qr?.dataUrl ? `<img id="qr-img" src="${esc(qr.dataUrl)}" alt="登录二维码">` : `<span class="muted tiny">${qrBusy ? "正在获取二维码…" : "点击下方按钮获取二维码"}</span>`}</div>
      <div class="muted tiny" style="text-align:center" id="qr-msg">${esc(qr?.message ?? "使用网易云音乐 App 扫码登录")}</div>
      ${qr ? `<div style="text-align:center;margin-top:10px"><button class="btn small" data-act="qrStart">刷新二维码</button></div>` : `<div style="text-align:center;margin-top:10px"><button class="btn primary" data-act="qrStart">获取二维码</button></div>`}`;
  } else if (loginMode === "phone") {
    body = `<div class="field"><label>手机号</label><input id="login-phone" inputmode="tel" placeholder="中国大陆手机号" /></div>
      <div class="field"><label>验证码</label><div style="display:flex;gap:6px"><input id="login-code" inputmode="numeric" placeholder="短信验证码" /><button class="btn small" id="captcha-btn" data-act="sendCaptcha">发送验证码</button></div></div>
      <div class="field"><label>密码（可选，填写后走密码登录）</label><input id="login-password" type="password" /></div>
      <button class="btn primary" data-act="phoneLogin">登录</button>`;
  } else {
    body = `<div class="field"><label>邮箱 / 手机号</label><input id="login-email" placeholder="邮箱账号" /></div>
      <div class="field"><label>密码</label><input id="login-password-email" type="password" /></div>
      <button class="btn primary" data-act="emailLogin">登录</button>`;
  }
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">
    <button class="icon-btn modal-close" data-act="closeModal">${icon("close", 13)}</button>
    <h2>登录网易云音乐</h2>
    ${modeTabs}
    ${body}
    <div class="muted tiny" style="margin-top:10px;line-height:1.6">登录即表示同意网易云音乐用户协议。Cookie 保存在 VS Code SecretStorage，不会上传到第三方。</div>
  </div></div>`;
}

// -------------------------------------------------------------------- events

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "outputState":
      if (state) {
        state.output = msg.output;
        state.actualQuality = msg.actualQuality;
      }
      if (tab === "system") render();
      break;
    case "settingsInit":
      state = msg.state;
      settings = state.settings;
      account = state.account;
      components = state.components;
      native = state.native;
      tab = state.activeTab || "account";
      render();
      if (modal) renderModal();
      break;
    case "settings":
      settings = msg.settings;
      if (state) state.settings = msg.settings;
      if (tab === "account" || tab === "general" || tab === "system" || tab === "playback" || tab === "quality" || tab === "components") render();
      break;
    case "account":
      account = msg.account;
      if (state) state.account = account;
      if (tab === "account" || tab === "quality") render();
      break;
    case "headsetGestures":
      if (state) state.headsetGestures = msg.gestures;
      if (tab === "components") render();
      break;
    case "sidebarVisible":
      if (state) state.sidebarVisible = msg.keys;
      if (tab === "components") render();
      break;
    case "sortPriority":
      if (state) state.sortPriority = msg.keys;
      if (tab === "components") render();
      break;
    case "components":
      components = msg.items;
      native = msg.native;
      if (state) {
        state.components = components;
        state.native = native;
      }
      if (tab === "components" || tab === "system") render();
      break;
    case "engineInfo":
      native = msg.info;
      if (state) state.native = native;
      if (tab === "system") render();
      break;
    case "qr":
      qr = { dataUrl: msg.dataUrl, code: msg.code, message: msg.message };
      qrBusy = false;
      if (modal && loginMode === "qr") renderModal();
      break;
    case "loginResult":
      toast(msg.message, msg.ok ? "success" : "error");
      if (msg.ok) closeModal();
      break;
    case "openLogin":
      openLogin();
      break;
    case "switchTab":
      if (msg.tab) {
        tab = msg.tab;
        render();
      }
      break;
    case "toast":
      toast(msg.message, msg.kind);
      break;
    case "theme":
      document.body.dataset.theme = msg.kind;
      break;
  }
});

function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  const box = qs("#toasts");
  if (!box) return;
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  box.appendChild(item);
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(() => item.remove(), 4200);
}

boot();
