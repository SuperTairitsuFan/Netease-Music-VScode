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
let captchaTimer: ReturnType<typeof setInterval> | undefined;

const TABS: Array<{ key: string; label: string; icon: string }> = [
  { key: "account", label: "账号", icon: "account" },
  { key: "general", label: "常规", icon: "settings" },
  { key: "system", label: "系统", icon: "device" },
  { key: "playback", label: "播放", icon: "play" },
  { key: "quality", label: "音质与下载", icon: "verified" },
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
    case "selectDevice":
      send("selectDevice");
      break;
    case "installComponent":
      send("installComponent");
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

function onChange(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement | null;
  if (!target || !target.dataset.config) return;
  let value: unknown = target.value;
  if (target instanceof HTMLInputElement && target.type === "checkbox") value = target.checked;
  if (target instanceof HTMLInputElement && target.type === "number") value = Number(target.value);
  if (target instanceof HTMLInputElement && target.type === "range") value = Number(target.value);
  if (["output.bufferMs", "playback.volume", "download.concurrent", "cache.maxSizeMB"].includes(target.dataset.config)) {
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
  if (!account) {
    return `<div class="set-card"><div class="set-card-head"><div class="t">账号</div><div class="d">登录后可同步歌单、收藏与会员音质</div></div>
      <div class="account-card">
        <div style="width:72px;height:72px;border-radius:50%;background:var(--hover);display:flex;align-items:center;justify-content:center;color:var(--muted)">${icon("login", 28)}</div>
        <div><div class="name">未登录</div><div class="id">使用网易云音乐 App 扫码，或手机验证码 / 密码登录</div></div>
        <div class="actions"><button class="btn primary" data-act="login">${icon("login", 12)} 登录</button></div>
      </div>
    </div>`;
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
    <div class="set-row"><div><div class="label">会员音质</div><div class="hint">SVIP 可使用高清臻音 / 沉浸环绕声 / 超清母带；实际可用档位以服务端权益为准。</div></div><div class="control">${accountBadge()}</div></div>
  </div>`;
}

function switchRow(label: string, hint: string, key: string, value: boolean): string {
  return `<div class="set-row"><div><div class="label">${esc(label)}</div><div class="hint">${esc(hint)}</div></div><div class="control"><button class="switch ${value ? "on" : ""}" data-act="toggleConfig" data-key="${key}" data-value="${value}" title="切换"></button></div></div>`;
}

function selectRow(
  label: string,
  hint: string,
  key: string,
  value: string,
  options: Array<{ value: string; label: string }>,
): string {
  return `<div class="set-row"><div><div class="label">${esc(label)}</div><div class="hint">${esc(hint)}</div></div><div class="control"><select data-config="${key}">${options
    .map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""}>${esc(option.label)}</option>`)
    .join("")}</select></div></div>`;
}

function renderGeneral(): string {
  const cfg = settings!;
  return `<div class="set-card"><div class="set-card-head"><div class="t">常规</div><div class="d">启动行为与外观</div></div>
    ${switchRow("启动时打开主界面", "关闭后只在侧边栏中显示，点击状态栏或命令再打开主界面", "ui.autoOpen", cfg.autoOpen)}
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

function renderSystem(): string {
  const cfg = settings!;
  const devices = native.devices ?? [];
  const formatOptions = ["auto", "44100", "48000", "88200", "96000", "176400", "192000", "352800", "384000"];
  const bitOptions = ["auto", "16", "24", "32"];
  const sampleFormats = ["auto", "s16le", "s24le", "s32le", "f32le"];
  return `<div class="set-card"><div class="set-card-head"><div class="t">音频输出</div><div class="d">原生引擎由独立组件提供，可启用 / 禁用 / 卸载</div></div>
    ${selectRow("输出模式", "auto 优先 WebAudio；native 强制原生，失败不回退", "output.mode", cfg.outputMode, [
      { value: "auto", label: "自动（优先 WebAudio）" },
      { value: "webaudio", label: "仅 WebAudio" },
      { value: "native", label: "仅原生引擎" },
    ])}
    <div class="set-row"><div><div class="label">输出设备</div><div class="hint">${esc(native.devices?.find((device) => device.id === cfg.device)?.name ?? (cfg.device || "系统默认设备"))}</div></div><div class="control"><button class="btn small" data-act="probeAudio">${icon("pulse", 11)} 探测</button><button class="btn small" data-act="selectDevice">${icon("device", 11)} 选择设备</button></div></div>
    ${switchRow("独占模式", "Windows WASAPI Exclusive / Linux ALSA hw: 直连，绕过系统混音器", "output.exclusive", cfg.exclusive)}
    ${selectRow("采样率", "auto 跟随音源；手动值必须与音源一致（引擎不做重采样）", "output.sampleRate", cfg.sampleRate, formatOptions.map((value) => ({ value, label: value === "auto" ? "auto（跟随音源）" : `${Number(value) / 1000} kHz` })))}
    ${selectRow("位深", "32 bit 是否可用取决于 USB DAC 与驱动", "output.bitDepth", cfg.bitDepth, bitOptions.map((value) => ({ value, label: value === "auto" ? "auto" : `${value} bit` })))}
    ${selectRow("样本格式", "设备端格式；引擎输入永远是 float32 PCM", "output.sampleFormat", cfg.sampleFormat, sampleFormats.map((value) => ({ value, label: value === "auto" ? "auto" : value })))}
    <div class="set-row"><div><div class="label">缓冲区</div><div class="hint">${cfg.bufferMs} ms · 独占模式建议 3–20 ms</div></div><div class="control"><input type="number" min="3" max="500" step="1" value="${cfg.bufferMs}" data-config="output.bufferMs" style="width:90px" /></div></div>
    <div class="set-row"><div><div class="label">原生引擎</div><div class="hint">${native.ready ? `就绪 · ${esc(native.backend ?? "")}${native.version ? ` · v${esc(native.version)}` : ""}` : esc(native.reason ?? "未安装或未启用")}<br>${esc(native.path ?? "")}</div></div><div class="control"><button class="btn small" data-act="enableComponent" data-id="native-audio-output">启用</button><button class="btn small" data-act="installComponent">安装组件</button></div></div>
    ${devices.length ? `<div class="set-row stack"><div><div class="label">已探测设备</div><div class="hint">设备支持的实际格式</div></div><div class="control" style="display:block"><div class="device-list">${devices
      .map(
        (device) => `<div class="device"><span class="status-dot ${device.isDefault ? "ready" : "disabled"}"></span><span>${esc(device.name)}</span><span class="muted tiny">${esc(device.backend)}</span><span class="formats">${device.formats.map((format) => `${format.sampleRate / 1000}k/${format.bits}bit`).join(" · ")}</span></div>`,
      )
      .join("")}</div></div></div>` : ""}
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">输出链路</div><div class="d">当前实际路径</div></div>
    <div class="set-row stack"><div class="control" style="display:block"><div class="chain">
      <div class="node active">网易云流 · ${esc(QUALITY_TEXT_FALLBACK(settings?.quality ?? ""))}</div>
      <div class="arrow">▼</div>
      <div class="node">解码 · ${native.ready ? "Webview 解码 → PCM" : "Chromium 解码"}</div>
      <div class="arrow">▼</div>
      <div class="node ${native.ready ? "active" : ""}">${native.ready ? `Native Engine · ${esc(native.backend ?? "")}` : "WebAudio（共享 48 kHz）"}</div>
      <div class="arrow">▼</div>
      <div class="node">物理 DAC / USB 耳机</div>
    </div></div></div>
  </div>`;
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
    <div class="set-row"><div><div class="label">实际音质</div><div class="hint">服务端可能按版权与会员权益降级；状态栏显示实际返回的档位。</div></div></div>
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">音质下载设置</div><div class="d">下载任务使用的音质档位</div></div>
    <div class="quality-list">${downloadRows}</div>
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">目录与文件</div><div class="d">下载 / 缓存 / 本地音乐目录</div></div>
    <div class="set-row"><div><div class="label">下载目录</div><div class="hint">${esc(cfg.downloadDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="download.dir">${icon("folder", 11)} 更改目录</button><button class="btn small" data-act="openDownloadDir">打开</button></div></div>
    <div class="set-row"><div><div class="label">封面保存目录</div><div class="hint">${esc(cfg.coverDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="cover.dir">${icon("folder", 11)} 更改目录</button></div></div>
    <div class="set-row"><div><div class="label">封面文件名</div><div class="hint">可用变量：{name}（曲名）、{artist}（歌手）</div></div><div class="control"><input type="text" value="${esc(cfg.coverFilenameTemplate)}" data-config="cover.filenameTemplate" /></div></div>
    <div class="set-row"><div><div class="label">缓存目录</div><div class="hint">${esc(cfg.cacheDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="cache.dir">${icon("folder", 11)} 更改目录</button></div></div>
    <div class="set-row"><div><div class="label">本地音乐目录</div><div class="hint">${esc(cfg.localMusicDir)}</div></div><div class="control"><button class="btn small" data-act="chooseDir" data-key="localMusic.dir">${icon("folder", 11)} 更改目录</button></div></div>
    <div class="set-row"><div><div class="label">文件名模板</div><div class="hint">可用变量：{artist} {name} {album} {id} {quality} {ext}</div></div><div class="control"><input type="text" value="${esc(cfg.filenameTemplate)}" data-config="download.filenameTemplate" /></div></div>
    <div class="set-row"><div><div class="label">并发下载</div><div class="hint">1–4 个任务</div></div><div class="control"><input type="number" min="1" max="4" value="${cfg.downloadConcurrent}" data-config="download.concurrent" style="width:80px" /></div></div>
    ${switchRow("写入 ID3 标签", "MP3 下载后写入标题、歌手、专辑与封面", "download.writeMetadata", cfg.writeMetadata)}
    ${switchRow("保存歌词", "下载时同时保存同名 .lrc 文件", "download.saveLyric", cfg.saveLyric)}
  </div>
  <div class="set-card"><div class="set-card-head"><div class="t">缓存</div><div class="d">音频缓存避免重复解析与下载</div></div>
    ${switchRow("启用音频缓存", "缓存直链与本地音频文件", "cache.enabled", cfg.cacheEnabled)}
    <div class="set-row"><div><div class="label">缓存上限</div><div class="hint">超出后按最近最少使用清理</div></div><div class="control"><input type="number" min="64" value="${cfg.cacheMaxSizeMB}" data-config="cache.maxSizeMB" style="width:100px" /> MB</div></div>
  </div>`;
}

function componentCard(item: ComponentView): string {
  const status =
    item.status === "ready" ? "就绪" : item.status === "disabled" ? "已禁用" : item.status === "invalid" ? "异常" : item.status === "removed" ? "已移除" : "不兼容";
  const actions: string[] = [];
  if (item.kind === "builtin") {
    actions.push(
      item.enabled
        ? `<button class="btn small" data-act="disableComponent" data-id="${esc(item.id)}">禁用</button>`
        : `<button class="btn small primary" data-act="enableComponent" data-id="${esc(item.id)}">启用</button>`,
    );
  } else if (item.removable) {
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

function renderComponents(): string {
  const builtins = components.filter((item) => item.kind === "builtin");
  const natives = components.filter((item) => item.kind === "native");
  const uis = components.filter((item) => item.kind === "ui");
  return `<div class="set-card"><div class="set-card-head"><div class="t">组件管理</div><div class="d">原生引擎、内置模块与第三方 UI 组件均可独立启用 / 禁用 / 卸载</div></div>
    <div class="set-row"><div><div class="label">组件目录</div><div class="hint">${esc(settings?.componentsDir ?? "")}</div></div><div class="control"><button class="btn small" data-act="refreshComponents">${icon("refresh", 11)} 刷新</button><button class="btn small primary" data-act="installComponent">${icon("plus", 11)} 安装组件</button></div></div>
    ${native.ready ? `<div class="set-row"><div><div class="label">原生音频输出</div><div class="hint">${esc(native.backend ?? "")} · ${native.devices?.length ?? 0} 个设备</div></div><div class="control"><span class="pill accent">就绪</span></div></div>` : `<div class="set-row"><div><div class="label">原生音频输出</div><div class="hint">${esc(native.reason ?? "未安装或未启用")}</div></div><div class="control"><span class="pill">未就绪</span></div></div>`}
    <div class="set-card headless" style="margin:0;border:0;border-bottom:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">原生组件</div></div>${natives.length ? natives.map(componentCard).join("") : `<div class="empty">未安装 Native Audio Output Engine<br><button class="btn small" data-act="restoreBundled" style="margin-top:8px">${icon("refresh", 11)} 恢复随包原生引擎</button></div>`}</div>
    <div class="set-card headless" style="margin:0;border:0;border-bottom:1px solid var(--border);border-radius:0"><div class="set-card-head"><div class="t">内置模块</div></div>${builtins.map(componentCard).join("")}</div>
    <div class="set-card headless" style="margin:0;border:0;border-radius:0"><div class="set-card-head"><div class="t">第三方 UI 组件</div></div>${uis.length ? uis.map(componentCard).join("") : `<div class="empty">安装包含 component.json 的组件目录后显示在这里</div>`}</div>
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
      if (tab === "general" || tab === "system" || tab === "playback" || tab === "quality") render();
      break;
    case "account":
      account = msg.account;
      if (state) state.account = account;
      if (tab === "account" || tab === "quality") render();
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
      if (modal) renderModal();
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
