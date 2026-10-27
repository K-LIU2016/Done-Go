// media-guard 契约：魔数白名单（jpeg/png/webp/heic、mp4/webm/mov）拒伪装扩展名；
// 图 ≤10MB、视频 ≤60MB；ffprobe 时长 ≤60s（runner 可注入）。对应实现：scripts/agentic/perception/media-guard.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, checkUpload, checkVideoDuration } from '../../../../scripts/agentic/perception/media-guard.mjs';
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES, HEIC_BYTES, MP4_BYTES, MOV_BYTES, WEBM_BYTES, TEXT_BYTES } from './helpers.mjs';

test('detectKind maps magic bytes to canonical format names', () => {
  assert.equal(detectKind(JPEG_BYTES), 'jpeg');
  assert.equal(detectKind(PNG_BYTES), 'png');
  assert.equal(detectKind(WEBP_BYTES), 'webp');
  assert.equal(detectKind(HEIC_BYTES), 'heic');
  assert.equal(detectKind(MP4_BYTES), 'mp4');
  assert.equal(detectKind(MOV_BYTES), 'mov');
  assert.equal(detectKind(WEBM_BYTES), 'webm');
  assert.equal(detectKind(TEXT_BYTES), null, '文本字节不在白名单');
  assert.equal(detectKind(Buffer.alloc(4)), null, '过短缓冲区判 unknown');
  assert.equal(detectKind(Buffer.alloc(0)), null, '空缓冲区判 unknown');
});

test('checkUpload accepts every whitelisted magic + extension pair with correct kind/mime', () => {
  const cases = [
    ['photo.jpg', JPEG_BYTES, 'image', 'image/jpeg'],
    ['photo.jpeg', JPEG_BYTES, 'image', 'image/jpeg'],
    ['x.png', PNG_BYTES, 'image', 'image/png'],
    ['a.webp', WEBP_BYTES, 'image', 'image/webp'],
    ['b.heic', HEIC_BYTES, 'image', 'image/heic'],
    ['v.mp4', MP4_BYTES, 'video', 'video/mp4'],
    ['v.webm', WEBM_BYTES, 'video', 'video/webm'],
    ['v.mov', MOV_BYTES, 'video', 'video/quicktime'],
  ];
  for (const [filename, data, kind, mime] of cases) {
    const out = checkUpload({ data, filename });
    assert.equal(out.ok, true, filename);
    assert.equal(out.kind, kind, filename);
    assert.equal(out.mime, mime, filename);
    assert.equal(out.format, detectKind(data), filename);
  }
});

test('checkUpload rejects unknown magic under an allowed extension', () => {
  assert.throws(() => checkUpload({ data: TEXT_BYTES, filename: 'note.jpg' }), /magic|unknown/i);
});

test('checkUpload rejects disguised extensions (magic ≠ extension-implied kind)', () => {
  assert.throws(() => checkUpload({ data: MP4_BYTES, filename: 'photo.jpg' }), /mismatch|magic/i, 'mp4 字节伪装 .jpg');
  assert.throws(() => checkUpload({ data: JPEG_BYTES, filename: 'clip.mp4' }), /mismatch|magic/i, 'jpeg 字节伪装 .mp4');
});

test('checkUpload rejects extensions outside the whitelist', () => {
  assert.throws(() => checkUpload({ data: PNG_BYTES, filename: 'avatar.php' }), /extension/i);
  assert.throws(() => checkUpload({ data: PNG_BYTES, filename: 'notes.txt' }), /extension/i);
});

test('image size cap: ≤10MB passes, 10MB+1 byte rejected', () => {
  const tenMb = 10 * 1024 * 1024;
  const at = Buffer.concat([JPEG_BYTES.subarray(0, 4), Buffer.alloc(tenMb, 0x07)]);
  assert.equal(checkUpload({ data: at, filename: 'ok.jpg' }).ok, true);
  const over = Buffer.concat([JPEG_BYTES.subarray(0, 4), Buffer.alloc(tenMb + 1, 0x07)]);
  assert.throws(() => checkUpload({ data: over, filename: 'big.jpg' }), /image.*(large|size)|too.large/i);
});

test('video size cap: 60MB+1 byte rejected', () => {
  const over = Buffer.concat([MP4_BYTES.subarray(0, 12), Buffer.alloc(60 * 1024 * 1024 + 1, 0x02)]);
  assert.throws(() => checkUpload({ data: over, filename: 'big.mp4' }), /video.*(large|size)|too.large/i);
});

const ffprobeJson = (duration, audio) => JSON.stringify({ streams: [{ codec_type: 'video' }, ...(audio ? [{ codec_type: 'audio' }] : [])], format: { duration: String(duration) } });

test('checkVideoDuration resolves seconds via injectable ffprobe runner', async () => {
  const calls = [];
  const run = async (bin, args) => { calls.push({ bin, args }); return { stdout: ffprobeJson(12.5, true), stderr: '' }; };
  const seconds = await checkVideoDuration('/tmp/v.mp4', { run });
  assert.equal(seconds, 12.5);
  assert.equal(calls[0].bin, 'ffprobe');
  assert.ok(calls[0].args.includes('/tmp/v.mp4'), '探测命令必须指向该文件');
});

test('checkVideoDuration enforces ≤60s and reports probe failures', async () => {
  const mk = stdout => async () => ({ stdout, stderr: '' });
  await assert.rejects(checkVideoDuration('/tmp/v.mp4', { run: mk(ffprobeJson(61.2, false)) }), /60|too.long/i);
  await assert.doesNotReject(checkVideoDuration('/tmp/v.mp4', { run: mk(ffprobeJson(60, false)) }), /60|too.long/);
  await assert.rejects(checkVideoDuration('/tmp/v.mp4', { run: mk('not json at all') }), /probe/i);
  await assert.rejects(checkVideoDuration('/tmp/v.mp4', { run: async () => { throw new Error('ffprobe not found'); } }), /probe|ffprobe/i);
});

// —— 实现侧补充用例（RED 基线之上只增不改）：brand 家族、真实 ffprobe 失败路径 ——

const ftyp = brand => Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp', 'latin1'),
  Buffer.from(brand.padEnd(4, ' '), 'latin1'),
  Buffer.alloc(8, 0),
]);

test('detectKind: ftyp brand families map to mp4/mov/heic; near-misses rejected', () => {
  assert.equal(detectKind(ftyp('avc1')), 'mp4');
  assert.equal(detectKind(ftyp('mp42')), 'mp4');
  assert.equal(detectKind(ftyp('mif1')), 'heic');
  assert.equal(detectKind(ftyp('qt')), 'mov');
  assert.equal(detectKind(ftyp('f4v ')), null, '未知 brand 宁拒不错');
  const riffWave = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(8)]);
  assert.equal(detectKind(riffWave), null, 'RIFF 但不是 WEBP');
  assert.equal(detectKind('not a buffer'), null, '非 Buffer 判 unknown');
});

test('checkUpload extension matching is case-insensitive', () => {
  assert.equal(checkUpload({ data: JPEG_BYTES, filename: 'PHOTO.JPG' }).format, 'jpeg');
});

test('checkVideoDuration: default runner surfaces real ffprobe failures', async () => {
  await assert.rejects(checkVideoDuration('/nonexistent/w12-perception/nope.mp4'), /probe|ffprobe/);
});
