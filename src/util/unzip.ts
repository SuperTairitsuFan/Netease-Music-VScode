import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP extractor for the component store (native engine zip bundles).
 * Supports stored (method 0) and deflate (method 8) entries, no data
 * descriptors, and rejects path traversal. Good enough for the zips our own
 * build script produces.
 */
export async function unzipToDir(zipPath: string, destDir: string): Promise<number> {
  const buf = await fs.readFile(zipPath);
  const eocd = findEocd(buf);
  if (!eocd) throw new Error("不是有效的 zip 文件（缺少目录结尾记录）");

  const count = eocd.readUInt16LE(10);
  if (count > 4096) throw new Error("zip 条目过多");
  let offset = eocd.readUInt32LE(16);
  let extracted = 0;

  await fs.mkdir(destDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip 条目头损坏：${name}`);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    if (name.endsWith("/")) {
      await fs.mkdir(path.join(destDir, name), { recursive: true });
    } else {
      const safe = name.split("/");
      if (safe.some((part) => part === ".." || part.includes(":"))) {
        throw new Error(`zip 条目包含不安全路径：${name}`);
      }
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!data) throw new Error(`不支持的压缩方式 ${method}：${name}`);
      const target = path.join(destDir, ...safe);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
      extracted += 1;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return extracted;
}

function findEocd(buf: Buffer): Buffer | null {
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.subarray(i, i + 22);
  }
  return null;
}
