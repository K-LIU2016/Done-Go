// S2D-W6 shared test helpers. NOT a test file (test-unit.mjs only collects *.test.*).
// RED stage: only W0 assets (db/index.mjs, contracts.mjs) are imported statically;
// the W6 modules under test are loaded dynamically inside each test so a missing
// implementation fails that test with ERR_MODULE_NOT_FOUND.
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { validate as validateWithSchema, loadSchema } from '../../../../scripts/agentic/contracts.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'scripts/agentic/db/migrations');
export const CONTRACTS_DIR = join(REPO_ROOT, 'contracts/agentic');

/** Canonical migrations dir for this stream; throws ENOENT until preview-*.sql exist. */
export function openMigratedDb() {
  const db = openAgenticDb(':memory:');
  migrate(db, MIGRATIONS_DIR);
  return db;
}

/** Deterministic injectable clock producing strictly increasing ISO timestamps. */
export function makeClock(startMs = Date.parse('2026-10-27T10:00:00Z'), stepMs = 1000) {
  let at = startMs;
  return () => new Date((at += stepMs)).toISOString();
}

/**
 * Rich, schema-valid Preview fixture (must pass the frozen preview.schema.json).
 * Mirrors PRD §10.3 sample shape with facts block keyed 来源范围 / 预计篇幅.
 */
export function makePreview(overrides = {}) {
  const preview = {
    missionId: 'm_golden',
    version: 1,
    confidence: 0.72,
    shape: {
      kind: 'report',
      title: '国内 K12 的 AI 教育现状',
      blocks: [
        {
          type: 'outline',
          items: [
            { h: '政策与标准', q: '2024–2026 有哪些 AI 教育要求？' },
            { h: '课堂实践', q: '初中阶段常见教学活动形态有哪些？' },
          ],
        },
        {
          type: 'facts',
          items: [
            { k: '来源范围', v: '公开网页与论文' },
            { k: '预计篇幅', v: '约 3000 字' },
          ],
        },
        { type: 'caveat', text: '无法访问付费数据库，改用公开来源' },
      ],
    },
    storyboard: [
      { at: '13:30', actor: 'researcher', text: '检索与筛选来源' },
      { at: '14:00', actor: 'you', text: '确认学员画像', need: 'n_1' },
      { at: '14:50', actor: 'writer', text: '合成报告' },
      { at: '15:00', actor: 'deliver', text: '研究报告交付' },
    ],
    narration: '下午一点半我先去找资料。两点前需要你确认受众。三点前你会拿到报告。我不会读你的邮箱。',
    boundary: {
      will: ['检索公开网页', '写研究报告'],
      wont: ['读邮箱', '付款'],
      needs: ['14:00 前确认学员画像'],
      budget: '约 40 次模型调用，全部免费模型',
    },
    samples: [
      {
        id: 's1',
        layout: 'slide-title-bullets-image',
        page: '第 2 课时 · 首页',
        text: { title: 'AI 进课堂 · 第 2 课时', bullets: ['用 AI 生成导入问题', '对照课标逐条核对'] },
        image: {
          prompt: '老师在教室用平板备课，扁平插画，无文字',
          model: 'z-image-turbo',
          url: '/api/media/s1.png',
          status: 'ready',
        },
        watermark: '示意',
      },
    ],
    reel: {
      composition: '/api/previews/m_golden/v1/reel.html',
      durationSec: 42,
      narrationAudio: '/api/previews/m_golden/v1/narration.mp3',
      mp4: null,
      tracks: [
        { at: '13:30', durationSec: 12, track: 'researcher' },
        { at: '13:42', durationSec: 30, track: 'you+writer' },
      ],
    },
    scene: { status: 'off', model: 'happyhorse-1.1-t2v', url: null },
  };
  return { ...preview, ...overrides };
}

/** Minimal valid Preview (L0 only, empty storyboard/samples) for quick chaining. */
export function makeMinimalPreview(missionId = 'm1', version = 1) {
  return makePreview({
    missionId,
    version,
    confidence: 0.5,
    shape: { kind: 'report', title: '速记', blocks: [{ type: 'facts', items: [{ k: '来源范围', v: '公开网页' }] }] },
    storyboard: [],
    narration: '一句话。',
    boundary: { will: ['检索'], wont: ['读邮箱'], needs: [], budget: '免费模型' },
    samples: [],
    reel: { composition: '/r', durationSec: 10, narrationAudio: '/n', mp4: null },
  });
}

/** Deep freeze so purity tests can prove a function does not mutate its input. */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    if (Array.isArray(value)) value.forEach(deepFreeze);
  }
  return value;
}

/* ---- minimal HTTP harness for createPreviewRoutes (req,res,pathname) ---- */

export function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    write(chunk) { if (chunk != null) this.chunks.push(Buffer.from(chunk)); },
    end(chunk) {
      if (chunk != null) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
    },
    get body() { return Buffer.concat(this.chunks).toString('utf8'); },
  };
}

export function makeReq(method, pathname, { body, headers, auth } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = { ...(headers ?? {}) };
  if (auth !== undefined) req.auth = auth;
  queueMicrotask(() => {
    if (body != null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** Call the route table; waits for res.end() when handled. */
export async function call(routes, method, pathname, options = {}) {
  const req = makeReq(method, pathname, options);
  const res = makeRes();
  const handled = routes(req, res, pathname);
  if (handled) {
    const deadline = Date.now() + 5000;
    while (!res.ended && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { handled, res, req };
}

export function bodyJson(res) { return JSON.parse(res.body); }

/** Validate a value against a frozen W0 schema (used for api-error envelope checks). */
export function checkWithSchema(value, schemaName) {
  const schema = loadSchema(schemaName, CONTRACTS_DIR);
  return validateWithSchema(value, schema, { schemaDir: CONTRACTS_DIR });
}
