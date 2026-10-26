// W12 现场感知单测共享夹具：手工构造 multipart 体、带 EXIF 的 JPEG、各格式魔数样本。
// 全部自造字节，不依赖任何外部文件（BUILD-PLAN §2.3：单测一律 mock / 不发真实请求）。

/** 构造 multipart/form-data 请求体。parts: [{name,value}|{name,filename?,contentType?,data}] */
export function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(disposition + '\r\n'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    const body = part.data !== undefined ? part.data : Buffer.from(String(part.value ?? ''), 'utf8');
    chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/** 小端 TIFF/EXIF 段（IFD0 → Exif 子 IFD（DateTimeOriginal）→ 可选 GPS IFD），偏移按规范相对 TIFF 头。 */
export function buildExifTiff({ dateTimeOriginal, withGps }) {
  const dt = Buffer.from(`${dateTimeOriginal}\0`, 'latin1');
  const ifd0Offset = 8;
  const ifd0Size = 2 + (withGps ? 2 : 1) * 12 + 4;
  const exifIfdOffset = ifd0Offset + ifd0Size;
  const exifIfdSize = 2 + 1 * 12 + 4; // 仅 DateTimeOriginal 一项
  const gpsIfdOffset = exifIfdOffset + exifIfdSize;
  const gpsIfdSize = withGps ? 2 + 2 * 12 + 4 : 0;
  const dtOffset = gpsIfdOffset + gpsIfdSize;
  const gpsDataOffset = dtOffset + dt.length;
  const buf = Buffer.alloc(gpsDataOffset + (withGps ? 24 : 0));
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd0Offset, 4);
  let p = ifd0Offset;
  buf.writeUInt16LE(withGps ? 2 : 1, p); p += 2;
  buf.writeUInt16LE(0x8769, p); buf.writeUInt16LE(4, p + 2); buf.writeUInt32LE(1, p + 4); buf.writeUInt32LE(exifIfdOffset, p + 8); p += 12; // ExifIFDPointer
  if (withGps) { buf.writeUInt16LE(0x8825, p); buf.writeUInt16LE(4, p + 2); buf.writeUInt32LE(1, p + 4); buf.writeUInt32LE(gpsIfdOffset, p + 8); p += 12; } // GPSInfoIFDPointer
  buf.writeUInt32LE(0, p); // next IFD = 0
  p = exifIfdOffset;
  buf.writeUInt16LE(1, p); p += 2;
  buf.writeUInt16LE(0x9003, p); buf.writeUInt16LE(2, p + 2); buf.writeUInt32LE(dt.length, p + 4); buf.writeUInt32LE(dtOffset, p + 8); p += 12; // DateTimeOriginal (ASCII)
  buf.writeUInt32LE(0, p);
  if (withGps) {
    p = gpsIfdOffset;
    buf.writeUInt16LE(2, p); p += 2;
    buf.writeUInt16LE(0x0001, p); buf.writeUInt16LE(2, p + 2); buf.writeUInt32LE(2, p + 4); buf.write('N\0', p + 8, 'latin1'); p += 12; // GPSLatitudeRef（内联 4 字节）
    buf.writeUInt16LE(0x0002, p); buf.writeUInt16LE(5, p + 2); buf.writeUInt32LE(3, p + 4); buf.writeUInt32LE(gpsDataOffset, p + 8); p += 12; // GPSLatitude (RATIONAL×3)
    buf.writeUInt32LE(0, p);
    let q = gpsDataOffset; // 31/1, 13/1, 1234/100 → 北纬 31°13'12.34"
    for (const [num, den] of [[31, 1], [13, 1], [1234, 100]]) { buf.writeUInt32LE(num, q); buf.writeUInt32LE(den, q + 4); q += 8; }
  }
  dt.copy(buf, dtOffset);
  return buf;
}

/** 最小 JPEG：SOI + APP1(Exif) + EOI。 */
export function jpegWithExif({ dateTimeOriginal = '2026:10:26 15:04:05', withGps = false } = {}) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), buildExifTiff({ dateTimeOriginal, withGps })]);
  const segment = Buffer.alloc(4 + payload.length);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, Buffer.from([0xff, 0xd9])]);
}

const pad = (byte, size = 64) => Buffer.alloc(size, byte);

export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF\0', 'latin1'), pad(0x07)]);
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad(0x08)]);
export const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'latin1'), pad(0x09)]);
export const HEIC_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp', 'latin1'), Buffer.from('heic', 'latin1'), pad(0x01)]);
export const MP4_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp', 'latin1'), Buffer.from('isom', 'latin1'), pad(0x02)]);
export const MOV_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp', 'latin1'), Buffer.from('qt  ', 'latin1'), pad(0x03)]);
export const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pad(0x04)]);
export const TEXT_BYTES = Buffer.from('这既不是图片也不是视频，只是一段文本字节。not an image or video', 'utf8');
