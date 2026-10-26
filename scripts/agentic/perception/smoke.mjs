// W12 现场感知 · 真实冒烟台账（BUILD-PLAN §3 W12-6 L146、§2.3 L65、PRD §6.8.2 L499）：
// 4 输入（CTO 白板/木工样张 + 自造延误屏/冰箱）× 快/深双路，逐轮记录 模型/延迟/建议
// 原文，对照延迟目标 即时卡 ≤2000ms / 深建议 ≤8000ms；真实外部调用硬预算 ≤30 次，
// 预算将尽即刹车不超发；密钥只经注入 getter（env DONEGO_GATEWAY_KEY → W0
// gateway-key.mjs），绝不进台账/报告/日志。HTTP 冒烟走本流端口段 17651-17659，
// 用完即 close。单测全部注入假件（假模型推进注入 clock、':memory:' 库、环回
// 127.0.0.1），零真实外呼；CLI main() 才用真客户端。
'use strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { classifySensitive } from './sensitive.mjs';
import { createPerceptionPipeline } from './pipeline.mjs';
import { createFastVisionClient, createDeepVisionClient, createLocalVisionAdapter } from './vision.mjs';
import { readExif, parseExifDateTime } from './exif.mjs';
import { createPerceptionRoutes } from './routes.mjs';
import { createPerceptionStore } from './store.mjs';
import { gatewayKey } from '../gateway-key.mjs'; // W0 FROZEN v1：运行时读网关 key 的唯一入口

export const LATENCY_TARGETS = Object.freeze({ fastMs: 2000, deepMs: 8000 }); // PRD §6.8.2 L499
export const SMOKE_CALL_BUDGET = 30;      // BUILD-PLAN §2.3 L65：W12 视觉真实调用 ≤30 次
export const SMOKE_PORTS = Object.freeze([17651, 17652, 17653, 17654, 17655, 17656, 17657, 17658, 17659]);
export const CTO_SAMPLE_DIR = '/private/tmp/claude-501/-Users-chillbit-Proj-Done---Go/738f6e34-ed72-415c-a1cd-e7c6dd082ba2/scratchpad/media';
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const DEFAULT_EVIDENCE_PATH = '/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w12-smoke.md';

const SHANGHAI_OFFSET_MS = 8 * 3_600_000; // Asia/Shanghai 固定 +08:00（attribution.mjs 同款约定）
const isoShanghai = ms => new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+08:00');
const toMs = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + '+08:00');
  return Number.isNaN(ms) ? null : ms;
};
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const mimeOf = path => MIME_BY_EXT[String(path ?? '').toLowerCase().slice(String(path ?? '').lastIndexOf('.'))] || 'image/jpeg';
const EXIF_DT_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * 4 个冒烟输入（PRD §6.8.3 的四行场景，BUILD-PLAN L146 指定素材）：
 * CTO 实测样张 photo-whiteboard.jpg / photo-craft.jpg + 自造 延误屏/冰箱（how 记造法，
 * 生成脚本 make-smoke-fixtures.mjs，零外部调用）。每个输入带日程块模板（title/kind/note），
 * 由 blocksFor 按拍摄时间展开成窗口块。
 */
export function defaultSmokeInputs({ ctoDir = CTO_SAMPLE_DIR, fixtureDir = FIXTURES_DIR } = {}) {
  return [
    {
      id: 'whiteboard', source: 'cto', label: '白板（CTO 实测样张）',
      path: join(ctoDir, 'photo-whiteboard.jpg'),
      block: { title: '产品周会', kind: 'meeting', note: '对照白板：Q4 三个项目目标与上线进度' },
    },
    {
      id: 'craft', source: 'cto', label: '木书架进度（CTO 实测样张）',
      path: join(ctoDir, 'photo-craft.jpg'),
      block: { title: '做木书架', kind: 'craft', note: '按说明书组装；隔板上胶后需夹具固定 15 分钟' },
    },
    {
      id: 'delay-board', source: 'generated', label: '车站延误屏（自造）',
      path: join(fixtureDir, 'delay-board.png'),
      how: 'Playwright Chromium 本地渲染 HTML/CSS 车站到站屏（黑底大字「延误 25 分钟」）→ PNG 截图；零外部调用；生成脚本 scripts/agentic/perception/make-smoke-fixtures.mjs + 同目录 fixtures/delay-board.html',
      block: { title: '去吃饭（通勤）', kind: 'errand', note: '18:00 出发乘 K234 次，计划准点后步行去餐厅' },
    },
    {
      id: 'fridge', source: 'generated', label: '冰箱食材（自造）',
      path: join(fixtureDir, 'fridge.png'),
      how: 'Playwright Chromium 本地渲染 HTML/CSS 冰箱内部（隔板/番茄/鸡蛋/半颗洋葱，无牛肉）→ PNG 截图；零外部调用；生成脚本 scripts/agentic/perception/make-smoke-fixtures.mjs + 同目录 fixtures/fridge.html',
      block: { title: '做晚饭', kind: 'cooking', note: '计划番茄炒蛋；牛肉未买到，可能要换菜谱' },
    },
  ];
}

/**
 * 拍摄时间 → 场景窗口块：默认 [capturedAt−10min, capturedAt+110min]，归属落在核心
 * 窗口 → matched 0.9。时间不可解析抛错（prepare 已保证可解析，这里是防御）。
 */
export function blocksFor(input, capturedAt, { beforeMin = 10, afterMin = 110 } = {}) {
  const at = toMs(capturedAt);
  if (at === null) throw Object.assign(new Error(`SMOKE_TIME_UNPARSEABLE: ${capturedAt}`), { code: 'SMOKE_TIME_UNPARSEABLE' });
  return [{
    id: `blk-${input.id}`,
    title: input.block.title,
    kind: input.block.kind,
    start: isoShanghai(at - beforeMin * 60_000),
    end: isoShanghai(at + afterMin * 60_000),
  }];
}

/**
 * 备料一个输入：JPEG 读 EXIF 拍摄时间（Asia/Shanghai 本地 ISO，同 routes.mjs 规则），
 * 其余格式退回 now()。缺件抛 SMOKE_INPUT_MISSING（带 inputId）——真实冒烟先报缺件不瞎跑。
 */
export async function prepareSmokeInput(input, { now = () => new Date().toISOString() } = {}) {
  let buf;
  try {
    buf = await readFile(input.path);
  } catch (err) {
    throw Object.assign(new Error(`smoke input missing: ${input.id} (${input.path})`), { code: 'SMOKE_INPUT_MISSING', inputId: input.id, cause: err });
  }
  const lower = String(input.path).toLowerCase();
  let capturedAt = null;
  if ((lower.endsWith('.jpg') || lower.endsWith('.jpeg')) && buf[0] === 0xff && buf[1] === 0xd8) {
    const exif = readExif(buf);
    const raw = exif && exif.dateTimeOriginal;
    if (raw && parseExifDateTime(raw) !== null) {
      const m = EXIF_DT_RE.exec(String(raw).trim());
      if (m) capturedAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
    }
  }
  const exifCaptured = capturedAt !== null;
  if (!exifCaptured) capturedAt = now();
  return { ...input, capturedAt, exifCaptured };
}

/** pipeline 事件流 + done 结果 → 一行台账。快/深各取 {ok, model, ms, 输出, error}。 */
function buildRow({ prepared, round, captureId, attribution, events, done }) {
  const evOf = type => events.find(e => e.type === type);
  const pl = type => { const e = evOf(type); return e ? e.payload || {} : null; };
  const created = pl('card.created');
  const fastFailed = pl('card.fast_failed');
  const upgraded = pl('card.upgraded');
  const deepFailed = pl('card.deep_failed');
  const localFailed = pl('card.local_failed');
  const sensitiveEv = pl('card.sensitive');
  let fast = null;
  if (created) fast = { ok: true, model: created.model, ms: created.ms, seen: created.seen ?? null };
  else if (fastFailed) fast = { ok: false, error: String(fastFailed.error || 'fast-failed') };
  let deep = null;
  if (upgraded) {
    deep = {
      ok: true, model: upgraded.model, ms: upgraded.ms,
      seen: upgraded.seen ?? null, change: upgraded.change ?? null, risk: upgraded.risk ?? null,
      suggestion: upgraded.suggestion ?? null,
      actions: Array.isArray(upgraded.actions) ? upgraded.actions : [],
    };
  } else if (deepFailed) deep = { ok: false, error: String(deepFailed.error || 'deep-failed') };
  else if (localFailed) deep = { ok: false, local: true, error: String(localFailed.error || 'local-failed') };
  const card = done && done.card ? done.card : null;
  return {
    input: prepared.id, label: prepared.label, source: prepared.source, path: prepared.path, how: prepared.how ?? null,
    round, captureId, capturedAt: prepared.capturedAt, exifCaptured: !!prepared.exifCaptured,
    attribution,
    blockId: attribution && attribution.status === 'matched' ? attribution.blockId : null,
    status: done && done.status ? done.status : 'unknown',
    error: done && done.error ? String(done.error) : null,
    localOnly: !!(sensitiveEv || (done && done.status === 'local-only')),
    sensitive: sensitiveEv ? sensitiveEv.category : null,
    fast, deep,
    contextDelta: card && card.contextDelta ? card.contextDelta : null,
    suggestionCard: card && card.suggestionCard ? card.suggestionCard : null,
  };
}

/**
 * 跑冒烟台账。inputs × repeat 轮，每轮一次完整双路（快+深各 1 次真实调用预算）；
 * 预算将尽（已用 + 2 > budget）立即刹车。所有依赖注入；单测传假模型 + 注入 clock。
 * @returns {{rows:Array, missing:Array, realCalls:number, calls:{fast:number,deep:number}, budgetExhausted:boolean}}
 */
export async function runSmoke({
  inputs = defaultSmokeInputs(),
  fast = createFastVisionClient(),
  deep = createDeepVisionClient(),
  repeat = 2,
  budget = SMOKE_CALL_BUDGET,
  classifySensitive: classify = classifySensitive,
  local = createLocalVisionAdapter({}),
  clock = { now: () => Date.now() },
  prepare = prepareSmokeInput,
} = {}) {
  const rows = [];
  const missing = [];
  const calls = { fast: 0, deep: 0 };
  const counted = (client, lane) => ({ model: client.model, analyze: async args => { calls[lane]++; return client.analyze(args); } });
  const pipeline = createPerceptionPipeline({
    fast: counted(fast, 'fast'), deep: counted(deep, 'deep'), local, classifySensitive: classify, clock,
  });
  let budgetExhausted = false;
  outer:
  for (const input of inputs) {
    let prepared;
    try {
      prepared = await prepare(input);
    } catch (err) {
      missing.push({ input: input.id, code: (err && err.code) || 'SMOKE_PREPARE_FAILED', error: String((err && err.message) || err) });
      continue;
    }
    const blocks = blocksFor(prepared, prepared.capturedAt);
    for (let round = 1; round <= repeat; round++) {
      if (calls.fast + calls.deep + 2 > budget) { budgetExhausted = true; break outer; } // 快+深最坏 2 次：预算不够就停
      const captureId = `cap_smoke_${prepared.id}_${round}_${randomBytes(3).toString('hex')}`;
      const events = [];
      const started = pipeline.start({
        captureId, ownerId: 'smoke', kind: 'image', path: prepared.path,
        mimeType: mimeOf(prepared.path), capturedAt: prepared.capturedAt, uploadedAt: prepared.capturedAt,
        blocks, emit: (type, payload) => events.push({ type, payload }),
      });
      const done = await started.done; // done 永不 reject（pipeline 契约）
      rows.push(buildRow({ prepared, round, captureId, attribution: started.attribution, events, done }));
    }
  }
  return { rows, missing, realCalls: calls.fast + calls.deep, calls: { fast: calls.fast, deep: calls.deep }, budgetExhausted };
}

const median = sorted => (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
const stat = samples => (samples.length
  ? { min: Math.min(...samples), median: median([...samples].sort((a, b) => a - b)), max: Math.max(...samples) }
  : { min: null, median: null, max: null });
const verdictOf = (samples, targetMs) => (samples.length ? (median([...samples].sort((a, b) => a - b)) <= targetMs ? 'ok' : 'over') : 'no-data');

/**
 * 台账 → 汇总：每输入快/深延迟 min/median/max + 对照目标判 ok/over/no-data（PRD L499）；
 * 建议质量启发式（usable = seen/suggestion 非空 + 动作 ≥1，原文在 rows 供人工复核）。
 */
export function summarizeLedger(rows = []) {
  const byInput = new Map();
  for (const row of rows) {
    if (!byInput.has(row.input)) byInput.set(row.input, []);
    byInput.get(row.input).push(row);
  }
  const perInput = [];
  for (const [id, list] of byInput) {
    const fastSamples = list.filter(r => r.fast && r.fast.ok).map(r => r.fast.ms);
    const deepSamples = list.filter(r => r.deep && r.deep.ok).map(r => r.deep.ms);
    const deepRow = list.find(r => r.deep && r.deep.ok) || null;
    const fastRow = list.find(r => r.fast && r.fast.ok) || null;
    const statusCounts = {};
    for (const r of list) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    perInput.push({
      id,
      label: list[0].label ?? id,
      rounds: list.length,
      fast: { ms: stat(fastSamples), targetMs: LATENCY_TARGETS.fastMs, verdict: verdictOf(fastSamples, LATENCY_TARGETS.fastMs) },
      deep: { ms: stat(deepSamples), targetMs: LATENCY_TARGETS.deepMs, verdict: verdictOf(deepSamples, LATENCY_TARGETS.deepMs) },
      statusCounts,
      quality: {
        usableFast: !!(fastRow && fastRow.fast.seen && String(fastRow.fast.seen).trim()),
        usableDeep: !!(deepRow && deepRow.deep.seen && String(deepRow.deep.seen).trim() && deepRow.deep.suggestion && String(deepRow.deep.suggestion).trim() && Array.isArray(deepRow.deep.actions) && deepRow.deep.actions.length >= 1),
        seenChars: deepRow && deepRow.deep.seen ? String(deepRow.deep.seen).length : 0,
        suggestionChars: deepRow && deepRow.deep.suggestion ? String(deepRow.deep.suggestion).length : 0,
        actionCount: deepRow && Array.isArray(deepRow.deep.actions) ? deepRow.deep.actions.length : 0,
      },
    });
  }
  return {
    perInput,
    totals: {
      cases: rows.length,
      fastOk: rows.filter(r => r.fast && r.fast.ok).length,
      deepOk: rows.filter(r => r.deep && r.deep.ok).length,
    },
  };
}

const j = value => JSON.stringify(value, null, 0);

/** 台账 + 汇总 + meta → 冒烟证据 markdown（含目标对照、逐轮明细与建议原文、来源/造法、配额行）。 */
export function renderSmokeReport({ rows = [], summary, meta = {} } = {}) {
  const s = summary || summarizeLedger(rows);
  const budget = meta.budget ?? SMOKE_CALL_BUDGET;
  const lines = [];
  lines.push('# S2D W12 现场感知 · 真实冒烟台账（evidence/s2d-w12-smoke.md）', '');
  lines.push(`- 日期：${meta.date ?? 'n/a'} · 分支：${meta.branch ?? 'n/a'} · Node ${meta.node ?? process.version}`);
  lines.push(`- 延迟目标（PRD §6.8.2 L499）：即时卡（快 qwen3.5-omni-flash）≤ ${LATENCY_TARGETS.fastMs} ms；深度建议（深 qwen3-vl-plus）≤ ${LATENCY_TARGETS.deepMs} ms`);
  lines.push(`- 真实视觉调用配额：${meta.realCalls ?? 0} / ${budget}（BUILD-PLAN §2.3 L65，预算将尽自动刹车：${meta.budgetExhausted ? '已触发' : '未触发'}）`);
  lines.push(`- 密钥：经注入 getter 运行时读取（env DONEGO_GATEWAY_KEY → W0 gateway-key.mjs），不进本报告。`);
  lines.push('');
  lines.push('## 输入与来源（4 输入，BUILD-PLAN L146）', '');
  lines.push('| id | 场景块 | 来源 | 路径 | 造法/说明 |');
  lines.push('|---|---|---|---|---|');
  for (const input of meta.inputs || []) {
    lines.push(`| ${input.id} | ${input.block.title}（${input.block.kind}） | ${input.source === 'cto' ? 'CTO 实测样张' : '自造'} | \`${input.path}\` | ${input.how ?? (input.source === 'cto' ? 'CTO 拍摄实测样张' : '')} |`);
  }
  lines.push('');
  lines.push('## 延迟对照（min / median / max，单位 ms；判定 ≤ 目标即 ok）', '');
  lines.push('| 输入 | 快（目标 ≤2000） | 快判定 | 深（目标 ≤8000） | 深判定 | 状态计数 |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of s.perInput) {
    const fmt = st => (st.median === null ? '—' : `${st.min} / ${st.median} / ${st.max}`);
    lines.push(`| ${p.id} | ${fmt(p.fast.ms)} | ${p.fast.verdict} | ${fmt(p.deep.ms)} | ${p.deep.verdict} | ${j(p.statusCounts)} |`);
  }
  lines.push('');
  lines.push(`总计：${s.totals.cases} 轮，快路成功 ${s.totals.fastOk}，深路成功 ${s.totals.deepOk}。`, '');
  lines.push('## 逐轮明细（模型 / 延迟 / 输出原文——建议质量的原始材料）', '');
  for (const row of rows) {
    lines.push(`### ${row.input}（${row.label}）· 第 ${row.round} 轮 · ${row.status}${row.localOnly ? ' · localOnly' : ''}`);
    const attr = row.attribution && row.attribution.status ? `${row.attribution.status}${row.attribution.blockId ? ` → ${row.attribution.blockId}` : ''}${row.attribution.confidence !== undefined && row.attribution.confidence !== null ? `（置信度 ${row.attribution.confidence}）` : ''}` : 'n/a';
    lines.push(`- 归属：${attr} · 拍摄时间 ${row.capturedAt}（${row.exifCaptured ? 'EXIF' : '上传时间兜底'}）`);
    if (row.fast) {
      lines.push(row.fast.ok
        ? `- 快 ${row.fast.model}：${row.fast.ms} ms · seen：${row.fast.seen ?? '—'}`
        : `- 快 失败：${row.fast.error}`);
    } else lines.push('- 快：未发生');
    if (row.deep) {
      lines.push(row.deep.ok
        ? `- 深 ${row.deep.model}：${row.deep.ms} ms · seen：${row.deep.seen ?? '—'}`
        + `\n  - change：${row.deep.change ?? 'null'} · risk：${row.deep.risk ?? 'null'}`
        + `\n  - suggestion：${row.deep.suggestion ?? 'null'}`
        + `\n  - actions：${j(row.deep.actions)}`
        : `- 深 失败：${row.deep.error}`);
    } else lines.push('- 深：未发生（敏感/预算路径）');
    if (row.contextDelta) lines.push(`- ContextDelta：${j(row.contextDelta)}`);
    if (row.suggestionCard) lines.push(`- 建议卡：${j(row.suggestionCard)}`);
    lines.push('');
  }
  lines.push('## 建议质量（启发式：seen/suggestion 非空 + 动作 ≥1 = usable；原文见上）', '');
  lines.push('| 输入 | 快卡可用 | 深卡可用 | 建议字数 | 动作数 |');
  lines.push('|---|---|---|---|---|');
  for (const p of s.perInput) lines.push(`| ${p.id} | ${p.quality.usableFast} | ${p.quality.usableDeep} | ${p.quality.suggestionChars} | ${p.quality.actionCount} |`);
  lines.push('');
  if (meta.e2e) {
    lines.push('## 端到端（POST /api/captures → SSE 卡片事件，真实 routes/store/pipeline）', '');
    lines.push(`- HTTP ${meta.e2e.status} · captureId ${meta.e2e.captureId ?? '—'} · 归属 ${meta.e2e.attribution ? j(meta.e2e.attribution) : '—'}`);
    lines.push(`- 帧序列：${j((meta.e2e.frames || []).map(f => f.type))}`);
    const t = meta.e2e.timings || {};
    lines.push(`- 计时：上传 202 回包 ${t.uploadMs ?? '—'} ms → 首张即时卡 ${t.firstCardMs ?? '—'} ms → 深卡升级 ${t.upgradedMs ?? '—'} ms（自 POST 起）`);
    lines.push('');
  }
  if (meta.missing && meta.missing.length) {
    lines.push('## 缺件（未跑，如实记录）', '');
    for (const m of meta.missing) lines.push(`- ${m.input}：${m.code}（${m.error}）`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 冒烟 key getter：env DONEGO_GATEWAY_KEY 优先（W0 交付前注入口径），否则 W0
 * gateway-key.mjs 运行时读 ~/.config/llm-gateway/endpoint.json。绝不打印/落盘 key。
 */
export function createSmokeKeyGetter({ env = process.env, fallback = gatewayKey } = {}) {
  return () => {
    const fromEnv = env && env.DONEGO_GATEWAY_KEY;
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
    return fallback();
  };
}

/** 客户端侧最小 multipart 构造（POST /api/captures 用；服务端 parseMultipart 可原样解出）。 */
export function buildCaptureMultipart({ filename, contentType = 'image/jpeg', data, boundary } = {}) {
  const b = boundary || 'w12smoke' + randomBytes(6).toString('hex');
  const head = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from(`\r\n--${b}--\r\n`, 'utf8')]);
  return { body, contentType: `multipart/form-data; boundary=${b}` };
}

/**
 * 环回 HTTP 冒烟 harness：真实 createPerceptionRoutes + 传入 store/pipeline，绑本流
 * 端口段 17651-17659 的第一个空闲口（全忙抛 SMOKE_PORT_RANGE_EXHAUSTED），close() 即还。
 */
export async function createSmokeHarness({ store, auth, pipeline, dataDir, getBlocks, ports = SMOKE_PORTS } = {}) {
  const routes = createPerceptionRoutes({ store, auth, pipeline, config: { dataDir, getBlocks } });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    routes(req, res, pathname)
      .then(handled => { if (!handled && !res.writableEnded) res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'route-not-found' })); })
      .catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'smoke-harness-error' })); });
  });
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err; // 只容忍占用，换下一个口
    }
  }
  if (!server.listening) throw Object.assign(new Error(`SMOKE_PORT_RANGE_EXHAUSTED: ${ports[0]}-${ports[ports.length - 1]}`), { code: 'SMOKE_PORT_RANGE_EXHAUSTED' });
  return {
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`,
    // closeIdleConnections 先收割客户端 keep-alive 空闲连接，否则 close 回调要等
    // fetch 连接池超时才触发（用完即还端口，BUILD-PLAN §2.3 L63）。
    close: () => new Promise(resolve => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** 解析 SSE 流（web ReadableStream 或 Node async-iterable），data: [DONE] 或超时终止；
 *  返回前释放 reader（不读到底也不断流的话，socket 会一直挂着不还）。 */
async function readSse(stream, onData, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  const handle = () => {
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue; // keepalive（: 开头）与杂行跳过
        const payload = line.slice(6);
        if (payload === '[DONE]') return true;
        try { onData(JSON.parse(payload)); } catch { /* 非帧数据尽力而为 */ }
      }
    }
    return false;
  };
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error('smoke-sse-timeout');
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (handle()) return;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } else if (stream) {
    for await (const value of stream) {
      if (Date.now() > deadline) throw new Error('smoke-sse-timeout');
      buf += Buffer.from(value).toString('utf8');
      if (handle()) return;
    }
  }
}

/**
 * 一次真实端到端冒烟：multipart POST /api/captures → 202 → 订阅 SSE 直到 [DONE]。
 * 计时（自 POST 起）：uploadMs=202 回包、firstCardMs=首张即时卡、upgradedMs=深卡终态。
 */
export async function smokeCaptureOverHttp({ origin, imagePath, token = 'smoke-user', fetchImpl = globalThis.fetch, now = () => Date.now(), sseTimeoutMs = 90_000 } = {}) {
  const data = await readFile(imagePath);
  const { body, contentType } = buildCaptureMultipart({ filename: basename(imagePath), contentType: mimeOf(imagePath), data });
  const t0 = now();
  const res = await fetchImpl(`${origin}/api/captures`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body });
  const accepted = await res.json().catch(() => ({}));
  const tUpload = now();
  if (res.status !== 202) return { status: res.status, error: accepted, frames: [], timings: { uploadMs: tUpload - t0, firstCardMs: null, upgradedMs: null } };
  const sse = await fetchImpl(`${origin}/api/captures/${accepted.captureId}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  const frames = [];
  let tFirst = null;
  let tTerminal = null;
  const TERMINALS = new Set(['card.upgraded', 'card.deep_failed', 'card.pending', 'card.local_failed', 'card.error']);
  await readSse(sse.body, frame => {
    frames.push(frame);
    if (frame.type === 'card.created' && tFirst === null) tFirst = now();
    if (TERMINALS.has(frame.type) && tTerminal === null) tTerminal = now();
  }, sseTimeoutMs);
  return {
    status: 202,
    captureId: accepted.captureId ?? null,
    attribution: accepted.attribution ?? null,
    frames,
    timings: {
      uploadMs: tUpload - t0,
      firstCardMs: tFirst !== null ? tFirst - t0 : null,
      upgradedMs: tTerminal !== null ? tTerminal - t0 : null,
    },
  };
}

// ---- CLI（真实冒烟入口；单测覆盖以上纯逻辑，main 只做装配与落盘）----

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs({
    args: argv,
    options: {
      repeat: { type: 'string', short: 'r', default: '2' },
      out: { type: 'string', default: DEFAULT_EVIDENCE_PATH },
      'no-e2e': { type: 'boolean', default: false },
    },
  });
  const repeat = Math.max(1, Math.min(8, Number(opts.values.repeat) || 2));
  const getKey = createSmokeKeyGetter();
  const fast = createFastVisionClient({ getKey });
  const deep = createDeepVisionClient({ getKey });
  const inputs = defaultSmokeInputs();

  const out = await runSmoke({ inputs, fast, deep, repeat });
  console.log(`[smoke] pipeline 台账：${out.rows.length} 轮 · 真实调用 ${out.realCalls}/${SMOKE_CALL_BUDGET}${out.budgetExhausted ? '（预算刹车）' : ''}${out.missing.length ? ` · 缺件 ${out.missing.map(m => m.input).join(',')}` : ''}`);

  let e2e = null;
  if (!opts.values['no-e2e'] && out.realCalls + 2 <= SMOKE_CALL_BUDGET) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const store = createPerceptionStore({ db });
    let e2eCalls = 0;
    const countedE2e = c => ({ model: c.model, analyze: async a => { e2eCalls++; return c.analyze(a); } });
    const pipeline = createPerceptionPipeline({ fast: countedE2e(fast), deep: countedE2e(deep) });
    const dataDir = await mkdtemp(join(tmpdir(), 'w12-smoke-e2e-'));
    const auth = {
      authenticate(req) {
        if (req.headers.authorization === 'Bearer smoke-user') return { id: 'smoke-owner' };
        const e = new Error('unauthorized'); e.status = 401; throw e;
      },
    };
    const prepared = await prepareSmokeInput(inputs[0]);
    const h = await createSmokeHarness({ store, auth, pipeline, dataDir, getBlocks: async () => blocksFor(prepared, prepared.capturedAt) });
    try {
      e2e = await smokeCaptureOverHttp({ origin: h.origin, imagePath: prepared.path, token: 'smoke-user' });
      e2e.realCalls = e2eCalls;
      out.realCalls += e2eCalls;
      console.log(`[smoke] e2e：端口 ${h.port} · 帧序列 ${e2e.frames.map(f => f.type).join(' → ')} · 上传 ${e2e.timings.uploadMs}ms / 首卡 ${e2e.timings.firstCardMs}ms / 升级 ${e2e.timings.upgradedMs}ms`);
    } finally {
      await h.close();
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  } else if (!opts.values['no-e2e']) {
    console.log('[smoke] e2e 跳过：剩余预算不足 2 次调用');
  }

  const summary = summarizeLedger(out.rows);
  const md = renderSmokeReport({
    rows: out.rows,
    summary,
    meta: {
      date: new Date().toISOString(),
      branch: 'feat/s2d-w12-perception',
      node: process.version,
      inputs,
      realCalls: out.realCalls,
      budget: SMOKE_CALL_BUDGET,
      budgetExhausted: out.budgetExhausted,
      e2e,
      missing: out.missing,
    },
  });
  await mkdir(dirname(opts.values.out), { recursive: true });
  await writeFile(opts.values.out, md);
  for (const p of summary.perInput) {
    console.log(`[smoke] ${p.id}: 快 ${p.fast.verdict}${p.fast.ms.median !== null ? `(${p.fast.ms.median}ms)` : ''} · 深 ${p.deep.verdict}${p.deep.ms.median !== null ? `(${p.deep.ms.median}ms)` : ''} · 建议 ${p.quality.usableDeep ? '可用' : '不可用'}`);
  }
  console.log(`[smoke] 报告已写入 ${opts.values.out}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('[smoke] fatal:', (err && err.code) || (err && err.message) || err);
    process.exit(1);
  });
}
