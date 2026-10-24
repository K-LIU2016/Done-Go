// web/social/quests.js — 周挑战（PRD design/social-sync/PRD.md §4.7、§8，
// S7搭档圈挑战线）。
//
// 每周 3 个挑战（QUESTS_PER_WEEK），个人和圈级（QUEST_SCOPES）；完成后得
// 徽章，徽章进入「我的用法」（badge 形状在本模块定义，UI 挂载归其它线）。
// 「太多了」按钮是保护指标反馈通道（QUEST_FEEDBACK_TYPES，PRD §8），
// 不是惩罚：反馈与进度是两个世界，任何反馈都不参与进度转移。
//
// 计划的确定性：questWeekPlan(week) 对同一周输出完全一致的计划（两次调用
// deepEqual），周与周之间按 (year*7 + 周号) 滚动轮转 —— 相邻两周必然不同，
// 无随机、无存储；池子不足时返回 null，绝不凑数、绝不生成计划外挑战
// （对齐 D4「生产代码路径不造假」的纪律）。
//
// ISO 周数学：isoWeekOfDate / questWeekRemainingDays 是纯日期函数（UTC
// 计算，无时区依赖），供「还剩 N 天」与周计划归属判断。
//
// 模块风格对齐 contracts.js：纯函数、无 DOM、无存储 IO；键名/上限/枚举
// 一律 import 自 web/social/contracts.js，本文件绝不重定义。

import {
  ACCOUNT_ID_MAX, QUESTS_PER_WEEK, QUEST_TARGET_MAX,
  QUEST_FEEDBACK_TYPES, validateQuest, validateQuestProgress, isIsoWeek,
} from './contracts.js';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function accountIdOk(value) {
  return typeof value === 'string' && !!value.trim() && value.trim().length <= ACCOUNT_ID_MAX;
}

// ---------------------------------------------------------------------------
// 定义池 — PRD §4.7 的示例挑战 + 同量级的扩展。week 字段是定义锚点周
// （'2026-W01'），questWeekPlan 发布时会按目标周重盖，保证每个池内定义
// 本身就能过 contracts.validateQuest。
// ---------------------------------------------------------------------------

export var DEFAULT_QUEST_POOL = [
  { id: 'quest-life-x3', week: '2026-W01', scope: 'personal', title: '用 AI 完成 3 件生活小事', target: 3, unit: '件' },
  { id: 'quest-family-60', week: '2026-W01', scope: 'personal', title: '把空出来的 1 小时给家人并确认', target: 60, unit: '分钟' },
  { id: 'quest-baton-1', week: '2026-W01', scope: 'personal', title: '给 1 个人传棒', target: 1, unit: '人' },
  { id: 'quest-relay-x5', week: '2026-W01', scope: 'personal', title: '自己完成 5 次 AI 接力', target: 5, unit: '次' },
  { id: 'quest-learn-2', week: '2026-W01', scope: 'personal', title: '学会 2 个新用法', target: 2, unit: '个' },
  { id: 'quest-kudos-1', week: '2026-W01', scope: 'personal', title: '给 1 位同频的人加油', target: 1, unit: '人' },
  { id: 'quest-circle-baton-10', week: '2026-W01', scope: 'circle', title: '圈内传出 10 次棒', target: 10, unit: '次' },
  { id: 'quest-circle-learn-5', week: '2026-W01', scope: 'circle', title: '圈内学会 5 个新用法', target: 5, unit: '个' },
  { id: 'quest-circle-family-3', week: '2026-W01', scope: 'circle', title: '3 位圈员把空出来的时间给家人并确认', target: 3, unit: '人' },
  { id: 'quest-circle-relay-20', week: '2026-W01', scope: 'circle', title: '圈内接力 20 次', target: 20, unit: '次' },
];

// ---------------------------------------------------------------------------
// 每周计划 — 默认 2 个人 + 1 个圈级（options 可改配额，总数必须是
// QUESTS_PER_WEEK）。滚动轮转：index = year*7 + weekNo，个人池与圈池相位
// 错开，相邻两周计划必然不同；同一周两次调用输出 deepEqual。
// ---------------------------------------------------------------------------

export function questWeekPlan(week, pool, options) {
  if (!isIsoWeek(week)) return null;
  var defs = Array.isArray(pool) ? pool : DEFAULT_QUEST_POOL;
  var counts = { personal: 2, circle: 1 };
  if (isPlainObject(options)) {
    if (Number.isInteger(options.personal) && options.personal >= 0) counts.personal = options.personal;
    if (Number.isInteger(options.circle) && options.circle >= 0) counts.circle = options.circle;
  }
  if (counts.personal + counts.circle !== QUESTS_PER_WEEK) return null;

  var personal = [];
  var circle = [];
  var seenIds = {};
  for (var i = 0; i < defs.length; i += 1) {
    var def = defs[i];
    if (!isPlainObject(def)) return null;
    if (seenIds[def.id]) return null; // 池内 id 重复：拒绝，防计划重复
    seenIds[def.id] = true;
    if (def.scope === 'personal') personal.push(def);
    else if (def.scope === 'circle') circle.push(def);
    else return null;
  }
  if (personal.length < counts.personal || circle.length < counts.circle) return null;

  var year = Number(week.slice(0, 4));
  var weekNo = Number(week.slice(6));
  var index = year * 7 + weekNo;

  function pick(list, count, offset) {
    var out = [];
    for (var j = 0; j < count; j += 1) out.push(list[(offset + j) % list.length]);
    return out;
  }

  var chosen = pick(personal, counts.personal, index % personal.length)
    .concat(pick(circle, counts.circle, (index + 3) % circle.length));

  var plan = [];
  for (var k = 0; k < chosen.length; k += 1) {
    var quest = validateQuest(Object.assign({}, chosen[k], { week: week }));
    if (!quest) return null;
    plan.push(quest);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// 进度 — 单调递增：正整数增量、clamp 到 target、到 target 即 done；
// 非正增量一律 null（进度绝不倒退）。转移后必须过 validateQuestProgress。
// ---------------------------------------------------------------------------

export function initialQuestProgress(quest, owner) {
  var clean = validateQuest(quest);
  var who = typeof owner === 'string' ? owner.trim() : '';
  if (!clean || !accountIdOk(who)) return null;
  return validateQuestProgress({
    questId: clean.id, scope: clean.scope, owner: who, progress: 0, done: false,
  });
}

function progressMatchesQuest(progress, quest) {
  return progress.questId === quest.id && progress.scope === quest.scope;
}

export function applyQuestProgress(progress, quest, delta) {
  var cleanQuest = validateQuest(quest);
  var cleanProgress = validateQuestProgress(progress);
  if (!cleanQuest || !cleanProgress) return null;
  if (!progressMatchesQuest(cleanProgress, cleanQuest)) return null;
  if (!Number.isInteger(delta) || delta <= 0) return null;
  var next = Math.min(cleanProgress.progress + delta, cleanQuest.target);
  return validateQuestProgress({
    questId: cleanQuest.id, scope: cleanQuest.scope, owner: cleanProgress.owner,
    progress: next, done: next >= cleanQuest.target,
  });
}

// 进度条比例（原型 ③ .prog 宽度）：clamp 到 [0,1]。
export function questProgressRatio(progress, quest) {
  var cleanQuest = validateQuest(quest);
  var cleanProgress = validateQuestProgress(progress);
  if (!cleanQuest || !cleanProgress || !progressMatchesQuest(cleanProgress, cleanQuest)) return null;
  var ratio = cleanProgress.progress / cleanQuest.target;
  return Math.max(0, Math.min(1, ratio));
}

// ---------------------------------------------------------------------------
// 徽章 — 完成后得徽章，徽章进入「我的用法」（PRD §4.7）。只有 done 才发。
// ---------------------------------------------------------------------------

export function questBadge(quest, progress) {
  var cleanQuest = validateQuest(quest);
  var cleanProgress = validateQuestProgress(progress);
  if (!cleanQuest || !cleanProgress) return null;
  if (!cleanProgress.done || !progressMatchesQuest(cleanProgress, cleanQuest)) return null;
  return { questId: cleanQuest.id, week: cleanQuest.week, scope: cleanQuest.scope, title: cleanQuest.title };
}

// ---------------------------------------------------------------------------
// 「太多了」反馈 — 保护指标（PRD §8），不是惩罚。只认 QUEST_FEEDBACK_TYPES；
// 反馈对象没有进度入口：applyQuestProgress 的签名里不存在反馈参数，
// 单测以等值对照证明反馈不可能改变进度。
// ---------------------------------------------------------------------------

export function validateQuestFeedback(value) {
  if (!isPlainObject(value)) return null;
  var keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'type') return null;
  if (QUEST_FEEDBACK_TYPES.indexOf(value.type) < 0) return null;
  return { type: value.type };
}

// ---------------------------------------------------------------------------
// ISO 周数学（纯 UTC，无时区依赖）
// ---------------------------------------------------------------------------

var DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function utcDate(dateStr) {
  var m = DATE_RE.exec(typeof dateStr === 'string' ? dateStr : '');
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var t = Date.UTC(y, mo - 1, d);
  var dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function isoWeekOfDate(dateStr) {
  var dt = utcDate(dateStr);
  if (!dt) return null;
  var time = dt.getTime();
  var mondayIndex = (dt.getUTCDay() + 6) % 7;           // 周一=0 … 周日=6
  var thursday = time + (3 - mondayIndex) * 86400000;   // 本周四定 ISO 年
  var isoYear = new Date(thursday).getUTCFullYear();
  var jan1 = Date.UTC(isoYear, 0, 1);
  var week = Math.ceil(((thursday - jan1) / 86400000 + 1) / 7);
  return isoYear + '-W' + String(week).padStart(2, '0');
}

// 「还剩 N 天」：周一 6 → 周日 0；dateStr 不属于该周时返回 null。
export function questWeekRemainingDays(week, dateStr) {
  if (!isIsoWeek(week)) return null;
  if (isoWeekOfDate(dateStr) !== week) return null;
  var dt = utcDate(dateStr);
  var weekday = (dt.getUTCDay() + 6) % 7 + 1;           // 周一=1 … 周日=7
  return 7 - weekday;
}
