// routes 契约：createPerceptionRoutes({auth,store,pipeline,config}) → async (req,res,pathname)=>boolean
// （BUILD-PLAN §2.1 L46，不挂 serve-tango.mjs）。POST /api/captures multipart → 202+captureId+归属；
// GET /api/captures/:id/events SSE（card.created/card.upgraded/card.deep_failed/[DONE]，帧写法仿 serve-tango.mjs:165-178）；
// POST /api/captures/:id/resolve 歧义裁决；未登录 401、owner 隔离、体积上限。
// 自建 node:http harness 测试。对应实现：scripts/agentic/perception/routes.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPerceptionRoutes } from '../../../../scripts/agentic/perception/routes.mjs';
import { readExif } from '../../../../scripts/agentic/perception/exif.mjs';
import { buildMultipart, jpegWithExif, JPEG_BYTES, MP4_BYTES, TEXT_BYTES } from './helpers.mjs';

const COOKIE = 'session=alice';

function fakeStore() {
  const captures = new Map();
  const events = new Map();
  return {
    captures,
    events,
    async insertCapture(row) { captures.set(row.id, row); return row; },
    async getCapture(ownerId, id) { const c = captures.get(id); return c && c.ownerId === ownerId ? c : undefined; },
    async appendEvent(evt) { const list = events.get(evt.captureId) || []; const saved = { id: `e${list.length + 1}`, seq: list.length + 1, ...evt }; list.push(saved); events.set(evt.captureId, list); return saved; },
    async listEvents(ownerId, captureId) { const c = captures.get(captureId); if (!c || c.ownerId !== ownerId) return []; return events.get(captureId) || []; },
    async resolveCapture(ownerId, captureId, blockId) { const c = captures.get(captureId); if (!c || c.ownerId !== ownerId) return undefined; c.blockId = blockId; return c; },
  };
}

async function makeFixture(t, { attribution } = {}) {
  const dataDir = join(tmpdir(), `w12-routes-${randomUUID()}`);
  const store = fakeStore();
  const pipelineStarts = [];
  const blocks = [{ id: 'b-shelf', title: '做木书架', kind: 'craft', start: '2026-10-26T19:00:00+08:00', end: '2026-10-26T21:00:00+08:00' }];
  const pipeline = {
    start(input) {
      pipelineStarts.push(input);
      return { captureId: input.captureId, attribution: attribution ?? { status: 'matched', blockId: 'b-shelf', confidence: 0.9 } };
    },
  };
  const auth = {
    authenticate(req) {
      if (!(req.headers.cookie || '').includes(COOKIE)) { const e = new Error('unauthorized'); e.status = 401; throw e; }
      return { id: 'alice' };
    },
  };
  const routes = createPerceptionRoutes({ auth, store, pipeline, config: { dataDir, getBlocks: async () => blocks } });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    routes(req, res, pathname)
      .then(handled => { if (!handled && !res.writableEnded) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'route-not-found' })); } })
      .catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server-error' })); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return { origin, dataDir, store, pipelineStarts, blocks };
}

const postCapture = (origin, body, headers) =>
  fetch(`${origin}/api/captures`, { method: 'POST', headers, body });

function multipartHeaders(boundary) { return { cookie: COOKIE, 'content-type': `multipart/form-data; boundary=${boundary}` }; }

async function json(res) { return { status: res.status, body: await res.json() }; }

test('POST /api/captures: validates, stores under the owner’s private dir with a random id, strips GPS, returns 202 + attribution', async t => {
  const f = await makeFixture(t);
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10:26 19:05:00', withGps: true });
  const body = buildMultipart('w12b', [{ name: 'file', filename: 'photo.jpg', contentType: 'image/jpeg', data: jpeg }]);
  const res = await postCapture(f.origin, body, multipartHeaders('w12b'));
  const out = await json(res);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.deepEqual(out.body.attribution, { status: 'matched', blockId: 'b-shelf', confidence: 0.9 });
  const captureId = out.body.captureId;
  assert.ok(typeof captureId === 'string' && captureId.length >= 8);
  // 入库
  const row = f.store.captures.get(captureId);
  assert.ok(row, 'capture 已入库');
  assert.equal(row.ownerId, 'alice');
  assert.equal(row.kind, 'image', 'kind 由魔数判定');
  assert.ok(row.capturedAt.startsWith('2026-10-26T19:05:00'), '拍摄时间取自 EXIF DateTimeOriginal');
  assert.ok(row.uploadedAt, '上传时间兜底记录');
  assert.equal(row.exifStripped, true);
  // 落盘：owner 私有目录 + 随机文件名 + 不可信文件名不参与路径
  assert.ok(row.storedPath.startsWith(join(f.dataDir, 'alice')), row.storedPath);
  const base = row.storedPath.split('/').pop();
  assert.notEqual(base, 'photo.jpg');
  assert.ok(!row.storedPath.includes('..'));
  assert.ok(existsSync(row.storedPath), '文件已写入');
  const saved = readFileSync(row.storedPath);
  assert.equal(saved[0], 0xff);
  assert.equal(saved[1], 0xd8);
  assert.deepEqual(readExif(saved), { dateTimeOriginal: '2026:10:26 19:05:00', hasGps: false, gps: null }, '落盘字节 GPS 已剥离、时间保留');
  // pipeline 拿到同样的上下文
  assert.equal(f.pipelineStarts.length, 1);
  const start = f.pipelineStarts[0];
  assert.equal(start.captureId, captureId);
  assert.equal(start.ownerId, 'alice');
  assert.equal(start.kind, 'image');
  assert.equal(start.path, row.storedPath);
  assert.deepEqual(start.blocks, f.blocks, '日程块经 config.getBlocks 注入');
  assert.equal(typeof start.emit, 'function', 'SSE 桥接 emit 已传入');
});

test('POST /api/captures: hostile filename never escapes the owner dir（文件名不可信）', async t => {
  const f = await makeFixture(t);
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10-26 19:05:00', withGps: false });
  const body = buildMultipart('w12b', [{ name: 'file', filename: '../../../etc/passwd.jpg', contentType: 'image/jpeg', data: jpeg }]);
  const res = await postCapture(f.origin, body, multipartHeaders('w12b'));
  const out = await json(res);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  const row = f.store.captures.get(out.body.captureId);
  assert.ok(row.storedPath.startsWith(join(f.dataDir, 'alice')));
  assert.ok(!row.storedPath.includes('..'), '路径穿越被中和');
  assert.ok(existsSync(row.storedPath));
});

test('POST /api/captures: video uploads land with kind=video', async t => {
  const f = await makeFixture(t);
  const body = buildMultipart('w12b', [{ name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', data: MP4_BYTES }]);
  const out = await json(await postCapture(f.origin, body, multipartHeaders('w12b')));
  assert.equal(out.status, 202, JSON.stringify(out.body));
  const row = f.store.captures.get(out.body.captureId);
  assert.equal(row.kind, 'video');
  assert.ok(row.storedPath.endsWith('.mp4'));
});

test('POST /api/captures rejects: 401 anonymous, 405 wrong method, 415 non-multipart, 400 bad multipart, 415 bad media, 413 oversized', async t => {
  const f = await makeFixture(t);
  // 401 未登录（仿 collaboration.authenticate：auth 抛错 → 401）
  const anon = await fetch(`${f.origin}/api/captures`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'x' });
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error, 'unauthorized');
  // 405 方法不符
  const get = await fetch(`${f.origin}/api/captures`, { headers: { cookie: COOKIE } });
  assert.equal(get.status, 405);
  assert.equal((await get.json()).error, 'method-rejected');
  // 415 非 multipart
  const jsonRes = await postCapture(f.origin, JSON.stringify({}), { cookie: COOKIE, 'content-type': 'application/json' });
  assert.equal(jsonRes.status, 415);
  assert.equal((await jsonRes.json()).error, 'multipart-required');
  // 400 坏 multipart（boundary 永不匹配）
  const bad = await postCapture(f.origin, 'garbage-bytes-not-multipart', multipartHeaders('nope'));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'multipart-invalid');
  // 415 白名单外媒体（文本字节 + .txt 扩展名）
  const evil = buildMultipart('w12b', [{ name: 'file', filename: 'note.txt', contentType: 'text/plain', data: TEXT_BYTES }]);
  const media = await json(await postCapture(f.origin, evil, multipartHeaders('w12b')));
  assert.equal(media.status, 415, JSON.stringify(media.body));
  assert.equal(media.body.error, 'media-rejected');
  assert.equal(f.pipelineStarts.length, 0, '拒绝的请求不入队');
});

test('POST /api/captures: transport size cap rejects before touching disk', async t => {
  // 契约要求 routes 尊重 config.maxVideoBytes（默认 60MB；此处注入小配额验证 413 路径）
  const dataDir = join(tmpdir(), `w12-routes-${randomUUID()}`);
  const store = fakeStore();
  const pipeline = { start: () => ({ captureId: 'x', attribution: { status: 'none', reason: 'no-blocks' } }) };
  const auth = { authenticate: () => ({ id: 'alice' }) };
  const routes = createPerceptionRoutes({ auth, store, pipeline, config: { dataDir, getBlocks: async () => [], maxVideoBytes: 512 } });
  const server = createServer((req, res) => { routes(req, res, new URL(req.url, 'http://localhost').pathname).then(h => { if (!h && !res.writableEnded) res.writeHead(404).end(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const big = buildMultipart('w12b', [{ name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', data: Buffer.alloc(2048 * 1024, 3) }]);
  const res = await fetch(`${origin}/api/captures`, { method: 'POST', headers: multipartHeaders('w12b'), body: big });
  assert.equal(res.status, 413, '超过 config.maxVideoBytes+余量直接 413');
  assert.equal((await res.json()).error, 'body-too-large');
  assert.equal(store.captures.size, 0, '未入库未落盘');
});

test('GET /api/captures/:id/events: SSE replays stored events, streams live ones, ends with [DONE] after upgrade', async t => {
  const f = await makeFixture(t);
  // 1) 先 POST 一个 capture（此时 pipeline 未发任何事件）
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10-26 19:05:00', withGps: false });
  const posted = await json(await postCapture(f.origin, buildMultipart('w12b', [{ name: 'file', filename: 'p.jpg', contentType: 'image/jpeg', data: jpeg }]), multipartHeaders('w12b')));
  assert.equal(posted.status, 202);
  const captureId = posted.body.captureId;
  const emit = f.pipelineStarts[0].emit;
  // 2) 打开 SSE
  const sse = await fetch(`${f.origin}/api/captures/${captureId}/events`, { headers: { cookie: COOKIE } });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type') || '', /^text\/event-stream/);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let streamEnded = false;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) frames.push(line.slice(6));
      }
    }
    streamEnded = true;
  })();
  const waitFor = async (label, predicate, ms = 5000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > ms) throw new Error(`SSE 等待 ${label} 超时；frames=${JSON.stringify(frames)}`);
      await new Promise(r => setTimeout(r, 10));
    }
  };
  // 3) 快卡（实时帧）→ 深卡升级（终态帧 + [DONE]，流随之结束）
  await emit('card.created', { captureId, blockId: 'b-shelf', level: 'fast', model: 'qwen3.5-omni-flash', ms: 1500, seen: '正在组装书架' });
  await waitFor('card.created 实时帧', () => frames.some(f => f.includes('"card.created"')));
  await emit('card.upgraded', { captureId, blockId: 'b-shelf', level: 'deep', suggestion: '夹固 15 分钟', contextDelta: { blockId: 'b-shelf' } });
  await waitFor('[DONE]', () => frames.includes('[DONE]'));
  await pump;
  assert.equal(streamEnded, true, '终态后服务端结束 SSE 流');
  const parsed = frames.map(fr => (fr === '[DONE]' ? '[DONE]' : JSON.parse(fr)));
  assert.equal(parsed[0].type, 'card.created');
  assert.equal(parsed[0].seen, '正在组装书架');
  assert.equal(parsed[1].type, 'card.upgraded');
  assert.equal(parsed[1].suggestion, '夹固 15 分钟');
  assert.equal(parsed.at(-1), '[DONE]', '终态后发 [DONE] 结束流');
});

test('GET events: 401 anonymous, 404 other owners（owner 隔离不泄露存在性）', async t => {
  const f = await makeFixture(t);
  const anon = await fetch(`${f.origin}/api/captures/whatever/events`);
  assert.equal(anon.status, 401);
  // bob 的 capture，alice 来读 → 404
  f.store.captures.set('cap-bob', { id: 'cap-bob', ownerId: 'bob', kind: 'image' });
  const cross = await fetch(`${f.origin}/api/captures/cap-bob/events`, { headers: { cookie: COOKIE } });
  assert.equal(cross.status, 404);
  assert.equal((await cross.json()).error, 'capture-not-found');
});

test('POST /api/captures/:id/resolve settles ambiguity for the owner only', async t => {
  const f = await makeFixture(t);
  f.store.captures.set('cap-1', { id: 'cap-1', ownerId: 'alice', kind: 'image', candidates: [{ blockId: 'b-a' }, { blockId: 'b-b' }] });
  const okRes = await json(await fetch(`${f.origin}/api/captures/cap-1/resolve`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ blockId: 'b-b' }) }));
  assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
  assert.equal(f.store.captures.get('cap-1').blockId, 'b-b');
  const badBody = await fetch(`${f.origin}/api/captures/cap-1/resolve`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(badBody.status, 400);
  assert.equal((await badBody.json()).error, 'invalid-input');
  const unknown = await fetch(`${f.origin}/api/captures/nope/resolve`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ blockId: 'b' }) });
  assert.equal(unknown.status, 404);
  const anon = await fetch(`${f.origin}/api/captures/cap-1/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blockId: 'b' }) });
  assert.equal(anon.status, 401);
  // bob 的 capture 不给 alice resolve
  f.store.captures.set('cap-bob', { id: 'cap-bob', ownerId: 'bob', kind: 'image' });
  const cross = await fetch(`${f.origin}/api/captures/cap-bob/resolve`, { method: 'POST', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ blockId: 'b' }) });
  assert.equal(cross.status, 404);
});

test('unrelated paths are not handled (mount contract: returns false)', async t => {
  const f = await makeFixture(t);
  const other = await fetch(`${f.origin}/api/other`, { headers: { cookie: COOKIE } });
  assert.equal(other.status, 404);
  assert.equal((await other.json()).error, 'route-not-found', 'harness 404 = routes 返回 false');
  const bare = await fetch(`${f.origin}/api/captures`, { method: 'POST', headers: { ...multipartHeaders('x'), cookie: 'session=nobody' }, body: 'x' });
  assert.equal(bare.status, 401, '先鉴权后路由');
});

test('构造与补充分支：db 直建 store、缺 file 部件 400、events 非 GET 405、pipeline 抛错 502、duration 钩子拒绝', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = join(tmpdir(), `w12-routes-${randomUUID()}`);
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const events = [];
  const pipeline = {
    start(input) { // 上传即双路完成（微任务里发完两帧，交 emit 桥落台账）
      queueMicrotask(() => input.emit('card.created', { captureId: input.captureId, blockId: 'b-shelf', seen: '隔板已涂胶' })
        .then(() => input.emit('card.upgraded', { captureId: input.captureId, blockId: 'b-shelf', suggestion: '夹固 15 分钟' })));
      return { captureId: input.captureId, attribution: { status: 'matched', blockId: 'b-shelf', confidence: 0.9 } };
    },
  };
  const auth = { authenticate: () => ({ id: 'alice' }) };
  const config = { dataDir, getBlocks: async () => [], checkVideoDuration: async () => {} };
  const routes = createPerceptionRoutes({ db, auth, pipeline, config });
  const server = createServer((req, res) => {
    routes(req, res, new URL(req.url, 'http://localhost').pathname)
      .then(handled => { if (!handled && !res.writableEnded) res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'route-not-found' })); })
      .catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  // db 直建 store（真实 node:sqlite + perception-0001 迁移）：归属结果已持久化到 captures 行
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10:26 19:05:00', withGps: false });
  const posted = await json(await postCapture(origin, buildMultipart('w12b', [{ name: 'file', filename: 'p.jpg', contentType: 'image/jpeg', data: jpeg }]), multipartHeaders('w12b')));
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const captureId = posted.body.captureId;
  const persisted = db.prepare('SELECT * FROM captures WHERE id = ?').get(captureId);
  assert.equal(persisted.owner_id, 'alice');
  assert.equal(persisted.block_id, 'b-shelf', 'matched 归属经 updateAttribution 落库');
  assert.equal(persisted.confidence, 0.9);
  // 双帧已入台账（等微任务排空）
  const deadline = Date.now() + 5000;
  while (db.prepare('SELECT COUNT(*) AS n FROM perception_events').get().n < 2) {
    if (Date.now() > deadline) assert.fail('emit 桥未把双帧写进 perception_events 台账');
    await new Promise(r => setTimeout(r, 10));
  }
  // SSE 迟连：纯重放历史（含终态 card.upgraded）→ 重放完 [DONE] 收流
  const sse = await fetch(`${origin}/api/captures/${captureId}/events`, { headers: { cookie: COOKIE } });
  assert.equal(sse.status, 200);
  const text = await sse.text();
  const frames = text.split('\n\n').filter(Boolean).map(c => c.replace(/^data: /, ''));
  assert.equal(frames[0].startsWith('{') ? JSON.parse(frames[0]).type : frames[0], 'card.created');
  assert.equal(JSON.parse(frames[1]).type, 'card.upgraded');
  assert.equal(frames[1].includes('夹固 15 分钟'), true);
  assert.equal(frames.at(-1), '[DONE]', '历史含终态：重放后即收流');

  // 缺 file 部件 → 400 file-required
  const noFile = await json(await postCapture(origin, buildMultipart('w12b', [{ name: 'note', value: 'hi' }]), multipartHeaders('w12b')));
  assert.equal(noFile.status, 400);
  assert.equal(noFile.body.error, 'file-required');

  // events 非 GET → 405；resolve 非 POST → 405
  assert.equal((await fetch(`${origin}/api/captures/${captureId}/events`, { method: 'POST', headers: { cookie: COOKIE } })).status, 405);
  assert.equal((await fetch(`${origin}/api/captures/${captureId}/resolve`, { headers: { cookie: COOKIE } })).status, 405);

  // pipeline.start 同步抛错 → 502（捕获已入库不炸进程）
  const bad = createPerceptionRoutes({
    auth, db, pipeline: { start: () => { throw new Error('boom'); } }, config: { dataDir, getBlocks: async () => [] },
  });
  const server2 = createServer((req, res) => { bad(req, res, new URL(req.url, 'http://localhost').pathname); });
  await new Promise(r => server2.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server2.close(r)); });
  const origin2 = `http://127.0.0.1:${server2.address().port}`;
  const boom = await json(await postCapture(origin2, buildMultipart('w12b', [{ name: 'file', filename: 'p2.jpg', contentType: 'image/jpeg', data: jpeg }]), multipartHeaders('w12b')));
  assert.equal(boom.status, 502);
  assert.equal(boom.body.error, 'pipeline-failed');
});

test('duration 钩子拒绝超长视频（≤60s 上限的可注入探测）', async t => {
  const dataDir = join(tmpdir(), `w12-routes-${randomUUID()}`);
  const store = fakeStore();
  const pipelineStarts = [];
  const auth = { authenticate: () => ({ id: 'alice' }) };
  const checkVideoDuration = async () => { throw new Error('video too long: 75s exceeds 60s cap'); };
  const routes = createPerceptionRoutes({ auth, store, pipeline: { start: i => pipelineStarts.push(i) }, config: { dataDir, getBlocks: async () => [], checkVideoDuration } });
  const server = createServer((req, res) => { routes(req, res, new URL(req.url, 'http://localhost').pathname); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = await json(await postCapture(origin, buildMultipart('w12b', [{ name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', data: MP4_BYTES }]), multipartHeaders('w12b')));
  assert.equal(out.status, 413, JSON.stringify(out.body));
  assert.equal(out.body.error, 'duration-rejected');
  assert.equal(pipelineStarts.length, 0, '超长视频不入队');
});

test('ambiguous 归属持久化候选（真实 store.updateAttribution 候选分支）', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const dataDir = join(tmpdir(), `w12-routes-${randomUUID()}`);
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const candidates = [{ blockId: 'b-a', title: '吃饭', kind: 'meal', confidence: 0.5 }, { blockId: 'b-b', title: '通勤', kind: 'errand', confidence: 0.5 }];
  const routes = createPerceptionRoutes({
    auth: { authenticate: () => ({ id: 'alice' }) },
    db,
    pipeline: { start: input => ({ captureId: input.captureId, attribution: { status: 'ambiguous', candidates } }) },
    config: { dataDir, getBlocks: async () => [] },
  });
  const server = createServer((req, res) => { routes(req, res, new URL(req.url, 'http://localhost').pathname); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10:26 18:10:00', withGps: false });
  const out = await json(await postCapture(origin, buildMultipart('w12b', [{ name: 'file', filename: 'p.jpg', contentType: 'image/jpeg', data: jpeg }]), multipartHeaders('w12b')));
  assert.equal(out.status, 202);
  assert.deepEqual(out.body.attribution.candidates, candidates, '202 回体带候选交用户裁决');
  const row = db.prepare('SELECT block_id, candidates FROM captures WHERE id = ?').get(out.body.captureId);
  assert.equal(row.block_id, null, '歧义未决不落 blockId');
  assert.deepEqual(JSON.parse(row.candidates), candidates, '候选已入库');
});

test('SSE 订阅-重放竞态：重放期间到达的实时帧入队补发，不丢不重', async t => {
  const f = await makeFixture(t);
  const jpeg = jpegWithExif({ dateTimeOriginal: '2026:10:26 19:05:00', withGps: false });
  const posted = await json(await postCapture(f.origin, buildMultipart('w12b', [{ name: 'file', filename: 'p.jpg', contentType: 'image/jpeg', data: jpeg }]), multipartHeaders('w12b')));
  const captureId = posted.body.captureId;
  const emit = f.pipelineStarts[0].emit;
  // 拖慢 listEvents：调用时同步取快照（此刻为空）再延迟返回——订阅后、重放完成前，
  // 实时帧只能进订阅队列，重放为空后由队列补发（真正覆盖竞态分支而非重放路径）
  const origList = f.store.listEvents.bind(f.store);
  f.store.listEvents = async (ownerId, id) => { const snapshot = origList(ownerId, id); await new Promise(r => setTimeout(r, 60)); return snapshot; };
  const sse = await fetch(`${f.origin}/api/captures/${captureId}/events`, { headers: { cookie: COOKIE } });
  await new Promise(r => setTimeout(r, 10)); // 确认已进入订阅态（重放尚未完成）
  await emit('card.created', { captureId, seen: '隔板已涂胶' });
  await emit('card.upgraded', { captureId, suggestion: '夹固 15 分钟' });
  const text = await sse.text();
  const frames = text.split('\n\n').filter(Boolean).map(c => c.replace(/^data: /, ''));
  const types = frames.filter(fr => fr !== '[DONE]').map(fr => JSON.parse(fr).type);
  assert.deepEqual(types, ['card.created', 'card.upgraded'], `队列补发顺序正确：${JSON.stringify(frames)}`);
  assert.equal(frames.at(-1), '[DONE]');
});

test('可注入 clock 与归属回退：config.now 生效、EXIF 时间非法走上传时间、无 attribution 回 none', async t => {
  const dataDir = join(tmpdir(), `w12-routes-${randomUUID()}`);
  const clockNow = '2026-10-26T11:00:00.000Z';
  const store = fakeStore();
  const routes = createPerceptionRoutes({
    auth: { authenticate: () => ({ id: 'alice' }) },
    store,
    pipeline: { start: input => ({ captureId: input.captureId }) }, // 无 attribution
    config: { dataDir, getBlocks: async () => [], now: () => clockNow },
  });
  const server = createServer((req, res) => { routes(req, res, new URL(req.url, 'http://localhost').pathname); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const jpeg = jpegWithExif({ dateTimeOriginal: 'not a date', withGps: false }); // EXIF 时间非法 → 上传时间兜底
  const out = await json(await postCapture(origin, buildMultipart('w12b', [{ name: 'file', filename: 'p.jpg', contentType: 'image/jpeg', data: jpeg }]), multipartHeaders('w12b')));
  assert.equal(out.status, 202);
  assert.deepEqual(out.body.attribution, { status: 'none', reason: 'unknown' }, '缺 attribution 时回退 none');
  const row = store.captures.get(out.body.captureId);
  assert.equal(row.uploadedAt, clockNow, '上传时间来自注入 clock');
  assert.equal(row.capturedAt, clockNow, 'EXIF 时间非法时拍摄时间回落上传时间');
  // 无 EXIF 的 JPEG（JFIF 无 APP1）+ 部件名不是 'file'（取第一个文件部件兜底）
  const plain = await json(await postCapture(origin, buildMultipart('w12b', [{ name: 'upload', filename: 'plain.jpg', contentType: 'image/jpeg', data: JPEG_BYTES }]), multipartHeaders('w12b')));
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  const plainRow = store.captures.get(plain.body.captureId);
  assert.equal(plainRow.capturedAt, clockNow, '无 EXIF → 上传时间');
  assert.equal(plainRow.exifStripped, true, 'JPEG 落盘副本保证无 GPS');
});
