// W12 现场感知：JPEG EXIF 拍摄时间提取 + GPS 位置默认剥离（PRD §6.8.4）。
// 最小实现：只解 APP1/Exif → IFD0 → ExifIFD(0x9003 DateTimeOriginal) 与 GPS IFD(0x8825)，
// 兼容 II/MM 两种字节序。stripGps 把 GPS 指针置零并物理清零 GPS IFD 的表与数据字节——
// 不移动其他 IFD 偏移，拍摄时间与 JPEG 结构原样保留；EXIF 本地时间按 Asia/Shanghai 解释。
'use strict';

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const GPS_LAT_REF = 0x0001, GPS_LAT = 0x0002, GPS_LON_REF = 0x0003, GPS_LON = 0x0004;

/** 在 JPEG 段序列里定位 APP1/Exif，返回 TIFF 头的绝对区间；EXIF 只可能出现在扫描数据之前。 */
function findExifTiff(buf) {
  let off = 2; // 跳过 SOI
  while (off + 4 <= buf.length) {
    const marker = buf.readUInt16BE(off);
    if (marker === 0xffd9 || marker === 0xffda) return null; // EOI / 扫描数据开始：后面不会再有 EXIF
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    const segEnd = off + 2 + len;
    if (segEnd > buf.length) return null;
    if (marker === 0xffe1 && len >= 8 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      return { tiffStart: off + 10, tiffEnd: segEnd };
    }
    off = segEnd;
  }
  return null;
}

/** TIFF 头（字节序/42/IFD0 偏移）→ 带端序的读取器；不合法返回 null。 */
function tiffReader(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = o => (o >= 0 && o + 2 <= tiff.length) ? tiff[`readUInt16${le ? 'LE' : 'BE'}`](o) : null;
  const u32 = o => (o >= 0 && o + 4 <= tiff.length) ? tiff[`readUInt32${le ? 'LE' : 'BE'}`](o) : null;
  if (u16(2) !== 42) return null;
  return { tiff, u16, u32 };
}

/** 读一个 IFD 的全部条目；越界/条目数异常返回 null。 */
function readIfd(reader, offset) {
  const n = reader.u16(offset);
  if (n === null || n === 0 || n > 256) return null;
  const entries = [];
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > reader.tiff.length) return null;
    entries.push({ tag: reader.u16(e), type: reader.u16(e + 2), count: reader.u32(e + 4), valueOffset: reader.u32(e + 8), entryAt: e });
  }
  return entries;
}

/** ASCII 值（count 含结尾 NUL；≤4 字节内联在条目里，否则在 valueOffset 处）。 */
function readAscii(reader, entry) {
  if (entry.type !== 2 || entry.count < 1) return null;
  const start = entry.count <= 4 ? entry.entryAt + 8 : entry.valueOffset;
  if (start === null || start + entry.count > reader.tiff.length) return null;
  return reader.tiff.toString('latin1', start, start + entry.count - 1);
}

/** RATIONAL 数组（type 5）；分母为 0 记 0。 */
function readRationals(reader, entry) {
  if (entry.type !== 5 || entry.count < 1) return null;
  const start = entry.valueOffset;
  if (start === null || start + entry.count * 8 > reader.tiff.length) return null;
  const out = [];
  for (let i = 0; i < entry.count; i++) {
    const num = reader.u32(start + i * 8);
    const den = reader.u32(start + i * 8 + 4);
    out.push(den ? num / den : 0);
  }
  return out;
}

const dmsToDecimal = entry => {
  const r = entry.__ratios;
  return r ? r[0] + r[1] / 60 + r[2] / 3600 : null;
};

/** GPS IFD → { latitude, longitude, latitudeRef, longitudeRef }（度分秒转十进制度）。 */
function decodeGps(reader, offset) {
  const entries = readIfd(reader, offset);
  if (!entries) return null;
  const get = tag => entries.find(e => e.tag === tag);
  const ref = tag => {
    const e = get(tag);
    return e ? readAscii(reader, e) : null;
  };
  for (const e of entries) e.__ratios = readRationals(reader, e);
  const lat = get(GPS_LAT), lon = get(GPS_LON);
  return {
    latitude: lat ? dmsToDecimal(lat) : null,
    longitude: lon ? dmsToDecimal(lon) : null,
    latitudeRef: ref(GPS_LAT_REF),
    longitudeRef: ref(GPS_LON_REF),
  };
}

const EMPTY_EXIF = { dateTimeOriginal: null, hasGps: false, gps: null };

/**
 * 读 JPEG 的 EXIF：{ dateTimeOriginal（原始字符串，如 "2026:10:26 15:04:05"）, hasGps, gps }。
 * 无 EXIF 的 JPEG 返回空结果；非 JPEG 返回 null。解析失败一律降级为空结果，不抛错。
 */
export function readExif(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const loc = findExifTiff(buf);
  if (!loc) return { ...EMPTY_EXIF };
  const reader = tiffReader(buf.subarray(loc.tiffStart, loc.tiffEnd));
  if (!reader) return { ...EMPTY_EXIF };
  const ifd0Off = reader.u32(4);
  const ifd0 = Number.isInteger(ifd0Off) ? readIfd(reader, ifd0Off) : null;
  if (!ifd0) return { ...EMPTY_EXIF };
  let dateTimeOriginal = null;
  const exifPtr = ifd0.find(e => e.tag === TAG_EXIF_IFD);
  if (exifPtr && exifPtr.valueOffset) {
    const exifIfd = readIfd(reader, exifPtr.valueOffset);
    const dt = exifIfd && exifIfd.find(e => e.tag === TAG_DATETIME_ORIGINAL);
    if (dt) dateTimeOriginal = readAscii(reader, dt);
  }
  let gps = null;
  const gpsPtr = ifd0.find(e => e.tag === TAG_GPS_IFD);
  if (gpsPtr && gpsPtr.valueOffset) gps = decodeGps(reader, gpsPtr.valueOffset);
  return { dateTimeOriginal, hasGps: gps !== null, gps };
}

const DT_RE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/** EXIF 本地时间 = Asia/Shanghai（+08:00）；非法值返回 null 而非 Invalid Date。 */
export function parseExifDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = DT_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null; // 2 月 31 日这类日历错误
  return date;
}

/** 清零 GPS IFD 引用的外联数据区（bounds 内），配合清表一起做。 */
function zeroGpsData(tiffOut, reader, gpsOffset) {
  const n = reader.u16(gpsOffset + 0) ?? 0;
  for (let i = 0; i < Math.min(n, 256); i++) {
    const e = gpsOffset + 2 + i * 12;
    if (e + 12 > tiffOut.length) break;
    const type = reader.u16(e + 2);
    const count = reader.u32(e + 4);
    const size = (TYPE_SIZE[type] || 0) * count;
    if (size > 4) {
      const start = reader.u32(e + 8);
      if (start !== null && start + size <= tiffOut.length) tiffOut.fill(0, start, start + size);
    }
  }
}

/**
 * GPS 位置默认剥离（PRD §6.8.4）：返回清除了 GPS 的副本（不动调用方原件）。
 * 做法：GPS 指针条目值置 0（后续读取视为无 GPS）+ 物理清零 GPS IFD 表与数据字节；
 * 其他 IFD 偏移不动，拍摄时间与 JPEG 结构完整保留。非 JPEG / 无 GPS 原样返回。
 */
export function stripGps(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const loc = findExifTiff(buf);
  if (!loc) return buf;
  const reader = tiffReader(buf.subarray(loc.tiffStart, loc.tiffEnd));
  if (!reader) return buf;
  const ifd0Off = reader.u32(4);
  const ifd0 = Number.isInteger(ifd0Off) ? readIfd(reader, ifd0Off) : null;
  const gpsPtr = ifd0 && ifd0.find(e => e.tag === TAG_GPS_IFD);
  if (!gpsPtr || !gpsPtr.valueOffset) return buf; // 本来就没有 GPS
  const out = Buffer.from(buf); // 全量拷贝，绝不改调用方原件
  const base = loc.tiffStart;
  out.fill(0, base + gpsPtr.entryAt + 8, base + gpsPtr.entryAt + 12); // 指针值置零
  const tiffOut = out.subarray(base, loc.tiffEnd);
  const gpsOffset = gpsPtr.valueOffset;
  const n = reader.u16(gpsOffset);
  zeroGpsData(tiffOut, reader, gpsOffset); // 先清数据（表还在，能读到 entry）
  if (n !== null && n <= 256) {
    const tableEnd = Math.min(gpsOffset + 2 + n * 12 + 4, tiffOut.length);
    tiffOut.fill(0, gpsOffset, tableEnd); // 再清整个 IFD 表
  }
  return out;
}

/**
 * PNG 元数据剥离（PRD §6.8.4 默认剥离在非 JPEG 上的延伸）：物理移除全部 eXIf 块
 * （PNG 规范 chunk 自带长度与 CRC、彼此独立，摘除不影响其余结构）。无 eXIf 或结构
 * 异常（截断/长度越界）时原样返回（fail-safe，宁可拒绝处理也不产出坏文件）。
 */
export function stripPngExif(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return buf;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return buf;
  const keep = [buf.subarray(0, 8)];
  let off = 8;
  let removed = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) return buf; // 截断：不动原件
    if (type === 'eXIf') removed = true;
    else keep.push(buf.subarray(off, off + 12 + len));
    off += 12 + len;
  }
  return removed ? Buffer.concat(keep) : buf;
}

/**
 * WebP 元数据剥离：RIFF 容器里物理移除 EXIF 块（含奇长填充位）并回写 RIFF 总长；
 * XMP 块保留（承载非位置类元数据，摘除过度）。非 WebP / 无 EXIF / 结构异常原样返回。
 */
export function stripWebpExif(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return buf;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return buf;
  const keep = [];
  let off = 12;
  let removed = false;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const padded = size + (size % 2); // RIFF 每块按 2 字节对齐填充
    if (off + 8 + padded > buf.length) return buf; // 截断：不动原件
    if (fourcc === 'EXIF') removed = true;
    else keep.push(buf.subarray(off, off + 8 + padded));
    off += 8 + padded;
  }
  if (!removed) return buf;
  const body = Buffer.concat(keep);
  const out = Buffer.concat([Buffer.alloc(12), body]);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4); // RIFF size = 总长 − 'RIFF'+size 字段
  out.write('WEBP', 8, 'latin1');
  return out;
}
