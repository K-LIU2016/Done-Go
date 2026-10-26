// W12 现场感知 · HTTP 路由（BUILD-PLAN §2.1 L46 契约：导出 createPerceptionRoutes，
// 不挂 serve-tango.mjs，第 3 批 W13 统一挂载；测试自建 node:http harness）。
//   POST /api/captures            multipart 上传 → 校验（类型白名单/体积/登录）→ owner 私有
//                                 目录落盘（EXIF GPS 剥离、文件名不可信）→ 入队 pipeline →
//                                 202 {captureId, attribution}（归属结果/候选，BUILD-PLAN L141-142）
//   GET  /api/captures/:id/events SSE：先重放 store 台账再订阅实时帧（emit 桥接），终态事件
//                                 （card.upgraded/card.deep_failed/…）后发 data: [DONE] 并结束流；
//                                 帧写法仿 serve-tango.mjs:165-178（data: JSON\n\n + keepalive + unref）
//   POST /api/captures/:id/resolve 歧义裁决：仅 owner，拍板 blockId（store.resolveCapture）
// 未登录 401（仿 collaboration.authenticate 抛错 → 401，serve-tango.mjs:99）；跨 owner 一律
// 404 capture-not-found（不泄露存在性）。安全基线：auth 先于一切处理；上传文件名不参与
// 落盘路径（随机 id + 白名单扩展名）；ownerId 净化成单段目录名；请求体传输上限在读体前/中
// 双重拦截（413），不触盘。
'use strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseMultipart } from './multipart.mjs';
import { checkUpload, VIDEO_MAX_BYTES } from './media-guard.mjs';
import { readExif, parseExifDateTime, stripGps, stripPngExif, stripWebpExif } from './exif.mjs';
import { createPerceptionStore } from './store.mjs';

/** multipart 传输开销余量（边界/部件头）；整包上限 = maxVideoBytes + 余量。 */
const BODY_OVERHEAD_BYTES = 64 * 1024;
/** resolve 请求体上限（JSON {blockId}，4KB 足够）。 */
const RESOLVE_MAX_BYTES = 4096;
/** SSE keepalive 间隔（对齐 serve-tango.mjs:168）。 */
const KEEPALIVE_MS = 15000;
/** 终态事件：pipeline.run() 结束前 emit 的最后一种事件（pipeline.mjs L163-185）——
 *  SSE 收到即 [DONE] 收流。card.created/fast_failed/sensitive 是中间态，继续等。 */
const TERMINAL_EVENT_TYPES = new Set(['card.upgraded', 'card.deep_failed', 'card.pending', 'card.local_failed', 'card.error']);
/** 魔数格式 → 落盘扩展名（文件名不信任客户端，扩展名由白名单格式推导）。 */
const FORMAT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', heic: '.heic', mp4: '.mp4', webm: '.webm', mov: '.mov' };
const EXIF_DT_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** EXIF 原始串 → Asia/Shanghai 本地 ISO（'2026:10:26 19:05:00' → '2026-10-26T19:05:00+08:00'）；
 *  经 parseExifDateTime 校验（含日历合法性），非法返回 null 走上传时间兜底。 */
function exifLocalIso(raw) {
  if (parseExifDateTime(raw) === null) return null;
  const m = EXIF_DT_RE.exec(String(raw).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00` : null;
}

/** ownerId → 单段安全目录名（剥掉一切路径字符，'..' 也不可逃逸）。 */
const safeSegment = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * 建路由处理器。依赖全部注入（BUILD-PLAN L46）：
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} [deps.db] 传库则自建 store（W0 运行器前直连迁移）
 * @param {object} [deps.store] 持久层（store.mjs 契约）；与 db 二选一，store 优先
 * @param {{authenticate:(req)=>{id:string}}} deps.auth 鉴权（仿 collaboration.authenticate：抛错=401）
 * @param {{start:Function}} deps.pipeline 感知编排（pipeline.mjs）
 * @param {object} deps.config { dataDir, getBlocks(owner), maxVideoBytes, maxBodyBytes,
 *   checkVideoDuration(path)?, now()? }
 * @returns {(req,res,pathname)=>Promise<boolean>} 处理了返回 true，非本挂载路径返回 false
 */
export function createPerceptionRoutes({ db, auth, store, pipeline, config = {} } = {}) {
  if (!store) {
    if (!db) throw new Error('ROUTES_STORE_REQUIRED'); // store 或 db 必须给一个
    store = createPerceptionStore({ db });
  }
  if (!auth || typeof auth.authenticate !== 'function') throw new Error('ROUTES_AUTH_REQUIRED');
  if (!pipeline || typeof pipeline.start !== 'function') throw new Error('ROUTES_PIPELINE_REQUIRED');
  if (!config.dataDir) throw new Error('ROUTES_DATADIR_REQUIRED');

  const now = config.now || (() => new Date().toISOString());
  const maxVideoBytes = config.maxVideoBytes ?? VIDEO_MAX_BYTES;          // 视频 ≤60MB（BUILD-PLAN L141）
  const maxBodyBytes = config.maxBodyBytes ?? (maxVideoBytes + BODY_OVERHEAD_BYTES);

  // captureId → 开着的 SSE 订阅者集合；emit 桥接把 pipeline 事件写台账并广播到这里
  const liveSubs = new Map();
  const subsOf = captureId => {
    let set = liveSubs.get(captureId);
    if (!set) liveSubs.set(captureId, set = new Set());
    return set;
  };

  /** POST 时建 emit 桥：先落 perception_events 台账（SSE 断线可重放），再广播实时帧；
   *  终态事件后收流。台账失败不阻断推送（尽力而为，实时帧仍到）。 */
  const makeEmit = (captureId, ownerId) => async function emit(type, payload = {}) {
    let seq = null;
    try {
      const saved = await store.appendEvent({ captureId, ownerId, type, payload });
      if (saved && saved.seq !== undefined && saved.seq !== null) seq = saved.seq;
    } catch { /* 台账尽力而为 */ }
    const frame = { ...payload, type };
    if (seq !== null) frame.seq = seq;
    const set = liveSubs.get(captureId);
    if (!set || set.size === 0) return;
    const terminal = TERMINAL_EVENT_TYPES.has(type);
    for (const sub of [...set]) {
      try { sub(frame, terminal); } catch { set.delete(sub); }
    }
    if (terminal) liveSubs.delete(captureId);
  };

  const json = (res, status, obj) => {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  /** 鉴权（仿 collaboration.authenticate：auth 抛错 → 401，先于一切处理）。 */
  const authenticate = (req, res) => {
    try { return auth.authenticate(req); }
    catch { json(res, 401, { error: 'unauthorized' }); req.resume(); return null; }
  };

  async function handleCapture(req, res, user) {
    if (req.method !== 'POST') { json(res, 405, { error: 'method-rejected' }); req.resume(); return; }
    const contentType = req.headers['content-type'] || '';
    if (!/^multipart\/form-data/i.test(contentType)) { json(res, 415, { error: 'multipart-required' }); req.resume(); return; }
    // 传输上限：Content-Length 预检 + 流式累计双保险，超限不触盘（413）
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) { json(res, 413, { error: 'body-too-large' }); req.resume(); return; }
    const parts = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) { json(res, 413, { error: 'body-too-large' }); req.resume(); return; }
      parts.push(chunk);
    }
    let parsed;
    try { parsed = parseMultipart(Buffer.concat(parts), contentType, { maxBytes: maxBodyBytes }); }
    catch { json(res, 400, { error: 'multipart-invalid' }); return; }
    const file = parsed.files.find(f => f.name === 'file') || parsed.files[0];
    if (!file) { json(res, 400, { error: 'file-required' }); return; }
    let checked;
    try { checked = checkUpload({ data: file.data, filename: file.filename }); } // 魔数白名单+体积
    catch { json(res, 415, { error: 'media-rejected' }); return; }

    // ---- 时间与隐私：EXIF 拍摄时间（Asia/Shanghai）+ 元数据默认剥离（PRD §6.8.4 L517）----
    // 剥离按格式分派：jpeg=GPS IFD 清零；png=eXIf 块摘除；webp=EXIF 块摘除；
    // heic=元数据结构无法安全手剥 → 宁拒不存（privacy-first，待第 3 批接转码/专业工具后放开）。
    const uploadedAt = now();
    let capturedAt = uploadedAt;
    let exifStripped = false;
    let data = file.data;
    if (checked.kind === 'image' && checked.format === 'jpeg') {
      const exif = readExif(data);
      const local = exif && exif.dateTimeOriginal ? exifLocalIso(exif.dateTimeOriginal) : null;
      if (local) capturedAt = local;
      data = stripGps(data);
      exifStripped = true; // 落盘副本保证无 GPS（原本没有也视为已剥离）
    } else if (checked.kind === 'image' && checked.format === 'png') {
      data = stripPngExif(data);
      exifStripped = true;
    } else if (checked.kind === 'image' && checked.format === 'webp') {
      data = stripWebpExif(data);
      exifStripped = true;
    } else if (checked.kind === 'image' && checked.format === 'heic') {
      json(res, 415, { error: 'media-rejected', reason: 'heic-metadata-stripping-unavailable' });
      return;
    }

    // ---- 落盘：owner 私有目录 + 随机文件名（客户端文件名只用于校验，不进路径）----
    const captureId = 'cap_' + randomBytes(10).toString('hex');
    const ownerDir = join(config.dataDir, safeSegment(user.id));
    const storedPath = join(ownerDir, captureId + FORMAT_EXT[checked.format]);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(storedPath, data);
    if (checked.kind === 'video' && typeof config.checkVideoDuration === 'function') {
      // ≤60s 上限的显式探测是可注入钩子；默认不探测——时长由 pipeline 侧 frames.mjs
      // 的 fail-closed probe + ≤30s 同步界兜底（PRD L497），假件/无 ffprobe 环境不阻塞上传。
      try { await config.checkVideoDuration(storedPath); }
      catch { json(res, 413, { error: 'duration-rejected' }); return; }
    }

    // ---- 入库（先于 pipeline：真实库 perception_events 有 capture 外键）→ 入队 ----
    let blocks = [];
    if (typeof config.getBlocks === 'function') {
      try { blocks = await config.getBlocks(user) || []; } catch { blocks = []; } // 日程拿不到不拦上传
    }
    const row = await store.insertCapture({
      id: captureId, ownerId: user.id, kind: checked.kind,
      capturedAt, uploadedAt, storedPath,
      keepOriginal: false, exifStripped, status: 'processing',
    });
    const emit = makeEmit(row.id, user.id);
    let result;
    try {
      result = pipeline.start({ // routes 不 await done（双路流水线经 emit 桥接 SSE）
        captureId: row.id, ownerId: user.id, kind: checked.kind, path: storedPath,
        mimeType: checked.mime, capturedAt, uploadedAt, blocks, emit,
      });
    } catch { json(res, 502, { error: 'pipeline-failed' }); return; }
    if (typeof store.updateAttribution === 'function') { // 持久化归属结果/候选（真实 store 有，fake 可无）
      const a = result && result.attribution;
      if (a && a.status === 'matched') {
        try { store.updateAttribution(user.id, row.id, { blockId: a.blockId, confidence: a.confidence }); } catch { /* 尽力而为 */ }
      } else if (a && a.status === 'ambiguous') {
        try { store.updateAttribution(user.id, row.id, { blockId: null, confidence: null, candidates: a.candidates }); } catch { /* 尽力而为 */ }
      }
    }
    json(res, 202, { captureId: row.id, attribution: (result && result.attribution) || { status: 'none', reason: 'unknown' } });
  }

  const frameOf = e => {
    const frame = { ...((e && e.payload) || {}), type: e.type };
    if (e.seq !== undefined && e.seq !== null) frame.seq = e.seq;
    return frame;
  };

  async function handleEvents(req, res, user, captureId) {
    if (req.method !== 'GET') { json(res, 405, { error: 'method-rejected' }); req.resume(); return; }
    const capture = await store.getCapture(user.id, captureId);
    if (!capture) { json(res, 404, { error: 'capture-not-found' }); req.resume(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    // 先订阅再重放：重放期间到达的实时帧入队，按 seq 去重后补发（不丢帧也不重帧）
    let live = false;
    let closed = false;
    const queue = [];
    const writeFrame = frame => { if (!closed && !res.destroyed && res.writable) res.write('data: ' + JSON.stringify(frame) + '\n\n'); };
    const cleanup = () => { clearInterval(keepAlive); subs.delete(sub); };
    const finish = () => { // 终态：[DONE] + 收流（serve-tango.mjs:174 同款）
      if (closed) return;
      closed = true;
      cleanup();
      if (!res.destroyed && res.writable) res.write('data: [DONE]\n\n');
      res.end();
    };
    const sub = (frame, terminal) => {
      if (closed) return;
      if (!live) { queue.push([frame, terminal]); return; }
      writeFrame(frame);
      if (terminal) finish();
    };
    const subs = subsOf(captureId);
    subs.add(sub);
    const keepAlive = setInterval(() => { if (!res.destroyed && res.writable && !closed) res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
    keepAlive.unref?.();
    res.on('close', () => { closed = true; cleanup(); });
    // 重放台账（owner 过滤，seq 升序）
    const stored = await store.listEvents(user.id, captureId);
    const seen = new Set();
    for (const e of stored) {
      if (closed) return;
      writeFrame(frameOf(e));
      seen.add(e.seq);
      if (TERMINAL_EVENT_TYPES.has(e.type)) { finish(); return; } // 历史里已有终态：重放完即收流
    }
    for (const [frame, terminal] of queue) {
      if (closed) return;
      if (frame.seq !== undefined && seen.has(frame.seq)) continue;
      writeFrame(frame);
      if (terminal) { finish(); return; }
    }
    live = true; // 后续 emit 直写
  }

  async function handleResolve(req, res, user, captureId) {
    if (req.method !== 'POST') { json(res, 405, { error: 'method-rejected' }); req.resume(); return; }
    const capture = await store.getCapture(user.id, captureId);
    if (!capture) { json(res, 404, { error: 'capture-not-found' }); req.resume(); return; }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > RESOLVE_MAX_BYTES) { json(res, 413, { error: 'body-too-large' }); req.resume(); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > RESOLVE_MAX_BYTES) { json(res, 413, { error: 'body-too-large' }); req.resume(); return; }
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { json(res, 400, { error: 'invalid-input' }); return; }
    const blockId = input && typeof input === 'object' && !Array.isArray(input) ? input.blockId : null;
    if (typeof blockId !== 'string' || blockId.trim() === '') { json(res, 400, { error: 'invalid-input' }); return; }
    const updated = await store.resolveCapture(user.id, captureId, blockId);
    if (!updated) { json(res, 404, { error: 'capture-not-found' }); return; }
    json(res, 200, { capture: updated });
  }

  const EVENTS_RE = /^\/api\/captures\/([^/]+)\/events$/;
  const RESOLVE_RE = /^\/api\/captures\/([^/]+)\/resolve$/;

  return async function perceptionRoutes(req, res, pathname) {
    if (pathname === '/api/captures') {
      const user = authenticate(req, res);
      if (!user) return true;
      await handleCapture(req, res, user);
      return true;
    }
    let m = EVENTS_RE.exec(pathname);
    if (m) {
      const user = authenticate(req, res);
      if (!user) return true;
      await handleEvents(req, res, user, m[1]);
      return true;
    }
    m = RESOLVE_RE.exec(pathname);
    if (m) {
      const user = authenticate(req, res);
      if (!user) return true;
      await handleResolve(req, res, user, m[1]);
      return true;
    }
    return false; // 非本挂载路径（mount 契约）
  };
}
