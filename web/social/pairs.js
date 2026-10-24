// web/social/pairs.js — 接力搭档（PRD design/social-sync/PRD.md §4.5，S7搭档圈挑战线）
//
// 两个人每天各完成 ≥1 次 AI 接力（PAIR_DAILY_RELAYS），共享一个火苗计数；
// 每周 1 次冻结（PAIR_FREEZES_PER_WEEK）；最多 5 位搭档（MAX_PAIRS）；
// 一方断了只提醒、不惩罚。
//
// 【PRD 未决细节的锁定解释】PRD 只说「每周有 1 次冻结」「一方断了只提醒，
// 不惩罚」，没有写冻结对火苗的确切效果。本模块采用并锁定：
//   - 冻结 = 保住当天火苗：miss 当天消耗当周冻结额度，火苗照常 +1
//     （火苗未熄）；每周最多一次，封顶后当天停涨。
//   - 不惩罚 = 火苗是纯增长计数：任何 miss 都不清零、不扣减，最坏结果
//     只是当天停涨；冻结唯一的用途就是把「停涨天」补成「增长天」。
//   若 CTO 另有裁决（如冻结改为「不加但不熄」），只需改 recordPairDay 的
//   flameDelta 一处，状态机其余部分不变。
//
// 状态机形状：runtime = { id, a, b, startedWeek, currentWeek, flame,
// freezesUsed }。currentWeek 是冻结额度的记账周（validatePair 之外的
// runtime 字段）；toPairWire() 投影成 contracts.validatePair 的 5+1 字段
// 线上形状。所有转移都是纯函数，返回新对象（no-op 时返回原引用）。
//
// 模块风格对齐 web/relay/*.js 与 contracts.js：纯 ES module、无 DOM、
// 无存储 IO，node --test 可直接 import。所有键名/上限/枚举一律来自
// web/social/contracts.js，本文件绝不重定义。

import {
  ACCOUNT_ID_MAX, WEEKLY_COUNT_MAX,
  MAX_PAIRS, PAIR_DAILY_RELAYS, PAIR_FREEZES_PER_WEEK,
  isIsoWeek, validatePair,
} from './contracts.js';

// 提醒文案（原型 ③「TA 今天还没接力 · 提醒一下」的提醒正文）。措辞纪律：
// 只邀请、不指责 —— 单测逐字断言不含「断/失败/惩罚/扣」。
export var PAIR_REMINDER_TEXT = '别忘了今天的接力，火苗还在等你们。';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function accountIdOk(value) {
  return typeof value === 'string' && !!value.trim() && value.trim().length <= ACCOUNT_ID_MAX;
}

function nonNegInt(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

// ISO 周字符串 YYYY-Www 定长零填充（contracts.WEEK_RE），字典序即时间序。
export function compareIsoWeeks(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// 确定性 pair id：排序后的双方 + 起始周；超长时退化为 FNV-1a 摘要，
// 保证任何账号组合都能落在 contracts.ACCOUNT_ID_MAX 内。
function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function pairIdFor(a, b, week) {
  var natural = [a, b].sort().join('+') + '@' + week;
  return natural.length <= ACCOUNT_ID_MAX ? natural : 'pair-' + fnv1a(natural);
}

// ---------------------------------------------------------------------------
// 创建与投影
// ---------------------------------------------------------------------------

export function createPairRuntime(options) {
  if (!isPlainObject(options)) return null;
  var a = typeof options.a === 'string' ? options.a.trim() : '';
  var b = typeof options.b === 'string' ? options.b.trim() : '';
  if (!accountIdOk(a) || !accountIdOk(b) || a === b) return null;
  if (!isIsoWeek(options.week)) return null;
  var id = options.id != null ? String(options.id) : pairIdFor(a, b, options.week);
  if (!accountIdOk(id)) return null;
  return {
    id: id,
    a: a,
    b: b,
    startedWeek: options.week,
    currentWeek: options.week,
    flame: 0,
    freezesUsed: 0,
  };
}

// runtime → 线上形状（contracts.validatePair 的精确字段集，丢弃 currentWeek）。
export function toPairWire(runtime) {
  if (!isPlainObject(runtime)) return null;
  return {
    id: runtime.id,
    a: runtime.a,
    b: runtime.b,
    startedWeek: runtime.startedWeek,
    flame: runtime.flame,
    freezesUsed: runtime.freezesUsed,
  };
}

// ---------------------------------------------------------------------------
// 每日转移 — 状态机核心
// activity = { aRelays, bRelays }（当天各自接力次数）；dayWeek 是该天所属
// ISO 周：晚于 currentWeek 时先重置冻结额度（每周 1 次），早于则拒绝
// （不允许补记历史，避免回填争议）。
// ---------------------------------------------------------------------------

function activityOk(activity) {
  return isPlainObject(activity)
    && nonNegInt(activity.aRelays, WEEKLY_COUNT_MAX)
    && nonNegInt(activity.bRelays, WEEKLY_COUNT_MAX);
}

export function recordPairDay(runtime, dayWeek, activity, options) {
  if (!isPlainObject(runtime)) return null;
  if (!isIsoWeek(dayWeek)) return null;
  if (!activityOk(activity)) return null;
  if (compareIsoWeeks(dayWeek, runtime.currentWeek) < 0) return null; // 不补记历史

  var state = runtime;
  if (compareIsoWeeks(dayWeek, runtime.currentWeek) > 0) {
    state = {
      id: runtime.id, a: runtime.a, b: runtime.b,
      startedWeek: runtime.startedWeek, currentWeek: dayWeek,
      flame: runtime.flame, freezesUsed: 0,
    };
  }

  var both = activity.aRelays >= PAIR_DAILY_RELAYS && activity.bRelays >= PAIR_DAILY_RELAYS;
  var useFreeze = !options || options.useFreeze !== false; // 默认自动保火苗

  var flameDelta = 0;
  var freezesUsed = state.freezesUsed;
  if (both) {
    flameDelta = 1;
  } else if (useFreeze && freezesUsed < PAIR_FREEZES_PER_WEEK) {
    flameDelta = 1; // 冻结保住当天火苗（PRD 未决细节的锁定解释，见文件头）
    freezesUsed += 1;
  }
  // 无冻结可用：停涨，不清零、不扣减（不惩罚）。

  var next = {
    id: state.id, a: state.a, b: state.b,
    startedWeek: state.startedWeek, currentWeek: state.currentWeek,
    flame: state.flame + flameDelta,
    freezesUsed: freezesUsed,
  };
  return validatePair(toPairWire(next)) ? next : null;
}

// 显式周滚动：进入更晚的 ISO 周时恢复冻结额度（火苗保留）；同周或回退
// 是 no-op，返回原引用。
export function rollPairWeek(runtime, week) {
  if (!isPlainObject(runtime) || !isIsoWeek(week)) return null;
  if (compareIsoWeeks(week, runtime.currentWeek) <= 0) return runtime;
  return {
    id: runtime.id, a: runtime.a, b: runtime.b,
    startedWeek: runtime.startedWeek, currentWeek: week,
    flame: runtime.flame, freezesUsed: 0,
  };
}

// ---------------------------------------------------------------------------
// 只读视图（不改变状态）
// ---------------------------------------------------------------------------

// 当天状态：both（今天你们都接力了）/ missed（火苗呈冷色，pendingRelay
// 指向还没接力的一方或双方）。文案字段只有 kind，具体措辞归 UI 线。
export function pairDayStatus(runtime, activity) {
  if (!isPlainObject(runtime) || !activityOk(activity)) return null;
  var aDone = activity.aRelays >= PAIR_DAILY_RELAYS;
  var bDone = activity.bRelays >= PAIR_DAILY_RELAYS;
  var pending = [];
  if (!aDone) pending.push(runtime.a);
  if (!bDone) pending.push(runtime.b);
  return {
    kind: aDone && bDone ? 'both' : 'missed',
    cold: !(aDone && bDone),
    pendingRelay: pending,
    flame: runtime.flame,
  };
}

// 温和提醒：只有「我接力了、对方还没」才产生提醒（不指责双方都缺席的
// 情形，也不给自己没接力的人递刀）。返回 { to, kind, text } 或 null。
export function pairReminder(runtime, activity, viewerAccount) {
  if (!isPlainObject(runtime) || !activityOk(activity)) return null;
  var viewer = typeof viewerAccount === 'string' ? viewerAccount.trim() : '';
  if (viewer !== runtime.a && viewer !== runtime.b) return null;
  var other = viewer === runtime.a ? runtime.b : runtime.a;
  var viewerDone = viewer === runtime.a
    ? activity.aRelays >= PAIR_DAILY_RELAYS
    : activity.bRelays >= PAIR_DAILY_RELAYS;
  var otherDone = viewer === runtime.a
    ? activity.bRelays >= PAIR_DAILY_RELAYS
    : activity.aRelays >= PAIR_DAILY_RELAYS;
  if (!viewerDone || otherDone) return null;
  return { to: other, kind: 'relay-nudge', text: PAIR_REMINDER_TEXT };
}

// ---------------------------------------------------------------------------
// 上限 5 位（PRD §4.5 / Duolingo 好友位设上限的调研落点）
// ---------------------------------------------------------------------------

export function distinctPartners(pairs, account) {
  if (!Array.isArray(pairs) || !accountIdOk(account)) return 0;
  var seen = {};
  var count = 0;
  for (var i = 0; i < pairs.length; i += 1) {
    var p = pairs[i];
    if (!isPlainObject(p)) continue;
    var partner = null;
    if (p.a === account && p.b !== account) partner = p.b;
    else if (p.b === account && p.a !== account) partner = p.a;
    if (partner != null && !seen[partner]) {
      seen[partner] = true;
      count += 1;
    }
  }
  return count;
}

// 结为搭档的准入判定：自配对 / 重复搭档 / 超过 MAX_PAIRS 一律拒绝。
export function canAddPair(pairs, self, candidate) {
  if (!accountIdOk(self) || !accountIdOk(candidate)) {
    return { ok: false, reason: '账号不合法' };
  }
  if (self === candidate) return { ok: false, reason: '不能和自己结为搭档' };
  var list = Array.isArray(pairs) ? pairs : [];
  for (var i = 0; i < list.length; i += 1) {
    var p = list[i];
    if (!isPlainObject(p)) continue;
    var pairAccounts = [p.a, p.b];
    if (pairAccounts.indexOf(self) >= 0 && pairAccounts.indexOf(candidate) >= 0) {
      return { ok: false, reason: '你们已经是搭档了' };
    }
  }
  if (distinctPartners(list, self) >= MAX_PAIRS) {
    return { ok: false, reason: '搭档最多 ' + MAX_PAIRS + ' 位' };
  }
  return { ok: true, reason: '' };
}
