// web/voice/intent-view.js — VI·V4意图视图：② 理解中 → ③ 事件卡。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2.3   规则先行 → LLM 精修「逐字段替换，有差异的字段闪一下高亮」；纠正（edit）增量修改
//   §2.3-7 优先级五档；无依据 = 3「一般」且 priorityReason=null
//   §2.3-8 不确定字段 null → 前端标黄「没说具体几点」（宁缺勿编）
//   §3     intent-view.js：② 理解中（转写锁定、高亮时间/优先级线索词、骨架卡）
//          → ③ 事件卡（标题、类别、时间 chip、优先级 chip、依据、模糊黄 chip）；
//          点卡片可编辑标题、日期时间、优先级；「全部加入」「再说一次」、口头纠正。
// 纯逻辑（阶段状态机 / 线索词高亮 / 可编辑字段合并 / chip 文案）无 DOM，可在 Node 单测；
// DOM 装配集中在 createIntentView()，模块顶层不触碰 document。
// 视觉 token 经 voice-sheet.js 的 VOICE_TOKENS（SPEC §4 + relay-v2 §3）。

import {
  DEFAULT_PRIORITY,
  PRIORITY_LABELS,
  VOICE_ERROR_CODES,
  isTimeZone,
  isIsoDateTimeWithOffset,
  normalizeIntentItem,
  normalizeIntentOutput,
} from './contracts.js';
import { VOICE_TOKENS, token, prefersReducedMotion } from './voice-sheet.js';

// —— 阶段状态机（idle → understanding → events/nonEvent → done；error / 再说一次回到 idle）——
export const INTENT_PHASES = Object.freeze(['idle', 'understanding', 'events', 'nonEvent', 'error', 'done']);

// 可编辑字段（SPEC §3：点卡片可编辑标题、日期时间、优先级）
export const EDITABLE_FIELDS = Object.freeze(['title', 'date', 'start', 'end', 'deadline', 'priority']);

// 精修合并时的可视比较字段（驱动「闪一下高亮」）；confidence/source 不参与视觉比较。
export const COMPARE_FIELDS = Object.freeze([
  'title', 'kind', 'date', 'start', 'end', 'durationMin', 'deadline',
  'timeText', 'vague', 'recurrence', 'priority', 'priorityReason',
]);

// 类别标签（沿用 app 既有词汇：web/assistant-ui.js 的 必要/创造/探索/连接/恢复 + 静驻）
export const KIND_LABELS = Object.freeze({
  necessary: '必要', create: '创造', connect: '连接', explore: '探索', restore: '恢复', stillness: '静驻',
});
export const kindLabel = (kind) => KIND_LABELS[kind] ?? '';

export function createIntentState() {
  return {
    phase: 'idle',
    transcript: '',
    context: { now: null, tz: null },
    marks: [], // highlightCues(transcript) 的分段结果
    items: [], // 当前（含用户编辑的）条目
    dirty: [], // dirty[i] = 第 i 条被用户改过的字段名（精修不覆盖）
    provenance: null, // 'rule' | 'llm' | 'correct'
    flash: [], // 最近一次精修的可视差异 [{index, fields}]
    nonEvent: null,
    error: null,
  };
}

// —— ② 理解中：时间 / 优先级线索词（SPEC §2.3-2/3/7 的词族，供高亮与提示）——
export const TIME_CUES = Object.freeze([
  '今天', '明天', '后天', '大后天', '周五', '这周五', '下周三', '周末', '月底', '下个月', // 日期
  '上午', '中午', '下午', '傍晚', '晚上', '凌晨', // 时段
  '三点半', '15:30', '半小时', '一个半小时', '十分钟前', // 时刻 / 时长
]);

// 优先级线索词（档位判定在 intent 服务端；前端只负责高亮）。模糊时间词（晚上/有空/回头）
// 与 vague 词族相邻时按原型的处理：整个短语交给优先级黄标，不单独点亮时段词。
export const PRIORITY_CUES = Object.freeze([
  '必须', '务必', '紧急', '最重要', // → 1
  '比较重要', '优先', '尽快', // → 2
  '晚点', '不着急', // → 4
  '有空再说', '随便', '可以的话', '有空的话', // → 5
]);
const VAGUE_CUES = ['有空再说', '随便', '可以的话', '有空的话'];
const DAYPARTS = ['凌晨', '上午', '中午', '下午', '傍晚', '晚上'];

const CLOCK = '(?:[一两二三四五六七八九十\\d]+点(?:半|钟)?|\\d{1,2}[:：]\\d{2}(?::\\d{2})?)';
const DURATION = '(?:[一两二三四五六七八九十\\d]+个?半?小时|[一两二三四五六七八九十\\d]+分钟|半小时)';
const ANCHOR = '(?:大后天|后天|明天|今天|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?|月底|月初|下个?月|这个?月|(?:(?:这|下|每)(?:周|星期|礼拜)(?:[一二三四五六日天]|末)?|(?:周|星期|礼拜)(?:[一二三四五六日天]|末)))';
const DAYPART = '(?:凌晨|上午|中午|下午|傍晚|晚上)';
const SUFFIX = '(?:之?前|以[前后]|[前后])?';
const TIME_RE = new RegExp(
  `(?:${ANCHOR}${DAYPART}?${CLOCK}?${SUFFIX}|${DAYPART}${CLOCK}?${SUFFIX}|${CLOCK}${SUFFIX}|${DURATION}${SUFFIX})`,
  'g',
);

/**
 * 线索词高亮（纯函数）：把转写切成 [{text, cue:'time'|'priority'|null}] 分段。
 * - 时间：日期词 + 时段词 + 时刻词按相邻组合成一段（原型 ② 屏的「明天下午三点」「周五前」）；
 * - 优先级：SPEC §2.3-7 显式词族；
 * - 模糊词族（有空的话…）紧邻的裸时段词不重复点亮（原型中「晚上」不单独 mark）。
 */
export function highlightCues(text) {
  if (typeof text !== 'string' || text.length === 0) return [{ text: String(text ?? ''), cue: null }];
  const priorityHits = [];
  for (const cue of [...PRIORITY_CUES].sort((a, b) => b.length - a.length)) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(cue, from);
      if (at < 0) break;
      const hit = { start: at, end: at + cue.length, text: cue, cue: 'priority' };
      if (!priorityHits.some((p) => hit.start < p.end && p.start < hit.end)) priorityHits.push(hit);
      from = at + cue.length;
    }
  }
  priorityHits.sort((a, b) => a.start - b.start);

  const timeHits = [];
  TIME_RE.lastIndex = 0;
  for (let m = TIME_RE.exec(text); m !== null; m = TIME_RE.exec(text)) {
    if (m[0].length === 0) {
      TIME_RE.lastIndex += 1;
      continue;
    }
    const hit = { start: m.index, end: m.index + m[0].length, text: m[0], cue: 'time' };
    if (priorityHits.some((p) => hit.start < p.end && p.start < hit.end)) continue; // 与优先级重叠让位
    // 模糊词族紧邻的裸时段词（「晚上有空的话」）让位给优先级标记
    const bareDaypart = DAYPARTS.includes(hit.text);
    const adjacentVague = priorityHits.some(
      (p) => VAGUE_CUES.includes(p.text) && (hit.end === p.start || p.end === hit.start),
    );
    if (bareDaypart && adjacentVague) continue;
    if (!timeHits.some((t) => hit.start < t.end && t.start < hit.end)) timeHits.push(hit);
  }

  const merged = [...priorityHits, ...timeHits].sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const hit of merged) {
    if (hit.start < cursor) continue; // 防御：理论上不会发生
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start), cue: null });
    segments.push({ text: hit.text, cue: hit.cue });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), cue: null });
  return segments;
}

// —— ② 进入理解中：锁定转写（灰字转黑、缩小字号），高亮线索词 ——
export function beginUnderstanding(state, { transcript, now, tz } = {}) {
  const fail = (field, message) => ({ ok: false, field, message, state });
  if (state.phase !== 'idle' && state.phase !== 'understanding') {
    return fail('phase', `cannot begin understanding from ${state.phase}`);
  }
  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return fail('transcript', 'transcript must be a non-empty string');
  }
  if (!isIsoDateTimeWithOffset(now)) return fail('now', 'now must be ISO 8601 with timezone offset');
  if (!isTimeZone(tz)) return fail('tz', 'tz must be an IANA timezone id');
  const locked = transcript.trim();
  return {
    ok: true,
    state: {
      ...createIntentState(),
      phase: 'understanding',
      transcript: locked,
      context: { now, tz },
      marks: highlightCues(locked),
    },
  };
}

const itemsWithDirty = (items) => {
  const dirty = new Array(items.length); // 稀疏：未编辑的索引保持 undefined
  return { items, dirty };
};

// —— 规则草稿（<50ms 先出）——
export function showDraft(state, out) {
  if (state.phase !== 'understanding') {
    return { ok: false, reason: state.phase === 'idle' ? 'not started' : 'stale', state };
  }
  const r = normalizeIntentOutput(out);
  if (!r.ok) return { ok: false, field: r.field, message: r.message, state };
  if (r.value.nonEvent) {
    return {
      ok: true,
      state: { ...state, phase: 'nonEvent', nonEvent: r.value.nonEvent, provenance: 'rule', flash: [] },
    };
  }
  const { items, dirty } = itemsWithDirty(r.value.items);
  return { ok: true, state: { ...state, phase: 'events', items, dirty, provenance: 'rule', flash: [] } };
}

// —— LLM 精修 / 口头纠正（SPEC §2.3：逐字段替换；用户已编辑字段在 refine 模式下胜出）——
// mode='refine'：dirty 字段保留用户值，不闪光；mode='correct'：纠正结果全量替换并清空 dirty。
export function applyRefine(state, out, { mode = 'refine' } = {}) {
  if (state.phase !== 'events' && state.phase !== 'understanding') {
    return { ok: false, reason: `cannot refine from ${state.phase}`, state };
  }
  if (mode !== 'refine' && mode !== 'correct') {
    return { ok: false, reason: `unknown mode ${mode}`, state };
  }
  const r = normalizeIntentOutput(out);
  if (!r.ok) return { ok: false, field: r.field, message: r.message, state };
  if (r.value.nonEvent) {
    return {
      ok: true,
      changed: [],
      state: {
        ...state, phase: 'nonEvent', nonEvent: r.value.nonEvent, items: [], dirty: [],
        provenance: mode === 'correct' ? 'correct' : 'llm', flash: [],
      },
    };
  }
  const fresh = r.value.items;
  const prev = state.items;
  const prevDirty = state.dirty ?? [];
  const keepDirty = mode === 'refine';
  const dirty = keepDirty ? fresh.map((_, i) => prevDirty[i] ?? []) : fresh.map(() => []);
  const items = fresh.map((item, i) => {
    const userDirty = dirty[i];
    if (userDirty.length === 0) return item;
    const merged = { ...item };
    for (const f of userDirty) merged[f] = prev[i]?.[f] ?? item[f];
    if (userDirty.includes('priority')) {
      // 优先级与依据是一对（§2.3-7 不变量）：用户改的优先级连同手动依据一起保留。
      merged.priority = prev[i].priority;
      merged.priorityReason = prev[i].priorityReason;
    }
    return merged;
  });
  const changed = [];
  for (let i = 0; i < items.length; i++) {
    const fields = [];
    for (const f of COMPARE_FIELDS) {
      if (dirty[i].includes(f)) continue; // 用户编辑字段显示值未变，不闪
      const before = prev[i] ? prev[i][f] : undefined;
      if (prev[i] == null || before !== items[i][f]) fields.push(f);
    }
    if (fields.length > 0) changed.push({ index: i, fields });
  }
  return {
    ok: true,
    changed,
    state: { ...state, phase: 'events', items, dirty, provenance: mode === 'correct' ? 'correct' : 'llm', flash: changed },
  };
}

// —— ③ 事件卡编辑（SPEC §3：可编辑标题、日期时间、优先级）——
// 空串按「清空」处理（'' → null）；改优先级自动补/清依据，守住「非 3 档必须有人话依据」。
export function editItem(state, index, patch) {
  if (state.phase !== 'events') return { ok: false, reason: `cannot edit in ${state.phase}`, state };
  if (!Number.isInteger(index) || index < 0 || index >= state.items.length) {
    return { ok: false, field: 'index', message: 'index out of range', state };
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, field: 'patch', message: 'patch must be an object', state };
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, field: 'patch', message: 'patch is empty', state };
  for (const k of keys) {
    if (!EDITABLE_FIELDS.includes(k)) return { ok: false, field: k, message: `${k} is not editable`, state };
  }
  const current = state.items[index];
  const candidate = { ...current };
  for (const k of keys) {
    let v = patch[k];
    if (v === '') v = null; // 输入框清空 → null（宁缺勿编，SPEC §2.3-8）
    candidate[k] = v;
  }
  if (keys.includes('priority')) {
    const p = candidate.priority;
    candidate.priorityReason = p === DEFAULT_PRIORITY ? null : `你手动改为「${PRIORITY_LABELS[p] ?? p}」`;
  }
  const r = normalizeIntentItem(candidate);
  if (!r.ok) return { ok: false, field: r.field, message: r.message, state };
  const items = state.items.slice();
  items[index] = r.value;
  const dirty = state.dirty.slice();
  dirty[index] = [...new Set([...(dirty[index] ?? []), ...keys])];
  return { ok: true, state: { ...state, items, dirty } };
}

// —— 确认 / 重说 ——
export function confirmAll(state) {
  if (state.phase !== 'events') return { ok: false, reason: `cannot confirm in ${state.phase}`, state };
  const items = state.items.slice();
  return { ok: true, items, state: { ...state, phase: 'done' } };
}

export const finalItems = (state) => state.items.slice();

// 「再说一次」：丢弃本次结果，回到干净初始态（由编排层重开语音监听）。
export const reaskIntent = () => createIntentState();

export function countLine(state) {
  const n = state.items.length;
  return n === 1 ? '听出了 1 件事' : `听出了 ${n} 件事`;
}

// —— 时间 chip 文案（原型 ③ 屏语义）——
const enCADay = new Map(); // tz -> Intl.DateTimeFormat(en-CA, y-m-d)
const zhWeekday = new Map(); // tz -> Intl.DateTimeFormat(zh-CN, weekday short)

function ymdInTz(ms, tz) {
  let fmt = enCADay.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    enCADay.set(tz, fmt);
  }
  return fmt.format(new Date(ms)); // "2026-10-25"
}

function weekdayWord(dateStr, tz) {
  const key = tz ?? 'Asia/Shanghai';
  let fmt = zhWeekday.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: key, weekday: 'short' });
    zhWeekday.set(key, fmt);
  }
  return fmt.format(new Date(`${dateStr}T12:00:00Z`)); // 周五
}

// 相对日词：今天/明天/后天（以 now+tz 为准），更远用 周X。
function dayWord(dateStr, ctx) {
  if (ctx?.now && ctx?.tz && isIsoDateTimeWithOffset(ctx.now) && isTimeZone(ctx.tz)) {
    const nowDay = ymdInTz(Date.parse(ctx.now), ctx.tz);
    const diff = Math.round((Date.parse(dateStr) - Date.parse(nowDay)) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
  }
  return weekdayWord(dateStr, ctx?.tz ?? 'Asia/Shanghai');
}

const mdd = (dateStr) => {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${String(Number(d)).padStart(2, '0')}`;
};

/**
 * 时间 chip：{ label, warn }。warn=true 时旁边要放黄色「没说具体几点」chip（SPEC §2.3-8）。
 * - deadline → 「截止 周五 10/30」；
 * - 有 start → 「明天 10/26 · 15:00–16:00」（重复事项前缀原文：每周一 · 19:00）；
 * - 只有时段原文 → 原样（今晚/晚上）；只有时长 → 「约 45 分钟」；什么都没有 → 「时间待定」。
 */
export function formatTimeChip(item, ctx = {}) {
  const warn = item.vague === true && item.start == null && item.deadline == null;
  if (item.deadline != null) {
    return { label: `截止 ${dayWord(item.deadline, ctx)} ${mdd(item.deadline)}`, warn };
  }
  if (item.start != null) {
    const time = item.end ? `${item.start}–${item.end}` : item.start;
    const segs = [];
    if (item.recurrence) segs.push(item.recurrence);
    if (item.date) segs.push(`${dayWord(item.date, ctx)} ${mdd(item.date)}`);
    segs.push(time);
    return { label: segs.join(' · '), warn };
  }
  if (item.recurrence) return { label: item.recurrence, warn };
  if (item.timeText) return { label: item.timeText, warn };
  if (item.durationMin != null) return { label: `约 ${item.durationMin} 分钟`, warn };
  if (item.date) return { label: `${dayWord(item.date, ctx)} ${mdd(item.date)}`, warn };
  return { label: '时间待定', warn };
}

// —— 错误码 → 人话（contracts VOICE_ERROR_CODES 的前端文案）——
export const ERROR_TEXT = Object.freeze({
  [VOICE_ERROR_CODES.ASR_UNAVAILABLE]: '语音服务暂时不可用，打字也行',
  [VOICE_ERROR_CODES.SESSION_TOO_LONG]: '这次说得有点久，休息一下再来',
  [VOICE_ERROR_CODES.DAILY_LIMIT]: '今天的语音额度用完了，明天再见',
  [VOICE_ERROR_CODES.BUSY]: '现在用语音的人有点多，稍后再试',
  [VOICE_ERROR_CODES.UNAUTHORIZED]: '请先登录再使用语音',
  [VOICE_ERROR_CODES.BAD_MESSAGE]: '语音连接异常，请重试',
});

// ===================== DOM 装配（浏览器专用；Node 导入无副作用） =====================

const INTENT_STYLE_ID = 'intent-view-styles';

export function ensureIntentStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(INTENT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = INTENT_STYLE_ID;
  style.textContent = `
.vi-root{font-family:${token('--font')};color:${token('--ink')};display:flex;flex-direction:column;min-height:0;flex:1}
.vi-root *{box-sizing:border-box}
.vi-top{display:flex;align-items:center;gap:10px;flex:1}
.vi-live{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:${token('--forest')}}
.vi-got{font-size:13px;color:${token('--ink2')};margin:14px 0 0}
.vi-got b{color:${token('--ink')};font-size:17px;margin-right:6px}
/* ② 理解中 */
.vi-tx-locked{font-size:18px;line-height:1.6;color:${token('--ink2')};margin-top:18px;font-feature-settings:"palt";text-wrap:pretty}
.vi-mark{background:linear-gradient(transparent 58%,${token('--gold-soft')} 0);color:inherit;border-radius:2px;padding:0 1px}
.vi-think{display:flex;align-items:center;gap:10px;margin-top:16px;font-size:14px;color:${token('--forest')};font-weight:600}
.vi-dots{display:inline-flex;gap:4px}
.vi-dots i{width:6px;height:6px;border-radius:50%;background:${token('--forest')};animation:vi-d 1s infinite}
.vi-dots i:nth-child(2){animation-delay:.15s}.vi-dots i:nth-child(3){animation-delay:.3s}
@keyframes vi-d{0%,100%{opacity:.25;transform:none}50%{opacity:1;transform:translateY(-3px)}}
.vi-skel{height:76px;border-radius:${token('--r-md')};background:linear-gradient(90deg,${token('--sunk')},#ece8de,${token('--sunk')});background-size:200% 100%;animation:vi-shimmer 1.4s linear infinite;margin-top:10px}
.vi-skel:nth-child(2){opacity:.7}.vi-skel:nth-child(3){opacity:.45}
@keyframes vi-shimmer{to{background-position:-200% 0}}
/* ③ 事件卡 */
.vi-list{margin-top:2px}
.vi-ev{border:1.5px solid ${token('--line')};border-radius:${token('--r-md')};padding:12px 14px;margin-top:10px;background:${token('--surface')};animation:vi-rise .28s ease-out both}
.vi-ev:nth-child(2){animation-delay:.06s}.vi-ev:nth-child(3){animation-delay:.12s}.vi-ev:nth-child(4){animation-delay:.18s}
@keyframes vi-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.vi-ev-head{width:100%;text-align:left;border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}
.vi-ev-t{font-size:16.5px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vi-k{font-size:11.5px;font-weight:600;color:${token('--forest')};background:${token('--forest-soft')};border-radius:6px;padding:2px 6px;flex:none}
.vi-dirty{font-size:11px;color:${token('--ink3')};flex:none}
.vi-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}
.vi-chip{height:28px;border-radius:99px;padding:0 10px;font-size:12.5px;display:inline-flex;align-items:center;gap:5px;background:${token('--sunk')};color:${token('--ink2')};border:0}
.vi-chip.vi-time{background:${token('--surface')};border:1px solid ${token('--line')};color:${token('--ink')}}
.vi-chip.vi-warn{background:${token('--gold-soft')};color:${token('--warn')}}
.vi-pri{font-weight:600}
.vi-pri.p1{background:var(--p1-bg,${VOICE_TOKENS['--p1-bg']});color:var(--p1,${VOICE_TOKENS['--p1']})}
.vi-pri.p2{background:var(--p2-bg,${VOICE_TOKENS['--p2-bg']});color:var(--p2,${VOICE_TOKENS['--p2']})}
.vi-pri.p3{background:var(--p3-bg,${VOICE_TOKENS['--p3-bg']});color:var(--p3,${VOICE_TOKENS['--p3']})}
.vi-pri.p4{background:var(--p4-bg,${VOICE_TOKENS['--p4-bg']});color:var(--p4,${VOICE_TOKENS['--p4']})}
.vi-pri.p5{background:var(--p5-bg,${VOICE_TOKENS['--p5-bg']});color:var(--p5,${VOICE_TOKENS['--p5']})}
.vi-why{font-size:12px;color:${token('--ink3')};margin-top:6px}
.vi-why q{quotes:"「" "」";color:${token('--ink2')}}
/* 精修闪光（SPEC §2.3：有差异的字段闪一下高亮） */
.vi-flash{animation:vi-flash .64s ease-out}
@keyframes vi-flash{from{box-shadow:0 0 0 4px ${token('--gold-soft')}}to{box-shadow:0 0 0 4px transparent}}
/* 行内编辑 */
.vi-edit{margin-top:10px;display:grid;gap:8px;border-top:1px dashed ${token('--line')};padding-top:10px}
.vi-edit label{display:grid;gap:4px;font-size:12.5px;color:${token('--ink2')}}
.vi-edit input,.vi-edit select{height:44px;border:1.5px solid ${token('--line')};border-radius:12px;padding:0 10px;font-size:15px;font-family:inherit;background:${token('--surface')};color:${token('--ink')}}
.vi-edit .vi-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.vi-edit-actions{display:flex;gap:8px}
.vi-btn{height:44px;border-radius:12px;font-weight:600;font-size:14.5px;border:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-family:inherit}
.vi-btn.vi-ghost{padding:0 16px;background:${token('--sunk')};color:${token('--ink')}}
.vi-btn.vi-primary{flex:1;background:${token('--ink')};color:#fff}
.vi-err{color:#B4432F;font-size:12px}
/* 底部动作区（原型 acts） */
.vi-acts{display:flex;gap:8px;margin-top:auto;padding-top:14px}
.vi-btn-lg{height:52px;border-radius:16px;font-weight:600;font-size:15.5px;border:0;display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:inherit}
.vi-btn-lg.vi-primary{flex:1;background:${token('--brand')};color:#fff}
.vi-btn-lg.vi-ghost{padding:0 18px;background:${token('--sunk')};color:${token('--ink')}}
.vi-reask{font-size:12.5px;color:${token('--ink2')};text-align:center;margin-top:10px}
.vi-reask .vi-correct{border:0;background:none;color:${token('--ink')};text-decoration:underline;text-underline-offset:3px;font:inherit;cursor:pointer;padding:0}
/* 非日程 / 错误 / 完成 */
.vi-panel{border:1.5px solid ${token('--line')};border-radius:${token('--r-md')};padding:16px;margin-top:14px;text-align:center}
.vi-panel b{font-size:16.5px}
.vi-panel p{font-size:13px;color:${token('--ink2')};margin-top:6px}
@media (prefers-reduced-motion:reduce){.vi-root *{animation:none!important;transition:none!important}}
`;
  doc.head.appendChild(style);
}

const chipField = (chip, field) => {
  chip.dataset.field = field;
  return chip;
};

/**
 * 创建意图视图（放入 voice-sheet 的容器里）。
 * opts: { now, tz, onConfirmAll(items), onReask(), onCorrectVoice() }
 * 返回 { element, setUnderstanding, showDraft, applyRefine, showNonEvent, showError, reset, focusMain, getState }。
 */
export function createIntentView(opts = {}) {
  if (typeof document === 'undefined') {
    throw new TypeError('createIntentView requires a DOM document');
  }
  const { now, tz, onConfirmAll, onReask, onCorrectVoice } = opts;
  ensureIntentStyles(document);

  let state = createIntentState();
  let editing = null; // 展开编辑的卡片 index
  let editError = null;
  const root = document.createElement('div');
  root.className = 'vi-root';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '语音识别结果');

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const reduced = () => prefersReducedMotion(window);

  const flash = (changed) => {
    if (!changed || changed.length === 0 || reduced()) return;
    for (const { index, fields } of changed) {
      const card = root.querySelectorAll('.vi-ev')[index];
      if (!card) continue;
      for (const field of fields) {
        card.querySelectorAll(`[data-field="${field}"]`).forEach((node) => {
          node.classList.add('vi-flash');
          node.addEventListener('animationend', () => node.classList.remove('vi-flash'), { once: true });
        });
      }
    }
  };

  const renderTranscriptLocked = () => {
    const p = el('p', 'vi-tx-locked');
    for (const seg of state.marks) {
      if (seg.cue) {
        const mark = el('mark', 'vi-mark', seg.text);
        mark.dataset.cue = seg.cue;
        p.appendChild(mark);
      } else {
        p.appendChild(document.createTextNode(seg.text));
      }
    }
    return p;
  };

  const renderUnderstanding = () => {
    root.replaceChildren();
    const top = el('div', 'vi-top');
    top.appendChild(el('span', 'vi-live', '✓ 听完了'));
    root.appendChild(top);
    root.appendChild(renderTranscriptLocked());
    const think = el('p', 'vi-think');
    const dots = el('span', 'vi-dots');
    dots.append(el('i'), el('i'), el('i'));
    think.append(dots, document.createTextNode('正在理解你说的事…'));
    root.appendChild(think);
    const skels = el('div');
    skels.append(el('div', 'vi-skel'), el('div', 'vi-skel'), el('div', 'vi-skel'));
    root.appendChild(skels);
  };

  const chipFor = (item, i) => {
    const { label, warn } = formatTimeChip(item, state.context);
    const row = el('div', 'vi-row');
    if (label) {
      const time = el('span', 'vi-chip vi-time', label);
      chipField(time, item.deadline != null ? 'deadline' : item.start != null ? 'start' : 'timeText');
      row.appendChild(time);
    }
    if (warn) {
      const w = el('span', 'vi-chip vi-warn', '没说具体几点');
      chipField(w, 'vague');
      row.appendChild(w);
    }
    if (item.recurrence && item.start != null) {
      const rec = el('span', 'vi-chip', item.recurrence);
      chipField(rec, 'recurrence');
      row.appendChild(rec);
    }
    const pri = el('span', `vi-chip vi-pri p${item.priority}`, PRIORITY_LABELS[item.priority] ?? String(item.priority));
    chipField(pri, 'priority');
    row.appendChild(pri);
    return row;
  };

  const editorFor = (item, i) => {
    const form = el('form', 'vi-edit');
    const add = (labelText, input) => {
      const label = el('label', null, labelText);
      label.appendChild(input);
      form.appendChild(label);
      return input;
    };
    const title = add('标题（≤20 字）', el('input'));
    title.name = 'title';
    title.maxLength = 20;
    title.value = item.title;
    const two = el('div', 'vi-two');
    const date = el('input'); date.name = 'date'; date.type = 'date'; date.value = item.date ?? '';
    const start = el('input'); start.name = 'start'; start.type = 'time'; start.value = item.start ?? '';
    two.append(date, start);
    const row2 = el('div', 'vi-two');
    const end = el('input'); end.name = 'end'; end.type = 'time'; end.value = item.end ?? '';
    const deadline = el('input'); deadline.name = 'deadline'; deadline.type = 'date'; deadline.value = item.deadline ?? '';
    row2.append(end, deadline);
    const dl1 = el('label', null, '日期 / 开始'); dl1.appendChild(two);
    const dl2 = el('label', null, '结束 / 截止'); dl2.appendChild(row2);
    form.append(dl1, dl2);
    const pri = el('select'); pri.name = 'priority';
    for (let p = 1; p <= 5; p++) {
      const opt = el('option', null, PRIORITY_LABELS[p]);
      opt.value = String(p);
      pri.appendChild(opt);
    }
    pri.value = String(item.priority);
    add('优先级', pri);
    if (editError) form.appendChild(el('p', 'vi-err', editError));
    const actions = el('div', 'vi-edit-actions');
    const cancel = el('button', 'vi-btn vi-ghost', '收起');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      editing = null;
      editError = null;
      render();
    });
    const save = el('button', 'vi-btn vi-primary', '保存');
    save.type = 'submit';
    actions.append(cancel, save);
    form.appendChild(actions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const patch = {
        title: title.value,
        date: date.value,
        start: start.value,
        end: end.value,
        deadline: deadline.value,
        priority: Number(pri.value),
      };
      const r = editItem(state, i, patch);
      if (!r.ok) {
        editError = r.message ?? '改不了，检查一下格式';
        render();
        return;
      }
      state = r.state;
      editing = null;
      editError = null;
      render();
    });
    return form;
  };

  const cardFor = (item, i) => {
    const card = el('article', 'vi-ev');
    const head = el('button', 'vi-ev-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(editing === i));
    const t = el('div', 'vi-ev-t');
    const title = el('span', null, item.title);
    chipField(title, 'title');
    t.appendChild(title);
    const k = el('span', 'vi-k', kindLabel(item.kind));
    chipField(k, 'kind');
    t.appendChild(k);
    if ((state.dirty[i] ?? []).length > 0) t.appendChild(el('span', 'vi-dirty', '已手动修改'));
    head.appendChild(t);
    head.appendChild(chipFor(item, i));
    if (item.priorityReason) {
      const why = el('p', 'vi-why');
      chipField(why, 'priorityReason');
      why.appendChild(document.createTextNode('因为'));
      const q = el('q', null, item.priorityReason);
      why.appendChild(q);
    }
    head.addEventListener('click', () => {
      editing = editing === i ? null : i;
      editError = null;
      render();
    });
    card.appendChild(head);
    if (editing === i) card.appendChild(editorFor(item, i));
    return card;
  };

  const renderEvents = () => {
    root.replaceChildren();
    const top = el('div', 'vi-top');
    top.appendChild(el('span', 'vi-live', '✓ 听完了'));
    root.appendChild(top);
    const got = el('p', 'vi-got');
    got.appendChild(el('b', null, countLine(state)));
    got.appendChild(document.createTextNode('点一下可以改'));
    root.appendChild(got);
    const list = el('div', 'vi-list');
    state.items.forEach((item, i) => list.appendChild(cardFor(item, i)));
    root.appendChild(list);
    const acts = el('div', 'vi-acts');
    const again = el('button', 'vi-btn-lg vi-ghost', '再说一次');
    again.type = 'button';
    again.addEventListener('click', () => {
      state = reaskIntent();
      editing = null;
      render();
      onReask?.();
    });
    const add = el('button', 'vi-btn-lg vi-primary', '全部加入');
    add.type = 'button';
    add.addEventListener('click', () => {
      const r = confirmAll(state);
      if (!r.ok) return;
      state = r.state;
      render();
      onConfirmAll?.(r.items);
    });
    acts.append(again, add);
    root.appendChild(acts);
    const hint = el('p', 'vi-reask', '识别不对？');
    const correct = el('button', 'vi-correct', '直接说“把跑步改到八点”');
    correct.type = 'button';
    correct.addEventListener('click', () => onCorrectVoice?.());
    hint.appendChild(correct);
    root.appendChild(hint);
  };

  const renderNotice = (title, text, showReask = true) => {
    root.replaceChildren();
    const top = el('div', 'vi-top');
    top.appendChild(el('span', 'vi-live', '✓ 听完了'));
    root.appendChild(top);
    const panel = el('div', 'vi-panel');
    panel.appendChild(el('b', null, title));
    if (text) panel.appendChild(el('p', null, text));
    if (showReask) {
      const again = el('button', 'vi-btn-lg vi-ghost', '再说一次');
      again.type = 'button';
      again.style.margin = '12px auto 0';
      again.addEventListener('click', () => {
        state = reaskIntent();
        render();
        onReask?.();
      });
      panel.appendChild(again);
    }
    root.appendChild(panel);
  };

  const render = () => {
    switch (state.phase) {
      case 'understanding':
        renderUnderstanding();
        break;
      case 'events':
        renderEvents();
        break;
      case 'nonEvent':
        renderNotice('这听起来不是一件事', state.nonEvent?.reason ?? '');
        break;
      case 'error':
        renderNotice('没听出日程', ERROR_TEXT[state.error] ?? '出错了，再试一次');
        break;
      case 'done':
        renderNotice(`已加入 ${state.items.length} 件事`, '', false);
        break;
      default:
        root.replaceChildren();
    }
  };
  render();

  return {
    element: root,
    setUnderstanding(input) {
      const r = beginUnderstanding(state, input);
      if (r.ok) {
        state = r.state;
        editing = null;
        editError = null;
        render();
      }
      return r;
    },
    showDraft(out) {
      const r = showDraft(state, out);
      if (r.ok) {
        state = r.state;
        render();
      }
      return r;
    },
    applyRefine(out, refineOpts) {
      const r = applyRefine(state, out, refineOpts);
      if (r.ok) {
        state = r.state;
        render();
        flash(r.changed); // 有差异的字段闪一下高亮（SPEC §2.3）
      }
      return r;
    },
    showNonEvent(nonEvent) {
      state = { ...createIntentState(), phase: 'nonEvent', nonEvent, context: { now, tz } };
      render();
    },
    showError(code) {
      state = { ...createIntentState(), phase: 'error', error: code, context: { now, tz } };
      render();
    },
    reset() {
      state = createIntentState();
      editing = null;
      editError = null;
      render();
    },
    focusMain() {
      const first = root.querySelector('button, [href], input, select, textarea');
      (first ?? root).focus?.({ preventScroll: true });
    },
    getState() {
      return state;
    },
  };
}
