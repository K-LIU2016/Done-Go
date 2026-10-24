// scripts/voice-lab.mjs — V8 · 语音实验室独立开发入口（D2）。
// 职责：import createTangoServer（不改 serve-tango.mjs）获得 web/ 静态与既有 API，
//       外层挂 /api/voice/intent（HTTP）与 /api/voice/stream（WebSocket upgrade），
//       把 V1–V7 端到端串起来；V6 voice-gateway.mjs / V7 intent.mjs 未合入时用内置
//       demo 兜底（合成文本帧 + 原型演示数据），并在 /api/voice/lab-status 如实标注。
// 唯一标准：design/voice-intent/SPEC.md §2.2（WS 协议/限额/错误码）、§2.3（intent IO）。
// 红线：不落盘音频（demo 只合成文本帧）；ws 是唯一授权新依赖（--no-save 装于 node_modules）。
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createTangoServer } from './serve-tango.mjs';
import { validateClientMessage, validateIntentInput, validateIntentOutput } from '../web/voice/contracts.js';

export const VOICE_WS_PATH = '/api/voice/stream';
export const VOICE_INTENT_PATH = '/api/voice/intent';
export const VOICE_LAB_STATUS_PATH = '/api/voice/lab-status';
export const VOICE_LAB_PORT_DEFAULT = 17550; // 任务授权的临时实例端口段 17550–17559 之首选
export const MAX_INTENT_BYTES = 64 * 1024;
const INTENT_TIMEOUT_MS = 6000; // SPEC §2.3：LLM 总时长 6 秒（规则先行与降级由 V7 内部处理；lab 只透传）

// —— 演示脚本（原型 ① 屏例句；demo 网关按此推流，纯文本帧，不涉及任何音频）——
export const DEMO_SEGMENTS = Object.freeze([
  { partials: ['明天下午三点要跟', '明天下午三点要跟导师开'], final: '明天下午三点要跟导师开组会，必须把实验数据先整理好。' },
  { partials: ['还有周五前'], final: '还有周五前交课程报告，' },
  { partials: ['晚上有空', '晚上有空的话去'], final: '晚上有空的话去跑个步' },
].map(Object.freeze));

const sleep = (ms, signal) => new Promise((resolveSleep, rejectSleep) => {
  const timer = setTimeout(() => resolveSleep(), ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); rejectSleep(Object.assign(new Error('aborted'), { code: 'aborted' })); }, { once: true });
});

// —— tz 感知的日期工具（demo intent 的相对日期以请求的 now/tz 为准，SPEC §2.3-2）——
function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function weekdayIndex(date, tz) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}
export function demoRelativeDates(nowIso, tz) {
  const base = new Date(nowIso); // 评测/演示时区 Asia/Shanghai 无夏令时，固定 86400e3 位移安全
  const day = (offset) => ymdInTz(new Date(base.getTime() + offset * 86400000), tz);
  const daysToFriday = (5 - weekdayIndex(base, tz) + 7) % 7; // 周一为一周之始；本周五已过取下周五（原型：周日说「周五」= 10-30）
  return { today: day(0), tomorrow: day(1), thisFriday: day(daysToFriday) };
}

// —— V7 缺席时的演示意图引擎：演示句返回原型 ③ 屏 4 件事；其他转写 → 单事项默认「一般」 ——
export function createDemoIntentEngine(options = {}) {
  const delayMs = options.delayMs ?? 800;
  return {
    name: 'lab-demo',
    mode: 'demo',
    async parse(input, signal) {
      if (delayMs > 0) await sleep(delayMs, signal);
      if (input.transcript.includes('组会')) {
        const d = demoRelativeDates(input.now, input.tz);
        return {
          nonEvent: null,
          items: [
            { title: '整理实验数据', kind: 'necessary', date: null, start: null, end: null, durationMin: null, deadline: d.tomorrow, timeText: '明天下午三点', vague: false, recurrence: null, priority: 1, priorityReason: '你说「必须」，且要赶在组会前', confidence: 0.9, source: '必须把实验数据先整理好' },
            { title: '和导师开组会', kind: 'necessary', date: d.tomorrow, start: '15:00', end: '16:00', durationMin: null, deadline: null, timeText: '明天下午三点', vague: false, recurrence: null, priority: 2, priorityReason: '和导师有约，时间已定', confidence: 0.92, source: '要跟导师开组会' },
            { title: '交课程报告', kind: 'create', date: null, start: null, end: null, durationMin: null, deadline: d.thisFriday, timeText: '周五前', vague: false, recurrence: null, priority: 2, priorityReason: '有明确截止日', confidence: 0.88, source: '周五前交课程报告' },
            { title: '跑步', kind: 'restore', date: d.today, start: null, end: null, durationMin: null, deadline: null, timeText: '晚上有空的话', vague: true, recurrence: null, priority: 5, priorityReason: '你说「有空的话」', confidence: 0.85, source: '晚上有空的话去跑个步' },
          ],
        };
      }
      const title = Array.from(input.transcript.replace(/\s+/g, '')).slice(0, 20).join('');
      return {
        nonEvent: null,
        items: [{ title, kind: 'create', date: null, start: null, end: null, durationMin: null, deadline: null, timeText: null, vague: true, recurrence: null, priority: 3, priorityReason: null, confidence: 0.4, source: null }],
      };
    },
  };
}

// —— V6 缺席时的演示网关：完整实现 contracts WS 协议，但推的是合成文本帧（无音频）——
// 客户端 start → 按 DEMO_SEGMENTS 节奏推 partial/final；stop → 未定稿句立即 final → end；
// 坏消息 → error bad-message；60 秒不发 stop → error session-too-long；二进制帧一律忽略。
export function createDemoVoiceGateway(options = {}) {
  const paceMs = options.paceMs ?? 350;
  const sessionLimitMs = options.sessionLimitMs ?? 60000;
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  wss.on('connection', (ws) => {
    let queue = null, timer = null, lastSeg = -1, lastWasFinal = true, ended = false;
    const hardStop = setTimeout(() => finish('session-too-long'), sessionLimitMs);
    hardStop.unref?.();
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    function pump() {
      if (!queue || !queue.length) { queue = null; return; } // 推完即静默，等 stop（前端的静音 2s 检测会发）
      const frame = queue.shift();
      lastSeg = frame.seg;
      lastWasFinal = frame.type === 'final';
      send(frame);
      timer = setTimeout(pump, paceMs);
    }
    function finish(errorCode) {
      if (ended) return;
      ended = true;
      clearTimeout(timer); clearTimeout(hardStop); clients.delete(ws);
      if (errorCode) { send({ type: 'error', code: errorCode }); ws.close(); return; } // close() 会先 flush 缓冲的 error 帧
      if (!lastWasFinal && lastSeg >= 0) send({ type: 'final', seg: lastSeg, text: DEMO_SEGMENTS[lastSeg].final }); // stop 把当前灰字定稿
      send({ type: 'end' });
      // end 之后由客户端关闭（SPEC 协议语义）；2 秒兜底防挂起的连接占用并发额度
      const closeTimer = setTimeout(() => ws.terminate(), 2000);
      closeTimer.unref?.();
    }
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // demo 不消费 PCM；转发上游是真实网关（V6）的职责
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return finish('bad-message'); }
      const checked = validateClientMessage(msg);
      if (!checked.ok) return finish('bad-message');
      if (checked.value.type === 'start') {
        if (queue) return; // 重复 start 幂等忽略
        queue = DEMO_SEGMENTS.flatMap((seg, i) => [...seg.partials.map((text) => ({ type: 'partial', seg: i, text })), { type: 'final', seg: i, text: seg.final }]);
        pump();
      } else finish(); // stop
    });
    ws.on('close', () => { clearTimeout(timer); clearTimeout(hardStop); clients.delete(ws); });
    clients.add(ws);
  });
  return {
    name: 'lab-demo',
    mode: 'demo',
    handleUpgrade(req, socket, head) { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); },
    close() { for (const ws of clients) ws.terminate(); return new Promise((resolveClose) => wss.close(() => resolveClose())); },
  };
}

// —— V6/V7 模块探测：命中真实模块就用，缺席/形状不符自动降级 demo（lab-status 如实报告）——
// lab 是本地开发入口（bind 127.0.0.1）：V5 网关的鉴权在这里放行为 demo actor，
// 真实会话鉴权由二期接入 serve-tango collaboration 时恢复（SPEC §2.2 鉴权）。
const GATEWAY_FACTORY_NAMES = ['createVoiceGateway', 'createGateway', 'attachVoiceGateway'];
const INTENT_FUNCTION_NAMES = ['parseIntent', 'interpretIntent', 'analyzeIntent'];
function pickExport(mod, names) { for (const name of names) if (typeof mod[name] === 'function') return mod[name]; return null; }

export async function loadVoiceModules(options = {}) {
  const demoGateway = options.demoGateway || createDemoVoiceGateway();
  const demoIntent = options.demoIntent || createDemoIntentEngine();
  const result = { gateway: { mode: 'demo', name: demoGateway.name, gateway: demoGateway }, intent: { mode: 'demo', name: demoIntent.name, engine: demoIntent } };
  try {
    const mod = await import('./voice-gateway.mjs'); // V5/V6 网关
    const factory = pickExport(mod, GATEWAY_FACTORY_NAMES);
    const instance = factory ? factory({
      path: VOICE_WS_PATH,
      asrUrl: process.env.TANGO_VOICE_ASR_URL || process.env.FUNASR_URL || 'ws://127.0.0.1:10195',
      authenticate: () => ({ demo: true, id: 'voice-lab' }), // lab 本地放宽；默认实现会拒掉一切连接
      requestAllowed: () => true,
      log: options.log,
    }) : null;
    if (instance && typeof instance.handleUpgrade === 'function') {
      result.gateway = { mode: 'module', name: 'voice-gateway.mjs', gateway: { name: 'voice-gateway.mjs', mode: 'module', handleUpgrade: (req, socket, head) => instance.handleUpgrade(req, socket, head), close: () => instance.close?.() } };
    }
  } catch { /* V6 未合入 → demo 兜底 */ }
  try {
    const mod = await import('./intent.mjs'); // V7 意图
    const analyze = pickExport(mod, INTENT_FUNCTION_NAMES);
    if (analyze) {
      // analyzeIntent(input, {signal}) 返回 {ok, draft, final, llm}；契约输出在 .final（无 key 时自动规则 only，不触网关）
      result.intent = {
        mode: 'module',
        name: 'intent.mjs',
        engine: {
          name: 'intent.mjs',
          mode: 'module',
          parse: (input, signal) => analyze(input, { signal, llm: options.llm }).then((r) => {
            if (!r?.ok) { const error = new Error(r?.code || 'intent-failed'); error.code = r?.code; throw error; }
            return r.final;
          }),
        },
      };
    }
  } catch { /* V7 未合入 → demo 兜底 */ }
  return result;
}

// —— HTTP 小工具 ——
function sendJson(res, status, data) {
  if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

async function handleIntent(req, res, engine, timeoutMs, now) {
  if (req.method !== 'POST') { req.resume(); return sendJson(res, 405, { error: 'method-rejected' }); }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); return sendJson(res, 415, { error: 'ai-json-required' }); }
  if (Number(req.headers['content-length']) > MAX_INTENT_BYTES) { req.resume(); return sendJson(res, 413, { error: 'intent-body-too-large' }); }
  const parts = []; let size = 0, tooBig = false;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_INTENT_BYTES) { tooBig = true; break; } parts.push(chunk); }
  if (tooBig) { req.resume(); return sendJson(res, 413, { error: 'intent-body-too-large' }); }
  let raw; try { raw = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return sendJson(res, 400, { error: 'intent-input-invalid' }); }
  const checkedInput = validateIntentInput(raw); // SPEC §2.3 输入 schema（contracts 唯一契约）
  if (!checkedInput.ok) return sendJson(res, 400, { error: 'intent-input-invalid', field: checkedInput.field, message: checkedInput.message });
  const abort = new AbortController(); res.once('close', () => { if (!res.writableEnded) abort.abort(); });
  const startedAt = now();
  let output;
  try {
    output = await Promise.race([
      Promise.resolve(engine.parse(checkedInput.value, abort.signal)),
      sleep(timeoutMs).then(() => { throw Object.assign(new Error('timeout'), { code: 'timeout' }); }),
    ]);
  } catch (error) {
    if (res.destroyed) return;
    if (error?.code === 'timeout') return sendJson(res, 504, { error: 'intent-timeout' });
    return sendJson(res, 502, { error: 'intent-failed' });
  }
  const checkedOutput = validateIntentOutput(output); // 服务端严格校验（SPEC §2.3）
  if (!checkedOutput.ok) return sendJson(res, 502, { error: 'intent-output-invalid', field: checkedOutput.field, message: checkedOutput.message });
  sendJson(res, 200, { items: checkedOutput.value.items, nonEvent: checkedOutput.value.nonEvent, meta: { engine: engine.name ?? 'unknown', elapsedMs: Math.max(0, Math.round(now() - startedAt)) } });
}

function pathnameOf(req) {
  try { return decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { return req.url || '/'; }
}

// —— 装配：voice 端点前置分发，其余请求经 tango.emit('request') 复用 createTangoServer 的 handler ——
export function createVoiceLabServer(options = {}) {
  const tango = options.tango || createTangoServer(); // 静态 web/（含 /voice/lab.html、/voice/contracts.js）+ 既有 API
  const gateway = options.gateway || createDemoVoiceGateway();
  const intentEngine = options.intentEngine || createDemoIntentEngine();
  const timeoutMs = options.intentTimeoutMs ?? INTENT_TIMEOUT_MS;
  const now = options.now || Date.now;
  const gatewayMeta = { mode: options.gatewayMode || gateway.mode || 'stub', name: gateway.name ?? null };
  const intentMeta = { mode: options.intentMode || intentEngine.mode || 'stub', name: intentEngine.name ?? null };
  const labStatus = () => ({ app: 'voice-lab', status: 'ok', wsPath: VOICE_WS_PATH, intentPath: VOICE_INTENT_PATH, entry: '/voice/lab.html', modules: { gateway: gatewayMeta, intent: intentMeta } });

  const server = createServer((req, res) => {
    const pathname = pathnameOf(req);
    if (pathname === VOICE_INTENT_PATH) return void handleIntent(req, res, intentEngine, timeoutMs, now);
    if (pathname === VOICE_LAB_STATUS_PATH) {
      if (req.method !== 'GET') { req.resume(); return sendJson(res, 405, { error: 'method-rejected' }); }
      return sendJson(res, 200, labStatus());
    }
    tango.emit('request', req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (pathnameOf(req) === VOICE_WS_PATH && typeof gateway.handleUpgrade === 'function') return gateway.handleUpgrade(req, socket, head);
    socket.destroy(); // 非 voice 路径：拒绝 upgrade
  });
  server.voiceLab = {
    status: labStatus,
    close() {
      gateway.close?.();
      server.closeAllConnections?.();
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flagValue = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const hostArg = flagValue('--host', process.env.VOICE_LAB_HOST || '');
  const host = isIP(hostArg) ? hostArg : '127.0.0.1';
  const portArg = Number(flagValue('--port', process.env.VOICE_LAB_PORT || VOICE_LAB_PORT_DEFAULT));
  const port = Number.isInteger(portArg) && portArg > 0 ? portArg : VOICE_LAB_PORT_DEFAULT;
  const modules = await loadVoiceModules({ llm: args.includes('--no-llm') ? false : undefined }); // --no-llm：强制规则 only（夜窗调试，不触网关）
  const server = createVoiceLabServer({ gateway: modules.gateway.gateway, intentEngine: modules.intent.engine, gatewayMode: modules.gateway.mode, intentMode: modules.intent.mode });
  server.listen(port, host, () => {
    process.stdout.write(`Voice lab: http://${host}:${port}/voice/lab.html  (asr ${modules.gateway.mode} · intent ${modules.intent.mode})\n`);
  });
  const shutdown = () => server.voiceLab.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
