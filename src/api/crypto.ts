import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const IV = Buffer.from("0102030405060708");
const PRESET_KEY = Buffer.from("0CoJUm6Qyw8W8jud");
const EAPI_KEY = Buffer.from("e82ckenh8dichen8");
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const RSA_MODULUS =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const RSA_EXPONENT = 0x10001n;

export function md5(input: string | Buffer): string {
  return createHash("md5").update(input).digest("hex");
}

export function randomSecretKey(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += BASE62[Math.floor(Math.random() * BASE62.length)];
  }
  return out;
}

/** AES-128-CBC / PKCS#7, base64 output — the classic weapi envelope. */
export function aesCbcEncryptBase64(plain: string, key: Buffer): string {
  const cipher = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]).toString("base64");
}

/** AES-128-ECB / PKCS#7, lowercase hex — used by eapi. */
export function aesEcbEncryptHex(plain: string, key: Buffer): string {
  const cipher = createCipheriv("aes-128-ecb", key, Buffer.alloc(0));
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]).toString("hex");
}

export function aesEcbDecryptHex(hex: string, key: Buffer): string {
  const decipher = createDecipheriv("aes-128-ecb", key, Buffer.alloc(0));
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString("utf8");
}

function rsaEncrypt(text: string): string {
  const reversed = Buffer.from(text.split("").reverse().join(""), "utf8");
  const hex = reversed.toString("hex");
  const message = BigInt("0x" + hex);
  const modulus = BigInt("0x" + RSA_MODULUS);
  let result = 1n;
  let base = message % modulus;
  let exp = RSA_EXPONENT;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exp >>= 1n;
  }
  return result.toString(16).padStart(256, "0");
}

export interface WeapiEnvelope {
  params: string;
  encSecKey: string;
}

export function weapi(data: unknown): WeapiEnvelope {
  const text = JSON.stringify(data ?? {});
  const secretKey = randomSecretKey(16);
  const params = aesCbcEncryptBase64(aesCbcEncryptBase64(text, PRESET_KEY), Buffer.from(secretKey, "utf8"));
  const encSecKey = rsaEncrypt(secretKey);
  return { params, encSecKey };
}

/**
 * eapi payload. `path` is the public API path, e.g. `/api/song/enhance/player/url/v1`.
 * The digest and the signed payload both use the `/api/...` form; only the HTTP
 * endpoint is rewritten to `/eapi/...` by the transport. Signing `/eapi/...`
 * instead makes the server answer `{"code":404,"message":"接口未找到！"}`.
 */
export function eapi(path: string, data: unknown): string {
  const text = JSON.stringify(data ?? {});
  const digest = md5(`nobody${path}use${text}md5forencrypt`);
  const payload = `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return aesEcbEncryptHex(payload, EAPI_KEY).toUpperCase();
}

/** eapi responses are occasionally wrapped as `#14<hex>`. */
export function eapiDecrypt(raw: string): string {
  if (typeof raw === "string" && raw.startsWith("#14")) {
    return aesEcbDecryptHex(raw.slice(3), EAPI_KEY);
  }
  return raw;
}

export const cryptoInternals = { RSA_MODULUS, RSA_EXPONENT, EAPI_KEY, PRESET_KEY, IV };
