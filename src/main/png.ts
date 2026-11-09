/**
 * 截断 PNG 的「顶部条带」解码。
 *
 * 手机里那些几十上百 MB 的素材图（PNG / APNG）整张拉过来不现实，
 * 而 IDAT 是从上往下按行存的：只要前面的压缩数据够，就能解出顶部若干行。
 * 这里把解出来的行重新封装成一张合法的小 PNG，交给 nativeImage 当缩略图用。
 *
 * 只处理 bitDepth=8、非隔行的常规 PNG；其它情况返回 undefined，
 * 调用方会退回「整张读」或占位，不会因此报错。
 */

import { constants as zlibConstants, deflateSync, inflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * @param input 原图开头一段字节（通常 800KB），末尾允许是半截 IDAT。
 * @returns 只含顶部若干行的合法 PNG；解不出来返回 undefined。
 */
export function pngTopStrip(input: Uint8Array): Uint8Array | undefined {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 64 || !buf.subarray(0, 8).equals(PNG_SIG)) return undefined;

  let off = 8;
  let ihdr: Buffer | undefined;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    // 最后一个块可能被截断：能拿多少拿多少，IDAT 的尾部垃圾会被 zlib 忽略
    const avail = Math.min(len, buf.length - off - 8);
    if (avail < 0) break;
    const data = buf.subarray(off + 8, off + 8 + avail);

    if (type === "IHDR" && avail >= 13) {
      ihdr = Buffer.from(data.subarray(0, 13));
      width = ihdr.readUInt32BE(0);
      height = ihdr.readUInt32BE(4);
      depth = ihdr[8]!;
      color = ihdr[9]!;
      interlace = ihdr[12]!;
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;

    if (avail < len) break;
    off += 12 + len;
  }

  if (!ihdr || idat.length === 0) return undefined;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = channels[color] ?? 0;
  // 位深不是 8（16 位、1/2/4 位调色板）或隔行图，解出来的行格式不一样，交给兜底
  if (!bpp || depth !== 8 || interlace !== 0) return undefined;
  const rowBytes = width * bpp;
  if (rowBytes <= 0 || rowBytes > 200_000 || height <= 0) return undefined;

  let raw: Buffer;
  try {
    // 允许 deflate 流不完整：Z_SYNC_FLUSH 会把已经解出的部分正常返回
    raw = inflateSync(Buffer.concat(idat), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
  } catch {
    return undefined;
  }

  const stride = rowBytes + 1;
  const want = Math.min(height, Math.max(64, Math.round(height / 2)), 512);
  const rows = Math.min(want, Math.floor(raw.length / stride));
  if (rows < 2) return undefined;

  const plain = Buffer.alloc(rows * stride);
  let prev = Buffer.alloc(rowBytes);
  for (let r = 0; r < rows; r++) {
    const at = r * stride;
    const filter = raw[at]!;
    const line = Buffer.from(raw.subarray(at + 1, at + stride));
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let add = 0;
      switch (filter) {
        case 0: add = 0; break;
        case 1: add = a; break;
        case 2: add = b; break;
        case 3: add = (a + b) >> 1; break;
        case 4: add = paeth(a, b, c); break;
        default: return undefined;
      }
      line[i] = (line[i]! + add) & 0xff;
    }
    // 重新编码时统一用 filter 0（None），不用逐行再算预测
    plain[at] = 0;
    line.copy(plain, at + 1);
    prev = line;
  }

  const head = Buffer.from(ihdr);
  head.writeUInt32BE(rows, 4); // IHDR 里改成条带的实际高度
  const parts: Buffer[] = [PNG_SIG, chunk("IHDR", head)];
  if (plte) parts.push(chunk("PLTE", plte));
  if (trns) parts.push(chunk("tRNS", trns));
  parts.push(chunk("IDAT", deflateSync(plain, { level: 6 })));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}
