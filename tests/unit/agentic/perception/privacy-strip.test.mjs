// 隐私剥离专项（安全评审只读轮发现的 HIGH 修复回归，PRD §6.8.4 L517「EXIF 位置默认
// 剥离」）：原先只剥 JPEG GPS——PNG(eXIf 块)/WebP(EXIF 块)/HEIC 同在类型白名单里却
// 原样落盘，GPS 可能随文件持久化。修复契约：
//   stripPngExif —— 物理摘除全部 eXIf 块（其余块字节原样，含 CRC）；无 eXIf/结构截断原样返回
//   stripWebpExif —— 摘除 EXIF 块（含奇长填充）并回写 RIFF 总长；XMP 保留；异常原样返回
//   routes —— png/webp 落盘副本无 eXIf/EXIF；heic 415 拒收（无法保证剥离 → 宁拒不存）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripPngExif, stripWebpExif } from '../../../../scripts/agentic/perception/exif.mjs';
import { createPerceptionRoutes } from '../../../../scripts/agentic/perception/routes.mjs';
import { buildMultipart } from './helpers.mjs';

// ---- 测试用字节构造（PNG 块需带合法 CRC32，摘除断言按块表做）----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = pngChunk('IHDR', Buffer.alloc(13, 7));
const idat = pngChunk('IDAT', Buffer.alloc(16, 9));
const iend = pngChunk('IEND', Buffer.alloc(0));
const exifPayload = Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0\0\0\0\0', 'latin1');
const pngWithExif = Buffer.concat([PNG_SIG, ihdr, pngChunk('eXIf', exifPayload), idat, iend]);
const pngNoExif = Buffer.concat([PNG_SIG, ihdr, idat, iend]);

/** 解析 PNG 块表：[{type, start, end}]；结构坏了返回 null。 */
function pngChunks(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) return null;
    out.push({ type: buf.toString('latin1', off + 4, off + 8), start: off, end: off + 12 + len });
    off += 12 + len;
  }
  return out;
}

const webpChunk = (fourcc, data) => {
  const out = Buffer.alloc(8 + data.length + (data.length % 2));
  out.write(fourcc, 0, 'latin1');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
};
const riffOf = body => {
  const out = Buffer.concat([Buffer.alloc(12), body]);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WEBP', 8, 'latin1');
  return out;
};
const webpWithExif = riffOf(Buffer.concat([webpChunk('VP8 ', Buffer.alloc(10, 3)), webpChunk('EXIF', exifPayload), webpChunk('XMP ', Buffer.alloc(6, 4))]));
const webpOddExif = riffOf(Buffer.concat([webpChunk('EXIF', Buffer.alloc(7, 5)), webpChunk('VP8L', Buffer.alloc(4, 6))]));
const webpNoExif = riffOf(Buffer.concat([webpChunk('VP8 ', Buffer.alloc(10, 3))]));

/** 解析 WebP 块表 fourcc 列表；结构坏了返回 null。 */
function webpChunks(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  if (buf.readUInt32LE(4) !== buf.length - 8) return null; // RIFF 总长必须自洽
  const out = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32LE(off + 4);
    const padded = size + (size % 2);
    if (off + 8 + padded > buf.length) return null;
    out.push(buf.toString('latin1', off, off + 4));
    off += 8 + padded;
  }
  return out;
}

test('stripPngExif：eXIf 块被物理摘除，其余块字节原样（含 CRC）；无 eXIf / 非 PNG 原样返回', () => {
  const out = stripPngExif(pngWithExif);
  const types = pngChunks(out).map(c => c.type);
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND'], 'eXIf 消失，块序保留');
  const outChunks = pngChunks(out);
  const srcChunks = pngChunks(pngNoExif);
  for (let i = 0; i < srcChunks.length; i++) {
    assert.ok(pngNoExif.subarray(srcChunks[i].start, srcChunks[i].end).equals(out.subarray(outChunks[i].start, outChunks[i].end)), `${srcChunks[i].type} 字节原样`);
  }
  assert.equal(stripPngExif(pngNoExif), pngNoExif, '无 eXIf 返回同一引用');
  const notPng = Buffer.from([1, 2, 3]);
  assert.equal(stripPngExif(notPng), notPng, '非 PNG 原样（同一引用）');
  const truncated = Buffer.concat([PNG_SIG, ihdr, pngChunk('eXIf', exifPayload).subarray(0, 10)]);
  assert.equal(stripPngExif(truncated), truncated, '截断结构不动原件（fail-safe）');
});

test('stripWebpExif：EXIF 块摘除（含奇长填充）、RIFF 总长回写、XMP 保留；无 EXIF / 非 WebP 原样返回', () => {
  const out = stripWebpExif(webpWithExif);
  assert.deepEqual(webpChunks(out), ['VP8 ', 'XMP '], 'EXIF 消失、VP8/XMP 保留、RIFF 长度自洽');
  assert.ok(out.subarray(12, 12 + 18).equals(webpWithExif.subarray(12, 12 + 18)), 'VP8 块字节原样');
  const odd = stripWebpExif(webpOddExif);
  assert.deepEqual(webpChunks(odd), ['VP8L'], '奇长 EXIF（7B+1 填充）正确摘除');
  assert.equal(stripWebpExif(webpNoExif), webpNoExif);
  const notWebp = Buffer.alloc(20, 1);
  assert.equal(stripWebpExif(notWebp), notWebp, '非 WebP 原样（同一引用）');
  const bad = Buffer.concat([webpWithExif.subarray(0, 20)]);
  assert.equal(stripWebpExif(bad), bad, '结构异常原样返回');
});

// ---- 路由层：落盘副本的隐私保证（png/webp 剥离；heic 拒收）----

const COOKIE = 'session=alice';

function fakeStore() {
  const captures = new Map();
  const events = new Map();
  return {
    captures,
    async insertCapture(row) { captures.set(row.id, row); return row; },
    async getCapture(ownerId, id) { const c = captures.get(id); return c && c.ownerId === ownerId ? c : undefined; },
    async appendEvent(evt) { const list = events.get(evt.captureId) || []; const saved = { seq: list.length + 1, ...evt }; list.push(saved); events.set(evt.captureId, list); return saved; },
    async listEvents(ownerId, captureId) { const c = captures.get(captureId); return c && c.ownerId === ownerId ? (events.get(captureId) || []) : []; },
    async resolveCapture(ownerId, captureId, blockId) { const c = captures.get(captureId); if (!c || c.ownerId !== ownerId) return undefined; c.blockId = blockId; return c; },
  };
}

async function makeServer(t) {
  const dataDir = join(tmpdir(), `w12-privacy-${randomUUID()}`);
  mkdtempSync(dataDir);
  const { createServer } = await import('node:http');
  const store = fakeStore();
  const pipeline = { start: input => ({ captureId: input.captureId, attribution: { status: 'none', reason: 'no-blocks' } }) };
  const routes = createPerceptionRoutes({ auth: { authenticate: () => ({ id: 'alice' }) }, store, pipeline, config: { dataDir } });
  const server = createServer((req, res) => {
    routes(req, res, new URL(req.url, 'http://localhost').pathname)
      .then(handled => { if (!handled && !res.writableEnded) res.writeHead(404).end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); rmSync(dataDir, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, dataDir, store };
}

const storedFiles = dataDir => {
  const owner = join(dataDir, 'alice');
  return readdirSync(owner).map(n => readFileSync(join(owner, n)));
};

test('POST /api/captures png：落盘副本无 eXIf 块（隐私剥离随落盘，不只内存）', async t => {
  const f = await makeServer(t);
  const body = buildMultipart('pb', [{ name: 'file', filename: 'shot.png', contentType: 'image/png', data: pngWithExif }]);
  const res = await fetch(`${f.origin}/api/captures`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'multipart/form-data; boundary=pb' }, body });
  assert.equal(res.status, 202);
  const files = storedFiles(f.dataDir);
  assert.equal(files.length, 1);
  assert.deepEqual(pngChunks(files[0]).map(c => c.type), ['IHDR', 'IDAT', 'IEND'], '落盘 PNG 无 eXIf');
});

test('POST /api/captures webp：落盘副本无 EXIF 块且 RIFF 自洽', async t => {
  const f = await makeServer(t);
  const body = buildMultipart('pb', [{ name: 'file', filename: 'shot.webp', contentType: 'image/webp', data: webpWithExif }]);
  const res = await fetch(`${f.origin}/api/captures`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'multipart/form-data; boundary=pb' }, body });
  assert.equal(res.status, 202);
  const files = storedFiles(f.dataDir);
  assert.deepEqual(webpChunks(files[0]), ['VP8 ', 'XMP '], '落盘 WebP 无 EXIF');
});

test('POST /api/captures heic：415 拒收且不落盘不入库（无法保证元数据剥离 → 宁拒不存）', async t => {
  const f = await makeServer(t);
  const heic = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(40, 1)]);
  const body = buildMultipart('pb', [{ name: 'file', filename: 'shot.heic', contentType: 'image/heic', data: heic }]);
  const res = await fetch(`${f.origin}/api/captures`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'multipart/form-data; boundary=pb' }, body });
  assert.equal(res.status, 415);
  const out = await res.json();
  assert.equal(out.error.code, 'CONTRACT_INVALID', '统一 api-error 信封（修复轮：扁平错误码不符冻结契约）');
  assert.equal(out.error.details.reason, 'heic-metadata-stripping-unavailable', '语义 slug 保留在 details.reason');
  assert.equal(f.store.captures.size, 0, '未入库');
  const ownerDir = join(f.dataDir, 'alice');
  assert.ok(!existsSync(ownerDir) || readdirSync(ownerDir).length === 0, '未落盘（目录不存在或为空）');
});
