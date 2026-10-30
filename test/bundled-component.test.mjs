import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = `${process.platform}-${process.arch}`;
const bundled = path.join(root, "components", target);

if (!fs.existsSync(path.join(bundled, "component.json"))) {
  test.skip(`no bundled component for ${target}`, () => {});
} else {
  test("component store discovers the flat bundled native layout", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netease-components-"));
    const stub = path.join(tmp, "vscode-stub.cjs");
    fs.writeFileSync(
      stub,
      `class Emitter {
        constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
        fire(value) { for (const listener of [...this.listeners]) listener(value); }
        dispose() { this.listeners.clear(); }
      }
      module.exports = {
        EventEmitter: Emitter,
        ConfigurationTarget: { Global: 1 },
        workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => undefined }) },
      };`,
    );
    const { build } = await import("esbuild");
    const outfile = path.join(tmp, "components.cjs");
    await build({
      entryPoints: [path.join(root, "src/player/components.ts")],
      bundle: true,
      outfile,
      platform: "node",
      format: "cjs",
      alias: { vscode: stub },
    });
    const { ComponentStore } = await import(pathToFileURL(outfile).href);
    const state = new Map();
    const storage = path.join(tmp, "globalStorage");
    fs.mkdirSync(storage, { recursive: true });
    const ctx = {
      extensionUri: { fsPath: root },
      globalStorageUri: { fsPath: storage },
      globalState: {
        get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
        update: async (key, value) => state.set(key, value),
      },
      extension: { packageJSON: { version: "0.2.1" } },
    };
    const config = {
      components: {
        dir: "",
        nativeEnginePath: "",
        verifyHash: true,
        autoDownload: true,
        downloadUrl: "",
      },
    };
    const store = new ComponentStore(ctx, () => config);
    const list = await store.list(true);
    const native = list.find((record) => record.id === "native-audio-output");
    assert.ok(native, "bundled native component was not discovered");
    assert.equal(native.bundled, true);
    assert.equal(native.status, "disabled");

    const result = await store.ensureNative();
    assert.equal(result.changed, true);
    const enabled = await store.nativeRecord();
    assert.equal(enabled?.status, "ready");
    assert.equal(enabled?.enabled, true);
    assert.equal(state.get("neteaseMusic.components.enabled.v1")?.["native-audio-output"], true);

    await store.remove("native-audio-output");
    assert.equal(await store.nativeRecord(), undefined);
    const restored = await store.restoreBundledNative();
    assert.equal(restored.status, "ready");
    assert.equal(restored.enabled, true);
    assert.equal(state.get("neteaseMusic.components.removed.v1")?.includes("native-audio-output"), false);

    store.dispose();
  });
}
