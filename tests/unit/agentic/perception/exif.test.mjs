// exif 契约：JPEG EXIF 提取 DateTimeOriginal（拍摄时间）+ GPS 位置默认剥离（PRD §6.8.4 L518）。
// 对应实现：scripts/agentic/perception/exif.mjs。夹具为手造最小 EXIF JPEG（见 helpers.mjs）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExif, parseExifDateTime, stripGps } from '../../../../scripts/agentic/perception/exif.mjs';
import { jpegWithExif, JPEG_BYTES, TEXT_BYTES } from './helpers.mjs';

test('readExif extracts DateTimeOriginal and reports GPS presence', () => {
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10:26 15:04:05', withGps: true });
  const exif = readExif(jpeg);
  assert.equal(exif.dateTimeOriginal, '2026:10:26 15:04:05');
  assert.equal(exif.hasGps, true);
  assert.ok(exif.gps && typeof exif.gps === 'object', 'GPS IFD 存在时给出可读对象');
});

test('readExif on a GPS-free EXIF jpeg reports no gps but keeps the timestamp', () => {
  const exif = readExif(jpegWithExif({ dateTimeOriginal: '2026:10-26 09:00:00', withGps: false }));
  assert.equal(exif.dateTimeOriginal, '2026:10-26 09:00:00');
  assert.equal(exif.hasGps, false);
  assert.equal(exif.gps, null);
});

test('readExif tolerates jpegs without EXIF and rejects non-jpeg buffers', () => {
  assert.deepEqual(readExif(JPEG_BYTES), { dateTimeOriginal: null, hasGps: false, gps: null }, '无 APP1 段 → 空结果而非抛错');
  assert.equal(readExif(TEXT_BYTES), null, '非 JPEG 返回 null');
});

test('parseExifDateTime interprets EXIF local time as Asia/Shanghai (+08:00)', () => {
  const date = parseExifDateTime('2026:10:26 15:04:05');
  assert.ok(date instanceof Date);
  assert.equal(date.getTime(), new Date('2026-10-26T15:04:05+08:00').getTime());
  assert.equal(parseExifDateTime('garbage'), null);
  assert.equal(parseExifDateTime('2026:13:99 99:99:99'), null, '非法日期返回 null 而不是 Invalid Date 混过去');
});

test('stripGps removes location data while preserving the capture time and jpeg structure', () => {
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10-26 15:04:05', withGps: true });
  const stripped = stripGps(jpeg);
  assert.ok(Buffer.isBuffer(stripped));
  assert.equal(stripped[0], 0xff);
  assert.equal(stripped[1], 0xd8, '剥离后仍是 JPEG（SOI）');
  const after = readExif(stripped);
  assert.equal(after.hasGps, false, 'GPS 已剥离');
  assert.equal(after.gps, null);
  assert.equal(after.dateTimeOriginal, '2026:10-26 15:04:05', '拍摄时间保留');
});

test('stripGps is a no-op-safe pass for GPS-free and non-jpeg buffers', () => {
  const clean = jpegWithExif({ dateTimeOriginal: '2026-10-26 12:00:00', withGps: false });
  const out = stripGps(clean);
  assert.equal(readExif(out).dateTimeOriginal, '2026-10-26 12:00:00');
  assert.equal(readExif(out).hasGps, false);
  const notJpeg = stripGps(TEXT_BYTES);
  assert.ok(notJpeg.equals(TEXT_BYTES), '非 JPEG 原样返回');
});

// —— 实现侧补充用例（RED 基线之上只增不改）：MM 大端、经纬双解码、退化输入 ——

const wrapApp1 = tiff => {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const segment = Buffer.alloc(4 + payload.length);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, Buffer.from([0xff, 0xd9])]);
};

/** 大端（MM）TIFF：IFD0 → ExifIFD(DateTimeOriginal) + GPS IFD（纬度+经度各 3 个 RATIONAL）。 */
function buildExifTiffBE({ dateTimeOriginal, withGps }) {
  const dt = Buffer.from(`${dateTimeOriginal}\0`, 'latin1');
  const ifd0Offset = 8;
  const ifd0Size = 2 + (withGps ? 2 : 1) * 12 + 4;
  const exifIfdOffset = ifd0Offset + ifd0Size;
  const exifIfdSize = 2 + 12 + 4;
  const gpsIfdOffset = exifIfdOffset + exifIfdSize;
  const gpsIfdSize = withGps ? 2 + 4 * 12 + 4 : 0;
  const dtOffset = gpsIfdOffset + gpsIfdSize;
  const gpsDataOffset = dtOffset + dt.length;
  const buf = Buffer.alloc(gpsDataOffset + (withGps ? 48 : 0));
  buf.write('MM', 0, 'latin1');
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(ifd0Offset, 4);
  let p = ifd0Offset;
  buf.writeUInt16BE(withGps ? 2 : 1, p); p += 2;
  buf.writeUInt16BE(0x8769, p); buf.writeUInt16BE(4, p + 2); buf.writeUInt32BE(1, p + 4); buf.writeUInt32BE(exifIfdOffset, p + 8); p += 12;
  if (withGps) { buf.writeUInt16BE(0x8825, p); buf.writeUInt16BE(4, p + 2); buf.writeUInt32BE(1, p + 4); buf.writeUInt32BE(gpsIfdOffset, p + 8); p += 12; }
  buf.writeUInt32BE(0, p);
  p = exifIfdOffset;
  buf.writeUInt16BE(1, p); p += 2;
  buf.writeUInt16BE(0x9003, p); buf.writeUInt16BE(2, p + 2); buf.writeUInt32BE(dt.length, p + 4); buf.writeUInt32BE(dtOffset, p + 8); p += 12;
  buf.writeUInt32BE(0, p);
  if (withGps) {
    p = gpsIfdOffset;
    buf.writeUInt16BE(4, p); p += 2;
    buf.writeUInt16BE(0x0001, p); buf.writeUInt16BE(2, p + 2); buf.writeUInt32BE(2, p + 4); buf.write('N\0', p + 8, 'latin1'); p += 12; // GPSLatitudeRef
    buf.writeUInt16BE(0x0002, p); buf.writeUInt16BE(5, p + 2); buf.writeUInt32BE(3, p + 4); buf.writeUInt32BE(gpsDataOffset, p + 8); p += 12; // GPSLatitude
    buf.writeUInt16BE(0x0003, p); buf.writeUInt16BE(2, p + 2); buf.writeUInt32BE(2, p + 4); buf.write('E\0', p + 8, 'latin1'); p += 12; // GPSLongitudeRef
    buf.writeUInt16BE(0x0004, p); buf.writeUInt16BE(5, p + 2); buf.writeUInt32BE(3, p + 4); buf.writeUInt32BE(gpsDataOffset + 24, p + 8); p += 12; // GPSLongitude
    buf.writeUInt32BE(0, p);
    let q = gpsDataOffset;
    for (const [num, den] of [[31, 1], [13, 1], [1234, 100], [121, 1], [28, 1], [5678, 1000]]) { buf.writeUInt32BE(num, q); buf.writeUInt32BE(den, q + 4); q += 8; }
  }
  dt.copy(buf, dtOffset);
  return buf;
}

test('readExif handles big-endian (MM) TIFF and decodes latitude+longitude', () => {
  const jpeg = wrapApp1(buildExifTiffBE({ dateTimeOriginal: '2026:10:26 15:04:05', withGps: true }));
  const exif = readExif(jpeg);
  assert.equal(exif.dateTimeOriginal, '2026:10:26 15:04:05');
  assert.equal(exif.hasGps, true);
  assert.equal(exif.gps.latitudeRef, 'N');
  assert.equal(exif.gps.longitudeRef, 'E');
  assert.ok(Math.abs(exif.gps.latitude - (31 + 13 / 60 + 12.34 / 3600)) < 1e-9);
  assert.ok(Math.abs(exif.gps.longitude - (121 + 28 / 60 + 5.678 / 3600)) < 1e-9);
  const stripped = stripGps(jpeg);
  assert.equal(readExif(stripped).hasGps, false, 'MM 端序同样剥离');
  assert.equal(readExif(stripped).dateTimeOriginal, '2026:10:26 15:04:05');
});

const EMPTY = { dateTimeOriginal: null, hasGps: false, gps: null };

test('degenerate inputs degrade to empty results instead of throwing', () => {
  assert.deepEqual(readExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), EMPTY, '只有 SOI/EOI');
  const bogus = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0x00, 0x0c]), Buffer.from('Exif\0\0', 'latin1'), Buffer.from('XXXX')]),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.deepEqual(readExif(bogus), EMPTY, 'APP1 但 TIFF 头非法');
  assert.ok(stripGps(bogus).equals(bogus), 'TIFF 非法时原样返回');
});

test('parseExifDateTime: calendar-invalid dates and hyphen form', () => {
  assert.equal(parseExifDateTime('2026:02:31 10:00:00'), null, '2 月 31 日不存在');
  assert.equal(parseExifDateTime(''), null);
  assert.equal(parseExifDateTime(null), null);
  assert.equal(parseExifDateTime('2026-10-26 15:04:05').getTime(), new Date('2026-10-26T15:04:05+08:00').getTime(), '连字符写法同样按 +08:00');
});

test('segment scan stops at SOS/EOI; bad TIFF header degrades to empty', () => {
  const sosFirst = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(readExif(sosFirst), EMPTY, '扫描数据在前 → 不再找 EXIF');
  const badMagic = wrapApp1(Buffer.concat([Buffer.from('II', 'latin1'), Buffer.from([0x2a, 0x99]), Buffer.alloc(8)]));
  assert.deepEqual(readExif(badMagic), EMPTY, 'TIFF magic ≠ 42');
});

test('GPS-only TIFF (ExifIFD pointer zeroed) reports position without capture time', () => {
  const tiff = buildExifTiffBE({ dateTimeOriginal: '2026:10:26 15:04:05', withGps: true });
  tiff.fill(0, 18, 22); // IFD0 的 ExifIFDPointer 值清零
  const exif = readExif(wrapApp1(tiff));
  assert.equal(exif.dateTimeOriginal, null);
  assert.equal(exif.hasGps, true);
  assert.ok(Math.abs(exif.gps.latitude - (31 + 13 / 60 + 12.34 / 3600)) < 1e-9);
});

test('GPS pointer aimed out of bounds reads as no GPS rather than crashing', () => {
  const tiff = buildExifTiffBE({ dateTimeOriginal: '2026:10:26 15:04:05', withGps: true });
  tiff.writeUInt32BE(0xffff, 30); // IFD0 的 GPSInfoIFDPointer 指向越界
  const exif = readExif(wrapApp1(tiff));
  assert.deepEqual(exif, { dateTimeOriginal: '2026:10:26 15:04:05', hasGps: false, gps: null });
});
