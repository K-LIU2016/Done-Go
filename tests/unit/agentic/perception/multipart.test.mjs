// 自写最小流式 multipart/form-data 解析器契约（仓库无现成实现、禁新增依赖，BUILD-PLAN §2.3 L61）。
// 对应实现：scripts/agentic/perception/multipart.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from '../../../../scripts/agentic/perception/multipart.mjs';
import { buildMultipart, JPEG_BYTES, MP4_BYTES } from './helpers.mjs';

const CT = boundary => `multipart/form-data; boundary=${boundary}`;

test('parses plain fields and one binary file part', () => {
  const body = buildMultipart('boundary42', [
    { name: 'note', value: '白板进度' },
    { name: 'file', filename: 'photo.jpg', contentType: 'image/jpeg', data: JPEG_BYTES },
  ]);
  const out = parseMultipart(body, CT('boundary42'));
  assert.equal(out.fields.note, '白板进度');
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].name, 'file');
  assert.equal(out.files[0].filename, 'photo.jpg');
  assert.equal(out.files[0].contentType, 'image/jpeg');
  assert.ok(out.files[0].data.equals(JPEG_BYTES));
});

test('binary payloads with NUL/0xFF bytes survive the round trip untouched', () => {
  const nasty = Buffer.concat([Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x00, 0x2d]), Buffer.alloc(3000, 0xab)]);
  const body = buildMultipart('b1', [{ name: 'blob', filename: 'x.bin', contentType: 'application/octet-stream', data: nasty }]);
  const out = parseMultipart(body, CT('b1'));
  assert.ok(out.files[0].data.equals(nasty));
});

test('parses multiple files and keeps their order', () => {
  const body = buildMultipart('b2', [
    { name: 'a', filename: '1.jpg', contentType: 'image/jpeg', data: JPEG_BYTES },
    { name: 'b', filename: '2.mp4', contentType: 'video/mp4', data: MP4_BYTES },
  ]);
  const out = parseMultipart(body, CT('b2'));
  assert.deepEqual(out.files.map(f => f.filename), ['1.jpg', '2.mp4']);
});

test('accepts quoted boundary parameters and extra content-type params', () => {
  const body = buildMultipart('qboundary', [{ name: 'k', value: 'v' }]);
  const out = parseMultipart(body, 'multipart/form-data; charset=utf-8; boundary="qboundary"');
  assert.equal(out.fields.k, 'v');
});

test('filename is reported raw — traversal-looking names are sanitization’s job, not the parser’s', () => {
  const body = buildMultipart('b3', [{ name: 'file', filename: '../../etc/passwd', contentType: 'image/jpeg', data: JPEG_BYTES }]);
  const out = parseMultipart(body, CT('b3'));
  assert.equal(out.files[0].filename, '../../etc/passwd');
});

test('rejects non-multipart content types', () => {
  assert.throws(() => parseMultipart(Buffer.from('{}'), 'application/json'), /multipart/i);
});

test('rejects multipart without a boundary parameter', () => {
  assert.throws(() => parseMultipart(Buffer.from('x'), 'multipart/form-data'), /boundary/i);
});

test('rejects truncated bodies (no terminating boundary)', () => {
  const body = buildMultipart('b4', [{ name: 'k', value: 'v' }]);
  const truncated = body.subarray(0, body.length - 20); // 剪掉结尾 `--b4--\r\n` 附近
  assert.throws(() => parseMultipart(truncated, CT('b4')), /malformed|boundary/i);
});

test('rejects bodies larger than maxBytes before doing any work', () => {
  const body = buildMultipart('b5', [{ name: 'file', filename: 'big.jpg', contentType: 'image/jpeg', data: Buffer.alloc(2048, 1) }]);
  assert.throws(() => parseMultipart(body, CT('b5'), { maxBytes: body.length - 1 }), /too.large|size|bytes/i);
  const ok = parseMultipart(body, CT('b5'), { maxBytes: body.length + 1 });
  assert.equal(ok.files.length, 1);
});

test('empty parts list yields empty result instead of throwing', () => {
  const body = buildMultipart('b6', []);
  const out = parseMultipart(body, CT('b6'));
  assert.deepEqual(out.fields, {});
  assert.deepEqual(out.files, []);
});
