import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { MusicConfig } from "../config";
import type { ComponentView, NativeFormatView } from "../protocol";
import { log } from "../util/logger";

export interface AudioFormat {
  sampleRate: number;
  bits: number;
  channels: number;
  sampleFormat: string;
}

export interface ComponentManifest {
  schemaVersion?: number;
  id: string;
  name: string;
  version: string;
  kind: "native" | "ui";
  platform?: string;
  arch?: string;
  entry: string;
  sha256?: string;
  backend?: string;
  protocol?: string;
  description?: string;
  formats?: AudioFormat[];
  ui?: { entry: string; title?: string; width?: number; height?: number };
  minExtensionVersion?: string;
  homepage?: string;
}

export type ComponentStatus = "ready" | "disabled" | "invalid" | "incompatible" | "removed";

export interface ComponentRecord {
  id: string;
  name: string;
  version: string;
  kind: "native" | "ui" | "builtin";
  description?: string;
  status: ComponentStatus;
  enabled: boolean;
  removable: boolean;
  bundled: boolean;
  platform: string;
  arch: string;
  entry: string;
  dir: string;
  entryPath?: string;
  hashOk: boolean;
  reason?: string;
  backend?: string;
  formats?: AudioFormat[];
  manifest?: ComponentManifest;
}

interface BuiltinDefinition {
  id: string;
  name: string;
  description: string;
  removable: boolean;
}

export const BUILTINS: BuiltinDefinition[] = [
  {
    id: "core.ui",
    name: "核心 UI（侧边栏 + 播放器界面）",
    description: "Activity Bar 中的播放器视图，所有面板的宿主。",
    removable: false,
  },
  {
    id: "core.account",
    name: "登录与账户",
    description: "扫码 / 验证码 / 密码登录与账户信息，可禁用。",
    removable: false,
  },
  {
    id: "core.player",
    name: "播放器（WebAudio 兜底）",
    description: "Chromium WebAudio 播放路径；禁用后只允许原生引擎输出。",
    removable: false,
  },
  {
    id: "core.downloader",
    name: "下载器",
    description: "在线下载、缓存与文件管理，可禁用。",
    removable: false,
  },
  {
    id: "core.manager",
    name: "组件管理器",
    description: "组件安装、启停、卸载与完整性校验。",
    removable: false,
  },
];

const ENABLED_KEY = "neteaseMusic.components.enabled.v1";
const REMOVED_KEY = "neteaseMusic.components.removed.v1";
const NATIVE_ID = "native-audio-output";

export function sha256File(file: string): Promise<string> {
  return fs.readFile(file).then((buf) => createHash("sha256").update(buf).digest("hex"));
}

export class ComponentStore implements vscode.Disposable {
  private records: ComponentRecord[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly enabledMap: Record<string, boolean>;
  private readonly removedSet: Set<string>;
  private scanPromise?: Promise<ComponentRecord[]>;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly getConfig: () => MusicConfig,
  ) {
    this.enabledMap = { ...(ctx.globalState.get<Record<string, boolean>>(ENABLED_KEY) ?? {}) };
    this.removedSet = new Set(ctx.globalState.get<string[]>(REMOVED_KEY) ?? []);
  }

  get rootDir(): string {
    return this.getConfig().components.dir || path.join(this.ctx.globalStorageUri.fsPath, "components");
  }

  get bundledDir(): string {
    return path.join(this.ctx.extensionUri.fsPath, "components", `${process.platform}-${process.arch}`);
  }

  get platform(): string {
    return process.platform;
  }

  get arch(): string {
    return process.arch;
  }

  isBuiltinEnabled(id: string): boolean {
    return this.enabledMap[id] !== false;
  }

  async setBuiltinEnabled(id: string, enabled: boolean): Promise<void> {
    if (!BUILTINS.some((b) => b.id === id)) throw new Error(`未知内置模块：${id}`);
    this.enabledMap[id] = enabled;
    await this.ctx.globalState.update(ENABLED_KEY, this.enabledMap);
    this.rescan();
  }

  async list(force = false): Promise<ComponentRecord[]> {
    if (!force && this.records.length) return this.records;
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scan().finally(() => {
      this.scanPromise = undefined;
    });
    return this.scanPromise;
  }

  async rescan(): Promise<ComponentRecord[]> {
    this.records = [];
    this.scanPromise = undefined;
    const list = await this.list(true);
    this.emitter.fire();
    return list;
  }

  private async scan(): Promise<ComponentRecord[]> {
    const records: ComponentRecord[] = BUILTINS.map((b) => ({
      id: b.id,
      name: b.name,
      version: this.ctx.extension.packageJSON.version ?? "0.0.0",
      kind: "builtin",
      description: b.description,
      status: this.isBuiltinEnabled(b.id) ? "ready" : "disabled",
      enabled: this.isBuiltinEnabled(b.id),
      removable: b.removable,
      bundled: true,
      platform: "any",
      arch: "any",
      entry: "",
      dir: "",
      hashOk: true,
    }));

    const seen = new Set(records.map((r) => r.id));
    for (const record of await this.scanDirectory(this.rootDir, false)) {
      if (!seen.has(record.id)) {
        records.push(record);
        seen.add(record.id);
      }
    }
    // The bundled layout is flat: components/<platform>-<arch>/component.json
    // (not one subdirectory per component). Older releases assumed a nested
    // directory and therefore never discovered the bundled native engine.
    const bundledManifest = await this.readManifest(this.bundledDir);
    if (bundledManifest && !this.removedSet.has(bundledManifest.id)) {
      try {
        const record = await this.describe(this.bundledDir, bundledManifest, true);
        if (record && !seen.has(record.id)) {
          records.push(record);
          seen.add(record.id);
        }
      } catch (err) {
        log.warn(`failed to inspect bundled component ${bundledManifest.id}`, String(err));
      }
    } else {
      for (const record of await this.scanDirectory(this.bundledDir, true)) {
        if (this.removedSet.has(record.id)) continue;
        if (!seen.has(record.id)) {
          records.push(record);
          seen.add(record.id);
        }
      }
    }
    this.records = records;
    return records;
  }

  private async scanDirectory(dir: string, bundled: boolean): Promise<ComponentRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: ComponentRecord[] = [];
    for (const name of entries) {
      const componentDir = path.join(dir, name);
      try {
        const stat = await fs.stat(componentDir);
        if (!stat.isDirectory()) continue;
        const manifest = await this.readManifest(componentDir);
        if (!manifest) continue;
        const record = await this.describe(componentDir, manifest, bundled);
        if (record) out.push(record);
      } catch (err) {
        log.warn(`failed to inspect component ${name}`, String(err));
      }
    }
    return out;
  }

  private async readManifest(dir: string): Promise<ComponentManifest | null> {
    const file = path.join(dir, "component.json");
    try {
      const text = await fs.readFile(file, "utf8");
      const manifest = JSON.parse(text) as ComponentManifest;
      if (!manifest.id || !manifest.name || !manifest.version || !manifest.kind || !manifest.entry) {
        log.warn(`invalid component manifest in ${dir}`);
        return null;
      }
      return manifest;
    } catch {
      return null;
    }
  }

  private async describe(
    dir: string,
    manifest: ComponentManifest,
    bundled: boolean,
  ): Promise<ComponentRecord | null> {
    const platform = manifest.platform ?? "any";
    const arch = manifest.arch ?? "any";
    const compatible =
      (platform === "any" || platform === process.platform) && (arch === "any" || arch === process.arch);
    const entryPath = path.join(dir, manifest.entry);
    const enabled = this.enabledMap[manifest.id] === true;
    const base: ComponentRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      description: manifest.description,
      status: "disabled",
      enabled,
      removable: true,
      bundled,
      platform,
      arch,
      entry: manifest.entry,
      dir,
      entryPath,
      hashOk: true,
      backend: manifest.backend,
      formats: manifest.formats,
      manifest,
    };

    if (!compatible) {
      base.status = "incompatible";
      base.reason = `该组件面向 ${platform}/${arch}，当前为 ${process.platform}/${process.arch}`;
      return base;
    }

    let exists = true;
    try {
      await fs.access(entryPath);
    } catch {
      exists = false;
    }
    if (!exists) {
      base.status = "invalid";
      base.reason = `入口文件不存在：${manifest.entry}`;
      return base;
    }
    const hashOk = await this.checkHash(entryPath, manifest.sha256);
    base.hashOk = hashOk;
    if (!hashOk) {
      base.status = "invalid";
      base.reason = "SHA-256 与清单不一致，组件可能已损坏或被替换";
      return base;
    }
    if (manifest.id === NATIVE_ID) {
      const override = this.getConfig().components.nativeEnginePath.trim();
      if (override) {
        try {
          const st = await fs.stat(override);
          if (!st.isFile()) throw new Error("not a file");
          const ok = await this.checkHash(override, manifest.sha256);
          base.entryPath = override;
          base.hashOk = ok;
          if (!ok) {
            base.status = "invalid";
            base.reason = "自定义路径的二进制 SHA-256 与清单不一致";
            return base;
          }
        } catch {
          base.status = "invalid";
          base.reason = `自定义路径失效：${override}`;
          return base;
        }
      }
    }
    base.status = enabled ? "ready" : "disabled";
    return base;
  }

  private async checkHash(file: string, expected?: string): Promise<boolean> {
    if (!this.getConfig().components.verifyHash) return true;
    if (!expected) return true;
    try {
      return (await sha256File(file)) === expected.toLowerCase();
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<ComponentRecord | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }

  async nativeRecord(): Promise<ComponentRecord | undefined> {
    return this.get(NATIVE_ID);
  }

  async isEnabled(id: string): Promise<boolean> {
    const record = await this.get(id);
    return Boolean(record?.enabled && record.status === "ready");
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`组件不存在：${id}`);
    if (record.kind === "builtin") {
      await this.setBuiltinEnabled(id, enabled);
      return;
    }
    this.enabledMap[id] = enabled;
    await this.ctx.globalState.update(ENABLED_KEY, this.enabledMap);
    await this.rescan();
  }

  async installFromDirectory(sourceDir: string): Promise<ComponentRecord> {
    const manifest = await this.readManifest(sourceDir);
    if (!manifest) throw new Error("所选目录缺少有效的 component.json");
    if (manifest.platform && manifest.platform !== "any" && manifest.platform !== process.platform) {
      throw new Error(`组件面向 ${manifest.platform}/${manifest.arch}，当前平台为 ${process.platform}/${process.arch}`);
    }
    if (manifest.arch && manifest.arch !== "any" && manifest.arch !== process.arch) {
      throw new Error(`组件面向 ${manifest.platform}/${manifest.arch}，当前平台为 ${process.platform}/${process.arch}`);
    }
    await fs.mkdir(this.rootDir, { recursive: true });
    const target = path.join(this.rootDir, `${manifest.id}-${manifest.version}`);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(sourceDir, target, { recursive: true });
    const copiedManifestPath = path.join(target, "component.json");
    const copied = (await this.readManifest(target)) ?? manifest;
    const entryPath = path.join(target, copied.entry);
    const stat = await fs.stat(entryPath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`组件入口文件不存在：${copied.entry}`);
    const hash = await sha256File(entryPath);
    if (copied.sha256 && copied.sha256.toLowerCase() !== hash) {
      await fs.rm(target, { recursive: true, force: true });
      throw new Error("组件二进制 SHA-256 与清单不一致，已拒绝安装");
    }
    copied.sha256 = hash;
    await fs.writeFile(copiedManifestPath, JSON.stringify(copied, null, 2));
    this.removedSet.delete(copied.id);
    await this.ctx.globalState.update(REMOVED_KEY, [...this.removedSet]);
    this.enabledMap[copied.id] = true;
    await this.ctx.globalState.update(ENABLED_KEY, this.enabledMap);
    const list = await this.rescan();
    const record = list.find((r) => r.id === copied.id);
    if (!record) throw new Error("组件安装后无法识别");
    log.info("component installed", { id: record.id, version: record.version, dir: target });
    return record;
  }

  /**
   * Make sure the native engine is installed and enabled. Order:
   * 1. already ready → no-op;
   * 2. a bundled copy exists → re-enable it;
   * 3. otherwise download the platform zip from `components.downloadUrl`
   *    and install it into the component store.
   */
  async ensureNative(): Promise<{ changed: boolean; message: string }> {
    const existing = await this.nativeRecord();
    if (existing && existing.status === "ready") {
      return { changed: false, message: "原生引擎已就绪" };
    }
    if (existing && existing.bundled && existing.status === "disabled") {
      this.enabledMap[NATIVE_ID] = true;
      await this.ctx.globalState.update(ENABLED_KEY, this.enabledMap);
      await this.rescan();
      const record = await this.nativeRecord();
      if (record?.status === "ready") {
        return { changed: true, message: `已启用随包附带的原生引擎 ${record.version}` };
      }
    }
    const url = this.getConfig().components.downloadUrl.trim();
    if (!url) {
      return {
        changed: false,
        message: existing ? "原生引擎当前不可用（未配置自动下载地址）" : "原生引擎未安装（未配置 components.downloadUrl 下载地址）",
      };
    }
    // Remove a broken store copy before reinstalling.
    if (existing && !existing.bundled && existing.dir) {
      await fs.rm(existing.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    const record = await this.downloadAndInstall(url);
    return { changed: true, message: `已自动下载并启用原生引擎 ${record.version}` };
  }

  private async downloadAndInstall(url: string): Promise<ComponentRecord> {
    const { unzipToDir } = await import("../util/unzip");
    const tmp = path.join(this.ctx.globalStorageUri.fsPath, "components-download");
    const zipPath = path.join(tmp, "naoe.zip");
    await fs.mkdir(tmp, { recursive: true });
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        log.info("downloading native engine", { url, attempt });
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > 64 * 1024 * 1024) throw new Error("下载文件过大，已拒绝");
        await fs.writeFile(zipPath, data);
        const extractDir = path.join(tmp, "extracted");
        await fs.rm(extractDir, { recursive: true, force: true });
        await fs.mkdir(extractDir, { recursive: true });
        const count = await unzipToDir(zipPath, extractDir);
        if (!count) throw new Error("zip 内容为空");
        // Flatten: the zip may contain a single top-level folder.
        let componentDir = extractDir;
        let entries = await fs.readdir(extractDir);
        while (entries.length === 1 && (await fs.stat(path.join(extractDir, entries[0]))).isDirectory()) {
          componentDir = path.join(componentDir, entries[0]);
          entries = await fs.readdir(componentDir);
        }
        const record = await this.installFromDirectory(componentDir);
        log.info("native engine auto-installed", { version: record.version, url });
        return record;
      } catch (err) {
        lastError = err;
        log.warn(`native engine download attempt ${attempt} failed`, String(err));
      }
    }
    throw new Error(`原生引擎自动下载失败：${(lastError as Error).message ?? lastError}`);
  }

  /** Restore the bundled native engine after a previous "uninstall". */
  async restoreBundledNative(): Promise<ComponentRecord> {
    this.removedSet.delete(NATIVE_ID);
    await this.ctx.globalState.update(REMOVED_KEY, [...this.removedSet]);
    this.enabledMap[NATIVE_ID] = true;
    await this.ctx.globalState.update(ENABLED_KEY, this.enabledMap);
    await this.rescan();
    const record = await this.nativeRecord();
    if (!record) throw new Error("随包原生引擎不存在，请确认安装的是对应平台的扩展包");
    if (record.status !== "ready") throw new Error(`随包原生引擎不可用：${record.reason ?? record.status}`);
    return record;
  }

  async remove(id: string): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`组件不存在：${id}`);
    if (record.kind === "builtin") throw new Error("内置模块不可卸载，只能禁用");
    if (record.bundled) {
      this.removedSet.add(id);
      await this.ctx.globalState.update(REMOVED_KEY, [...this.removedSet]);
    } else {
      await fs.rm(record.dir, { recursive: true, force: true });
    }
    delete this.enabledMap[id];
    await this.ctx.globalState.update(ENABLED_KEY, this.enabledMap);
    if (id === NATIVE_ID) {
      await vscode.workspace.getConfiguration("neteaseMusic").update("components.nativeEnginePath", "", vscode.ConfigurationTarget.Global);
    }
    await this.rescan();
    log.info("component removed", { id });
  }

  async verify(id: string): Promise<{ ok: boolean; message: string }> {
    const record = await this.get(id);
    if (!record) return { ok: false, message: `组件不存在：${id}` };
    if (record.kind === "builtin") return { ok: true, message: "内置模块无需校验" };
    if (!record.entryPath) return { ok: false, message: "组件入口未解析" };
    const expected = record.manifest?.sha256;
    if (!expected) return { ok: true, message: "清单未声明 SHA-256，已跳过校验" };
    const actual = await sha256File(record.entryPath).catch(() => "");
    if (!actual) return { ok: false, message: "无法读取入口文件" };
    const ok = actual.toLowerCase() === expected.toLowerCase();
    return {
      ok,
      message: ok ? `校验通过（sha256 ${actual.slice(0, 16)}…）` : "校验失败：二进制与清单不一致",
    };
  }

  async locate(id: string, filePath: string): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`组件不存在：${id}`);
    if (record.kind !== "native") throw new Error("只有原生组件支持重新定位二进制");
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("请选择一个二进制文件");
    if (record.manifest?.sha256) {
      const actual = await sha256File(filePath);
      if (actual.toLowerCase() !== record.manifest.sha256.toLowerCase()) {
        throw new Error("所选文件的 SHA-256 与组件清单不一致");
      }
    }
    await vscode.workspace
      .getConfiguration("neteaseMusic")
      .update("components.nativeEnginePath", filePath, vscode.ConfigurationTarget.Global);
    await this.rescan();
  }

  toView(record: ComponentRecord): ComponentView {
    return {
      id: record.id,
      removable: record.removable,
      name: record.name,
      version: record.version,
      kind: record.kind,
      description: record.description,
      status: record.status,
      enabled: record.enabled,
      bundled: record.bundled,
      platform: record.platform,
      arch: record.arch,
      entry: record.entry,
      dir: record.dir,
      hashOk: record.hashOk,
      reason: record.reason,
      formats: (record.formats ?? []).map<NativeFormatView>((f) => ({
        sampleRate: f.sampleRate,
        bits: f.bits,
        channels: f.channels,
        sampleFormat: f.sampleFormat,
      })),
      backend: record.backend,
    };
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
