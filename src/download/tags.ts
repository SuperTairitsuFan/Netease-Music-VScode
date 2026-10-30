import * as fs from "node:fs/promises";

interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  track?: string;
  year?: string;
}

function syncsafe(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

function textFrame(id: string, value: string): Buffer {
  const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")]);
  const frame = Buffer.alloc(10 + body.length);
  frame.write(id, 0, "ascii");
  frame.writeUInt32BE(body.length, 4);
  frame.writeUInt16BE(0, 8);
  body.copy(frame, 10);
  return frame;
}

/** Minimal ID3v2.3 tag (title/artist/album/track/year), UTF-16 encoded. */
export function buildId3v23(tags: Tags): Buffer {
  const frames: Buffer[] = [];
  if (tags.title) frames.push(textFrame("TIT2", tags.title));
  if (tags.artist) frames.push(textFrame("TPE1", tags.artist));
  if (tags.album) frames.push(textFrame("TALB", tags.album));
  if (tags.track) frames.push(textFrame("TRCK", tags.track));
  if (tags.year) frames.push(textFrame("TYER", tags.year));
  const body = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "ascii");
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  syncsafe(body.length).copy(header, 6);
  return Buffer.concat([header, body]);
}

/** Prepends an ID3v2.3 tag to an MP3 file unless one is already present. */
export async function writeId3(file: string, tags: Tags): Promise<boolean> {
  const data = await fs.readFile(file);
  if (data.length >= 3 && data.subarray(0, 3).toString("ascii") === "ID3") return false;
  const tag = buildId3v23(tags);
  const tmp = `${file}.tagtmp`;
  await fs.writeFile(tmp, Buffer.concat([tag, data]));
  await fs.rename(tmp, file);
  return true;
}
