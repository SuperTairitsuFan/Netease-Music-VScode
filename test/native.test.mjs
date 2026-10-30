import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformDir = `${process.platform}-${process.arch}`;
const binary = path.join(
  root,
  "components",
  platformDir,
  process.platform === "win32" ? "native-audio-output.exe" : "native-audio-output",
);

function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
}

test("native engine --probe reports JSON", { skip: !fs.existsSync(binary) }, async () => {
  const child = spawn(binary, ["--probe"], {
    env: { ...process.env, NAOE_BACKEND: "null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk.toString("utf8")));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  const probe = JSON.parse(out.trim());
  assert.equal(probe.ok, true);
  assert.equal(probe.protocol, "1");
  assert.ok(Array.isArray(probe.devices));
});

test("native engine --serve round-trips PCM", { skip: !fs.existsSync(binary) }, async () => {
  const child = spawn(binary, ["--serve"], {
    env: { ...process.env, NAOE_BACKEND: "null" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) events.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write(
    frame(1, {
      cmd: "configure",
      device: "null",
      sampleRate: 48000,
      channels: 2,
      bits: 32,
      sampleFormat: "f32le",
      exclusive: false,
      bufferMs: 10,
      volume: 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  child.stdin.write(frame(1, { cmd: "start" }));

  const frames = 4800;
  const pcm = Buffer.alloc(frames * 2 * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.2;
    pcm.writeFloatLE(value, i * 8);
    pcm.writeFloatLE(value, i * 8 + 4);
  }
  child.stdin.write(frame(2, pcm));
  child.stdin.write(frame(3, Buffer.alloc(0)));

  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  const names = events.map((event) => event.event);
  for (const expected of ["ready", "configured", "started", "drained"]) {
    assert.ok(names.includes(expected), `缺少事件 ${expected}：${names.join(",")}`);
  }
  assert.ok(names.indexOf("ready") < names.indexOf("configured"));
  assert.ok(names.indexOf("configured") < names.indexOf("started"));
  assert.ok(names.indexOf("started") < names.indexOf("drained"));
  const configured = events.find((event) => event.event === "configured");
  assert.equal(configured.format.sampleRate, 48000);
  assert.equal(configured.format.channels, 2);
  assert.ok(configured.bufferFrames > 0);
});
