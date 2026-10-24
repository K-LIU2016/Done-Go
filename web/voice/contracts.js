// web/voice/contracts.js — Done-Go 语音 → 意图 → 日程 第一期共享契约（VI·契约）。
// 浏览器（<script type="module">）与 Node（voice-gateway / intent / 测试）共用；
// 纯数据 + 纯函数，零依赖、无 DOM、无 IO、无网络。
// 唯一标准：design/voice-intent/SPEC.md
//   §2   架构与采样（16kHz/16bit/mono PCM）
//   §2.2 语音网关 WS 协议、限额与错误码
//   §2.3 意图输入/输出 schema、优先级五档（§2.3-7）
//   §3   stream-client「按 seg 合并 partial 和 final」

// —— 采样（SPEC §2：16kHz/16bit/mono，每 60ms 一帧）——
export const VOICE_SAMPLE_RATE = 16000;

// —— WebSocket 消息协议（SPEC §2.2）——
// 客户端 → 网关（文本帧）：
//   {"type":"start","sampleRate":16000}   开始；随后发送二进制 PCM 帧
//   {"type":"stop"}                       说完（手动「说完了」/ 静音 2s / 60s 上限）
// 网关 → 客户端（文本帧）：
//   {"type":"partial","seg":n,"text":…}   流式灰字（FunASR 2pass-online）
//   {"type":"final","seg":n,"text":…}     句子定稿黑字（2pass-offline，替换该句灰字）
//   {"type":"end"}                        正常收尾
//   {"type":"error","code":…}             见 VOICE_ERROR_CODES
export const CLIENT_MESSAGE_TYPES = Object.freeze(['start', 'stop']);
export const SERVER_MESSAGE_TYPES = Object.freeze(['partial', 'final', 'end', 'error']);

// 错误码（kebab-case，走 WS error 帧的 code 字段）。
// asr-unavailable 为 SPEC §2.2 原文命名；其余为契约节点依 SPEC §2.2
// 「限额：…超限返回明确错误码」与鉴权/协议要求补充定义——服务端与前端必须共用本枚举。
export const VOICE_ERROR_CODES = Object.freeze({
  ASR_UNAVAILABLE: 'asr-unavailable', // FunASR 不可达 → 前端降级 webkitSpeechRecognition
  SESSION_TOO_LONG: 'session-too-long', // 单次会话超 60 秒上限
  DAILY_LIMIT: 'daily-limit', // 每访客每日超 15 分钟
  BUSY: 'busy', // 全局并发超 3 路（thinkpad CPU 上限）
  UNAUTHORIZED: 'unauthorized', // 会话 cookie 鉴权或 Origin 校验失败
  BAD_MESSAGE: 'bad-message', // 客户端消息不符合本协议
});

// —— 校验返回形态：{ok:true, value} | {ok:false, field, message} ——
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ok = (value) => ({ ok: true, value });
const fail = (field, message) => ({ ok: false, field, message });
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

export function validateClientMessage(msg) {
  if (!isPlainObject(msg)) return fail('message', 'must be a JSON object');
  if (msg.type === 'start') {
    if (!Number.isInteger(msg.sampleRate) || msg.sampleRate <= 0) {
      return fail('sampleRate', 'must be a positive integer (SPEC 固定 16000)');
    }
    return ok({ type: 'start', sampleRate: msg.sampleRate });
  }
  if (msg.type === 'stop') return ok({ type: 'stop' });
  return fail('type', `unknown client message type: ${String(msg.type)}`);
}

export function validateServerMessage(msg) {
  if (!isPlainObject(msg)) return fail('message', 'must be a JSON object');
  switch (msg.type) {
    case 'partial':
    case 'final':
      if (!Number.isInteger(msg.seg) || msg.seg < 0) return fail('seg', 'must be an integer >= 0');
      if (typeof msg.text !== 'string') return fail('text', 'must be a string');
      return ok({ type: msg.type, seg: msg.seg, text: msg.text });
    case 'end':
      return ok({ type: 'end' });
    case 'error':
      if (!Object.values(VOICE_ERROR_CODES).includes(msg.code)) {
        return fail('code', `unknown error code: ${String(msg.code)}`);
      }
      return ok({ type: 'error', code: msg.code });
    default:
      return fail('type', `unknown server message type: ${String(msg.type)}`);
  }
}

// —— 优先级（SPEC §2.3-7：五档；识别不到依据一律 3「一般」且 priorityReason 为 null）——
export const DEFAULT_PRIORITY = 3;
export const PRIORITIES = Object.freeze([1, 2, 3, 4, 5]);
export const PRIORITY_LABELS = Object.freeze({ 1: '最优先', 2: '优先', 3: '一般', 4: '稍缓', 5: '不急' });
export function isPriority(v) {
  return Number.isInteger(v) && v >= PRIORITIES[0] && v <= PRIORITIES[PRIORITIES.length - 1];
}

// —— 日期 / 时间 / 时区格式守卫（跨浏览器安全，无外部依赖）——
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateStr(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTimeStr = (v) => typeof v === 'string' && TIME_RE.test(v);
const NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export function isIsoDateTimeWithOffset(v) {
  return typeof v === 'string' && NOW_RE.test(v) && !Number.isNaN(Date.parse(v));
}
export function isTimeZone(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

// —— intent 条目 schema（SPEC §2.3 输出，服务端严格校验）——
export const ITEM_KINDS = Object.freeze(['necessary', 'create', 'connect', 'explore', 'restore', 'stillness']);
const MAX_TITLE_CHARS = 20; // SPEC：标题 ≤20 字（动宾短语，去口头语）
const NULLABLE_STRINGS = ['timeText', 'recurrence', 'priorityReason', 'source'];

function checkIntentItem(item) {
  // 纯校验 + canonical 化（可空字段补 null）；不做任何默认值填充（normalize 负责）。
  const title = typeof item.title === 'string' ? item.title.trim() : item.title;
  if (typeof title !== 'string' || title.length === 0) return fail('title', 'must be a non-empty string');
  if (Array.from(title).length > MAX_TITLE_CHARS) return fail('title', `标题超过 ${MAX_TITLE_CHARS} 字（SPEC §2.3）`);
  if (!ITEM_KINDS.includes(item.kind)) return fail('kind', `kind 必须是 ${ITEM_KINDS.join('|')} 之一`);
  for (const f of ['date', 'deadline']) {
    if (item[f] != null && !isDateStr(item[f])) return fail(f, 'must be "YYYY-MM-DD" or null');
  }
  for (const f of ['start', 'end']) {
    if (item[f] != null && !isTimeStr(item[f])) return fail(f, 'must be "HH:MM" or null');
  }
  if (item.durationMin != null && (!Number.isInteger(item.durationMin) || item.durationMin <= 0)) {
    return fail('durationMin', 'must be a positive integer or null');
  }
  if (typeof item.vague !== 'boolean') return fail('vague', 'must be a boolean');
  for (const f of NULLABLE_STRINGS) {
    if (item[f] != null && !isNonEmptyString(item[f])) return fail(f, 'must be a non-empty string or null');
  }
  if (!isPriority(item.priority)) return fail('priority', `must be an integer 1..5（无依据默认 ${DEFAULT_PRIORITY}）`);
  // SPEC §2.3-7 不变量：识别不到依据 ⇒ priority=3 且 priorityReason=null；非 3 档必须给出人话依据
  if (item.priorityReason == null && item.priority !== DEFAULT_PRIORITY) {
    return fail('priorityReason', `priority=${item.priority} 却没有依据；无依据必须为 ${DEFAULT_PRIORITY}「一般」`);
  }
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    return fail('confidence', 'must be a number in [0,1]');
  }
  return ok({
    title,
    kind: item.kind,
    date: item.date ?? null,
    start: item.start ?? null,
    end: item.end ?? null,
    durationMin: item.durationMin ?? null,
    deadline: item.deadline ?? null,
    timeText: item.timeText ?? null,
    vague: item.vague,
    recurrence: item.recurrence ?? null,
    priority: item.priority,
    priorityReason: item.priorityReason ?? null,
    confidence: item.confidence,
    source: item.source ?? null,
  });
}

export function validateIntentItem(item) {
  // 严格模式：priority / vague / confidence / title / kind 必填，不给默认值。
  if (!isPlainObject(item)) return fail('item', 'must be an object');
  return checkIntentItem(item);
}

// 归一化：缺省兜底（priority→3「一般」、vague→false、可空字符串 ''→null、title 去首尾空白），
// 再走同一套严格校验。规则草稿与 LLM 输出统一从这里进（JC：识别不到默认「一般」）。
export function normalizeIntentItem(raw) {
  if (!isPlainObject(raw)) return fail('item', 'must be an object');
  const item = { ...raw };
  if (item.priority == null) item.priority = DEFAULT_PRIORITY;
  if (item.vague == null) item.vague = false;
  for (const f of NULLABLE_STRINGS) if (item[f] === '') item[f] = null;
  return checkIntentItem(item);
}

// —— intent 输入（POST /api/voice/intent，SPEC §2.3）——
// {transcript, now:"2026-10-25T10:12:00+08:00", tz:"Asia/Shanghai"}
// 可选 edit：纠正场景（SPEC §2.3「纠正」）携带当前 items 做增量修改。
export function validateIntentInput(input) {
  if (!isPlainObject(input)) return fail('input', 'must be an object');
  if (!isNonEmptyString(input.transcript)) return fail('transcript', 'must be a non-empty string');
  if (!isIsoDateTimeWithOffset(input.now)) {
    return fail('now', 'must be ISO 8601 datetime with timezone offset, e.g. "2026-10-25T10:12:00+08:00"');
  }
  if (!isTimeZone(input.tz)) return fail('tz', 'must be an IANA timezone id, e.g. "Asia/Shanghai"');
  let edit = null;
  if (input.edit != null) {
    if (!Array.isArray(input.edit)) return fail('edit', 'must be an array of current items (or null)');
    for (let i = 0; i < input.edit.length; i++) {
      const r = normalizeIntentItem(input.edit[i]);
      if (!r.ok) return fail(`edit[${i}].${r.field}`, r.message);
    }
    edit = input.edit;
  }
  return ok({ transcript: input.transcript, now: input.now, tz: input.tz, edit });
}

// —— intent 输出（严格 JSON，服务端校验；SPEC §2.3）——
// {items:[item…], nonEvent:null | {suggest:"relay", reason:"…"}}，二者互斥、必居其一。
export function validateIntentOutput(out) {
  if (!isPlainObject(out)) return fail('output', 'must be an object');
  if (!Array.isArray(out.items)) return fail('items', 'must be an array');
  if (!('nonEvent' in out)) return fail('nonEvent', 'must be present (null or {suggest, reason})');
  return finishIntentOutput(out.items, out.nonEvent, validateIntentItem);
}

export function normalizeIntentOutput(out) {
  if (!isPlainObject(out)) return fail('output', 'must be an object');
  const items = out.items ?? [];
  if (!Array.isArray(items)) return fail('items', 'must be an array');
  return finishIntentOutput(items, out.nonEvent ?? null, normalizeIntentItem);
}

function finishIntentOutput(items, nonEvent, checkItem) {
  const checked = [];
  for (let i = 0; i < items.length; i++) {
    const r = checkItem(items[i]);
    if (!r.ok) return fail(`items[${i}].${r.field}`, r.message);
    checked.push(r.value);
  }
  let ne = null;
  if (nonEvent != null) {
    if (!isPlainObject(nonEvent)) return fail('nonEvent', 'must be null or {suggest, reason}');
    if (!isNonEmptyString(nonEvent.suggest)) return fail('nonEvent.suggest', 'must be a non-empty string（SPEC 例值 "relay"）');
    if (!isNonEmptyString(nonEvent.reason)) return fail('nonEvent.reason', 'must be a non-empty string');
    ne = { suggest: nonEvent.suggest, reason: nonEvent.reason };
  }
  if (ne && checked.length > 0) return fail('nonEvent', '整句非日程（nonEvent）时不得同时输出 items（SPEC §2.3）');
  if (!ne && checked.length === 0) return fail('items', 'items 与 nonEvent 必须二选一：要么日程条目，要么非日程建议');
  return ok({ items: checked, nonEvent: ne });
}

// —— 转录状态与 seg 合并语义（SPEC §2/§3 stream-client「按 seg 合并 partial 和 final」）——
// 状态 = 按 seg 升序的片段表 [{seg, text, final}]，规则：
//   partial(seg)：同句灰字原地替换（边说边出字）；该句已 final 则忽略（定稿不被回退）
//   final(seg)：该句定稿（替换该句灰字，灰转黑）；重复 final 幂等替换
//   已确认（final）前缀永不变化 → 渲染层「已确认前缀保持稳定，只更新尾部灰字」
// 全部纯函数：返回新状态，绝不修改入参。
export function initTranscriptState() {
  return { segments: [], done: false, error: null };
}

export function applyServerMessage(state, msg) {
  const r = validateServerMessage(msg);
  if (!r.ok) throw new Error(`invalid server message (${r.field}: ${r.message})`);
  const value = r.value;
  if (value.type === 'partial' || value.type === 'final') {
    const segments = state.segments.slice();
    const i = segments.findIndex((s) => s.seg === value.seg);
    if (value.type === 'partial' && i >= 0 && segments[i].final) return state; // 迟到 partial 不回退定稿
    const next = { seg: value.seg, text: value.text, final: value.type === 'final' };
    if (i >= 0) segments[i] = next;
    else segments.push(next);
    segments.sort((a, b) => a.seg - b.seg);
    return { ...state, segments };
  }
  if (value.type === 'end') return { ...state, done: true };
  return { ...state, error: value.code }; // 'error'
}

// 渲染视图：已确认黑字前缀 + 未定稿灰字尾巴（transcript-view 只需增量呈现这两段）
export function transcriptView(state) {
  let finalText = '';
  let partialText = '';
  for (const s of state.segments) {
    if (s.final) finalText += s.text;
    else partialText += s.text;
  }
  return { finalText, partialText };
}
