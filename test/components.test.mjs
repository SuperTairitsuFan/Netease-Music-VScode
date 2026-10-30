import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const target of ["linux-x64", "linux-arm64", "win32-x64"]) {
  const dir = path.join(root, "components", target);
  const manifestPath = path.join(dir, "component.json");
  test(`component manifest ${target}`, { skip: !fs.existsSync(manifestPath) }, () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.id, "native-audio-output");
    assert.equal(manifest.kind, "native");
    assert.ok(manifest.entry);
    const entry = path.join(dir, manifest.entry);
    assert.ok(fs.existsSync(entry), `入口不存在：${entry}`);
    const hash = createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
    assert.equal(hash, manifest.sha256);
    assert.ok(Array.isArray(manifest.formats) && manifest.formats.length > 0);
    for (const format of manifest.formats) {
      assert.ok(format.sampleRate >= 44100);
      assert.ok([16, 24, 32].includes(format.bits));
      assert.ok(["s16le", "s24le", "s32le"].includes(format.sampleFormat));
    }
  });
}
