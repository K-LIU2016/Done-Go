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
  const clean = jpegWithExif({ dateTimeOriginal: '2026:10-26 12:00:00', withGps: false });
  const out = stripGps(clean);
  assert.equal(readExif(out).dateTimeOriginal, '2026:10-26 12:00:00');
  assert.equal(readExif(out).hasGps, false);
  const notJpeg = stripGps(TEXT_BYTES);
  assert.ok(notJpeg.equals(TEXT_BYTES), '非 JPEG 原样返回');
});
