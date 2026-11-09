/**
 * 从 JPEG 的 EXIF 里抠出内嵌缩略图。
 *
 * 为什么要这么干：系统 `.thumbnails` 缓存不是每张照片都有（老照片、截图常常没有），
 * 没有的话只能整张读原图 —— 一张 3–8MB，几十张就把链路堵死。
 *
 * 而相机拍的照片基本都在 EXIF 的 IFD1 里带一张 160×120 的 JPEG 缩略图，
 * 位置就在文件头几十 KB 内。所以只要 `dd` 读前 64KB，就能拿到能直接显示的图，
 * 传输量从 8MB 降到 64KB。
 */

/** 在给定的 JPEG 头部字节里找 EXIF 内嵌缩略图。 */
export function exifThumb(buf: Buffer): Buffer | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;

  // 逐段跳过 JPEG marker，找 APP1/Exif
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return undefined;
    const marker = buf[pos + 1]!;
    // SOI/EOI/RSTn 没有长度字段
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2) return undefined;

    if (marker === 0xe1 && buf.subarray(pos + 4, pos + 10).toString("latin1") === "Exif\0\0") {
      return fromTiff(buf.subarray(pos + 10, pos + 2 + len));
    }
    // 到了图像数据就不用再找了
    if (marker === 0xda) return undefined;
    pos += 2 + len;
  }
  return undefined;
}

function fromTiff(tiff: Buffer): Buffer | undefined {
  if (tiff.length < 8) return undefined;
  const tag = tiff.subarray(0, 2).toString("latin1");
  const le = tag === "II";
  if (!le && tag !== "MM") return undefined;

  const u16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number): number => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));

  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return undefined;

  // IFD0 末尾那个「下一个 IFD」的偏移通常指向 IFD1，缩略图就登记在 IFD1
  const count = u16(ifd0);
  const nextAt = ifd0 + 2 + count * 12;
  if (nextAt + 4 > tiff.length) return undefined;
  const ifd1 = u32(nextAt);
  if (ifd1 === 0 || ifd1 + 2 > tiff.length) return undefined;

  let offset = 0;
  let length = 0;
  const n = u16(ifd1);
  for (let i = 0; i < n; i++) {
    const entry = ifd1 + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const id = u16(entry);
    if (id === 0x0201) offset = u32(entry + 8);
    else if (id === 0x0202) length = u32(entry + 8);
  }

  if (!offset || !length) return undefined;
  if (offset + length > tiff.length) return undefined; // 头部截断，读不全
  return tiff.subarray(offset, offset + length);
}

/** 在任意字节里找第一张完整 JPEG（EXIF 缩略图自己就是以 FFD8 开头的）。 */
export function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
}
