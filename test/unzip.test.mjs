import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Bundle the TypeScript unzip util once for the whole run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "naoe-unzip-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(root, "src/util/unzip.ts")],
  bundle: true,
  outfile: path.join(tmp, "unzip.cjs"),
  platform: "node",
  format: "cjs",
});
const { unzipToDir } = await import(pathToFileURL(path.join(tmp, "unzip.cjs")).href);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer so the tests do not depend on Python or a zip CLI. */
function makeZip(zipPath, entries, deflate = false) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const method = deflate ? 8 : 0;
    const payload = deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuffer, payload);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + payload.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...parts, ...central, eocd]));
  return zipPath;
}

test("unzip: stored entries round-trip", async () => {
  const zipPath = path.join(tmp, "stored.zip");
  makeZip(zipPath, [
    { name: "component.json", data: '{"id":"x","version":"1.0.0"}' },
    { name: "bin/naoe", data: Buffer.from([0, 1, ...Buffer.from("binary"), 0xff]) },
    { name: "a/b.txt", data: "nested" },
  ]);
  const dest = path.join(tmp, "out-stored");
  const count = await unzipToDir(zipPath, dest);
  assert.equal(count, 3);
  assert.equal(fs.readFileSync(path.join(dest, "component.json"), "utf8"), '{"id":"x","version":"1.0.0"}');
  assert.deepEqual(fs.readFileSync(path.join(dest, "bin", "naoe")), Buffer.from([0, 1, ...Buffer.from("binary"), 0xff]));
  assert.equal(fs.readFileSync(path.join(dest, "a", "b.txt"), "utf8"), "nested");
});

test("unzip: deflate entries round-trip", async () => {
  const zipPath = path.join(tmp, "deflated.zip");
  const payload = "hello deflate world ".repeat(200);
  makeZip(zipPath, [{ name: "file.txt", data: payload }], true);
  const dest = path.join(tmp, "out-deflated");
  await unzipToDir(zipPath, dest);
  assert.equal(fs.readFileSync(path.join(dest, "file.txt"), "utf8"), payload);
});

test("unzip: rejects path traversal", async () => {
  const zipPath = path.join(tmp, "evil.zip");
  const buf = Buffer.alloc(30 + 9 + 4);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(9, 26); // name length "../evil.txt"
  buf.write("../../evil.txt", 30);
  buf.writeUInt32LE(0xdeadbeef, 39);
  const central = Buffer.alloc(46 + 12);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(12, 28);
  central.writeUInt32LE(0, 42);
  central.write("../../evil.txt", 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(buf.length, 16);
  fs.writeFileSync(zipPath, Buffer.concat([buf, central, eocd]));
  const dest = path.join(tmp, "out-evil");
  await assert.rejects(() => unzipToDir(zipPath, dest), /不安全路径/);
});

test("unzip: extracts the build-native component zips (auto-download payload)", async () => {
  const platform = `${process.platform}-${process.arch}`;
  const zipPath = path.join(root, "components-zip", `netease-native-audio-output-${platform}.zip`);
  if (!fs.existsSync(zipPath)) return; // build-native not run
  const dest = path.join(tmp, `out-${platform}`);
  await unzipToDir(zipPath, dest);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, "component.json"), "utf8"));
  assert.equal(manifest.id, "native-audio-output");
  const entry = path.join(dest, manifest.entry);
  assert.ok(fs.existsSync(entry), `入口文件缺失：${manifest.entry}`);
  const hash = createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
  assert.equal(hash, manifest.sha256, "zip 内二进制与清单 sha256 不一致");
});
