import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netease-eapi-"));
const { build } = await import("esbuild");

async function bundle(entry, name) {
  const outfile = path.join(tmp, name);
  await build({ entryPoints: [path.join(root, entry)], bundle: true, outfile, platform: "node", format: "cjs" });
  return import(pathToFileURL(outfile).href);
}

const crypto = await bundle("src/api/crypto.ts", "crypto.cjs");
const normalize = await bundle("src/api/normalize.ts", "normalize.cjs");
const { createDecipheriv } = await import("node:crypto");

test("eapi: encrypts the signed payload and decrypts it", () => {
  const path = "/api/song/enhance/player/url/v1";
  const body = { ids: "[1]", level: "jymaster" };
  const encrypted = crypto.eapi(path, body);
  assert.match(encrypted, /^[0-9A-F]+$/);
  assert.equal(encrypted.length % 32, 0);
  const decipher = createDecipheriv("aes-128-ecb", crypto.cryptoInternals.EAPI_KEY, Buffer.alloc(0));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]).toString("utf8");
  const [signedPath, text, digest] = plain.split("-36cd479b6b5-");
  assert.equal(signedPath, path);
  assert.equal(text, JSON.stringify(body));
  assert.match(digest, /^[0-9a-f]{32}$/);
});

test("eapi: decrypts #14 wrapped responses", () => {
  const plain = '{"code":200,"data":[]}';
  const cipher = crypto.aesEcbEncryptHex(plain, crypto.cryptoInternals.EAPI_KEY).toUpperCase();
  assert.equal(crypto.eapiDecrypt(`#14${cipher}`), plain);
  assert.equal(crypto.eapiDecrypt(plain), plain);
});

test("normalize: privilege and commentId are mapped", () => {
  const track = normalize.normalizeTrack(
    {
      id: 1,
      name: "歌",
      ar: [{ id: 2, name: "歌手" }],
      al: { id: 3, name: "专辑", picUrl: "http://x/y.jpg" },
      dt: 180000,
    },
    { maxBrLevel: "jymaster", fee: 1 },
  );
  assert.equal(track.privilege.maxBrLevel, "jymaster");
  assert.equal(track.duration, 180000);
  const comment = normalize.normalizeComment({
    commentId: 99,
    content: "好听",
    time: 1700000000000,
    likedCount: 3,
    user: { userId: 7, nickname: "用户", avatarUrl: "" },
  });
  assert.equal(comment.id, 99);
  assert.equal(comment.user.nickname, "用户");
});

test("normalize: toplist uses cover field", () => {
  const toplist = normalize.normalizeToplist({ id: 19723756, name: "飙升榜", cover: "http://x/c.jpg" });
  assert.equal(toplist.coverImgUrl, "http://x/c.jpg");
});
