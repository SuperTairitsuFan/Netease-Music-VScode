#!/usr/bin/env node
/**
 * Cross-compiles the Native Audio Output Engine with zig and writes the
 * per-platform component directories consumed by the extension at runtime.
 *
 *   node scripts/build-native.mjs                # all targets
 *   node scripts/build-native.mjs linux-arm64    # one target
 *
 * Requirements: a zig 0.15.x toolchain. ALSA headers are vendored under
 * native/third_party/alsa, so no root install is needed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.1.0";

const TARGETS = {
  "linux-x64": {
    triple: "x86_64-linux-gnu",
    platform: "linux",
    arch: "x64",
    backend: "alsa",
    entry: "native-audio-output",
    libs: ["-ldl", "-lpthread", "-lm"],
    cflags: ["-D_POSIX_C_SOURCE=200809L", "-I", path.join(root, "native/third_party")],
  },
  "linux-arm64": {
    triple: "aarch64-linux-gnu",
    platform: "linux",
    arch: "arm64",
    backend: "alsa",
    entry: "native-audio-output",
    libs: ["-ldl", "-lpthread", "-lm"],
    cflags: ["-D_POSIX_C_SOURCE=200809L", "-I", path.join(root, "native/third_party")],
  },
  "win32-x64": {
    triple: "x86_64-windows-gnu",
    platform: "win32",
    arch: "x64",
    backend: "wasapi",
    entry: "native-audio-output.exe",
    libs: ["-lole32", "-luuid", "-loleaut32", "-lavrt", "-ladvapi32"],
    cflags: ["-I", path.join(root, "native/src"), "-I", path.join(root, "native/third_party/asio"), "-I", path.join(root, "native/third_party/dr_libs")],
  },
};

const FORMATS = [
  [44100, 16],
  [44100, 24],
  [44100, 32],
  [48000, 16],
  [48000, 24],
  [48000, 32],
  [88200, 24],
  [88200, 32],
  [96000, 16],
  [96000, 24],
  [96000, 32],
  [176400, 24],
  [176400, 32],
  [192000, 16],
  [192000, 24],
  [192000, 32],
  [352800, 32],
  [384000, 24],
  [384000, 32],
];

function findZig() {
  const candidates = [process.env.ZIG, path.join(root, "tools/zig/zig"), "/tmp/toolchain/zig/zig", "zig"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes("/") && !fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (result.status === 0) return { bin: candidate, version: result.stdout.trim() };
  }
  throw new Error("找不到 zig。请把 zig 放到 tools/zig/zig、设置 ZIG 环境变量，或加入 PATH。");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ------------------------------------------------------------ minimal zip writer
// Stored (method 0) entries only — no external `zip` binary needed, and our
// src/util/unzip.ts reads exactly this format.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(outPath, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(outPath, Buffer.concat([...locals, ...centrals, eocd]));
}

function build(targetName, zig) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`未知目标：${targetName}，可选：${Object.keys(TARGETS).join(", ")}`);
  const outDir = path.join(root, "components", targetName);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, target.entry);
  const sources = fs
    .readdirSync(path.join(root, "native/src"))
    .filter((file) => file.endsWith(".c"))
    .map((file) => path.join("native/src", file));

  const args = [
    "cc",
    "-target",
    target.triple,
    "-O2",
    "-s",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    ...target.cflags,
    "-o",
    outFile,
    ...sources,
    ...target.libs,
  ];
  console.log(`[build-native] ${targetName} (${target.triple})`);
  const result = spawnSync(zig.bin, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`编译失败：${targetName}`);
  fs.chmodSync(outFile, 0o755);

  const manifest = {
    schemaVersion: 1,
    id: "native-audio-output",
    name: "Native Audio Output Engine",
    version: VERSION,
    kind: "native",
    platform: target.platform,
    arch: target.arch,
    entry: target.entry,
    sha256: sha256(outFile),
    backend: target.backend,
    protocol: "naoe-frame-v1",
    description:
      target.platform === "win32"
        ? "WASAPI（Shared / Exclusive）原生输出，独占模式支持设备能力内的 PCM 格式。"
        : "ALSA 直连 / PipeWire 原生输出；设备为 hw: 时直连硬件，default 走系统音频服务。",
    formats: FORMATS.map(([sampleRate, bits]) => ({
      sampleRate,
      bits,
      channels: 2,
      sampleFormat: bits === 16 ? "s16le" : bits === 24 ? "s24le" : "s32le",
    })),
    minExtensionVersion: "0.1.0",
    build: { toolchain: `zig ${zig.version}`, triple: target.triple, source: "native/src" },
  };
  fs.writeFileSync(path.join(outDir, "component.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const size = fs.statSync(outFile).size;
  console.log(`[build-native] ${targetName} -> ${path.relative(root, outFile)} (${size} bytes, sha256 ${manifest.sha256.slice(0, 12)}…)`);

  // Component zip for `neteaseMusic.components.downloadUrl` auto-download.
  const zipDir = path.join(root, "components-zip");
  fs.mkdirSync(zipDir, { recursive: true });
  const zipPath = path.join(zipDir, `netease-native-audio-output-${targetName}.zip`);
  writeZip(zipPath, [
    { name: "component.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: target.entry, data: fs.readFileSync(outFile) },
  ]);
  console.log(`[build-native] ${targetName} -> ${path.relative(root, zipPath)} (${fs.statSync(zipPath).size} bytes, 自动下载用)`);
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const names = requested.length ? requested : Object.keys(TARGETS);
const zig = findZig();
console.log(`[build-native] zig ${zig.version} (${zig.bin})`);
for (const name of names) build(name, zig);
