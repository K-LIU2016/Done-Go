// web/social/circles.js — 同频圈（PRD design/social-sync/PRD.md §4.6，S7搭档圈挑战线）
//
// 课题组、班级、教研组、团队：邀请码加入，规模 3–50 人（CIRCLE_MIN/MAX）。
// 圈主页四件套中的三件在本模块（第四件「传棒链」属 S6 传棒线）：
//   - 本周圈内「学会的用法」墙：只聚合 {usageId, count}，绝无成员身份；
//   - 「空出来的时间」去向汇总：按 freedMinutesConfirmed 加权、只输出占比
//     （PRD §4.6「只显示占比，不显示个人」）；
//   - 圈内排名：D5 红线 —— 只按传棒数与毕业数（CIRCLE_RANK_METRICS），
//     输入携带任何工时/分钟字段整体拒绝，只显示前 3 名（CIRCLE_RANK_SHOWN）
//     和「你」。
//
// 未成年人（PRD §5）：MVP 的圈没有公开检索，加入的唯一路径就是邀请码，
// joinCircle 对缺码/错码一律拒绝 —— 「未成年人只能进有邀请码的圈」由此
// 结构性保证（单测证明），公开池的年龄门槛在服务层（MIN_AGE_PUBLIC_POOL）。
//
// 模块风格对齐 contracts.js：纯函数、无 DOM、无存储 IO；键名/上限/枚举
// 一律 import 自 web/social/contracts.js，本文件绝不重定义。

import {
  ACCOUNT_ID_MAX, WEEKLY_COUNT_MAX, FREED_MINUTES_MAX,
  CIRCLE_MIN_MEMBERS, CIRCLE_MAX_MEMBERS, CIRCLE_RANK_SHOWN,
  FREED_TO_KEYS, isIsoWeek, isUsageId, validateAlias, isAvatarColor,
  validateCircle, validateCircleRankView, validateFreedToSummary,
} from './contracts.js';

export var CIRCLE_WALL_MAX = 12; // 用法墙最多展示的用法种数（聚合计数，无隐私面）

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function accountIdOk(value) {
  return typeof value === 'string' && !!value.trim() && value.trim().length <= ACCOUNT_ID_MAX;
}

function nonNegInt(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

// ---------------------------------------------------------------------------
// 邀请码 — 规则来自 contracts 的 INVITE_CODE_RE（经 validateCircle 探针），
// 本文件不重定义正则。生成时剔除 0/O/1/I 等易混淆字符，方便口口相传。
// ---------------------------------------------------------------------------

var INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export var INVITE_CODE_DEFAULT_LENGTH = 8;

export function isInviteCode(code) {
  // 用契约校验器做探针：固定合法的 id/name，唯一变量是 inviteCode。
  return validateCircle({ id: 'probe', name: 'probe', inviteCode: code }) !== null;
}

export function generateInviteCode(rand, options) {
  var r = typeof rand === 'function' ? rand : Math.random;
  var length = options && options.length ? options.length : INVITE_CODE_DEFAULT_LENGTH;
  if (typeof length !== 'number' || length < 6 || length > 12) return null;
  var out = '';
  for (var i = 0; i < length; i += 1) {
    out += INVITE_ALPHABET[Math.floor(r() * INVITE_ALPHABET.length) % INVITE_ALPHABET.length];
  }
  return isInviteCode(out) ? out : null;
}

// ---------------------------------------------------------------------------
// 建圈 / 入圈
// state = { circle: <validateCircle 形状>, members: [accountId, …] }
// ---------------------------------------------------------------------------

export function createCircle(options) {
  if (!isPlainObject(options)) return null;
  var creator = typeof options.creator === 'string' ? options.creator.trim() : '';
  var circle = validateCircle({
    id: options.id,
    name: options.name,
    inviteCode: options.inviteCode,
  });
  if (!circle || !accountIdOk(creator)) return null;
  return { circle: circle, members: [creator] };
}

// 加入只认邀请码（PRD §4.6 / §5）：错码、缺码、重复、超员一律 { ok:false }。
export function joinCircle(state, request) {
  if (!isPlainObject(state) || !isPlainObject(state.circle) || !Array.isArray(state.members)) {
    return { ok: false, reason: '圈不存在' };
  }
  if (!isPlainObject(request)) return { ok: false, reason: '加入请求不合法' };
  var accountId = typeof request.accountId === 'string' ? request.accountId.trim() : '';
  if (!accountIdOk(accountId)) return { ok: false, reason: '账号不合法' };
  if (request.inviteCode !== state.circle.inviteCode) {
    return { ok: false, reason: '邀请码不正确' };
  }
  if (state.members.indexOf(accountId) >= 0) {
    return { ok: false, reason: '已经是成员了' };
  }
  if (state.members.length >= CIRCLE_MAX_MEMBERS) {
    return { ok: false, reason: '圈最多 ' + CIRCLE_MAX_MEMBERS + ' 人' };
  }
  return {
    ok: true,
    reason: '',
    state: { circle: state.circle, members: state.members.concat(accountId) },
  };
}

// 3 人成圈（PRD「规模 3–50 人」的下限；创建后人数未到 3 时暂不成圈）。
export function circleStats(members) {
  var count = Array.isArray(members) ? members.length : 0;
  return { memberCount: count, viable: count >= CIRCLE_MIN_MEMBERS };
}

// ---------------------------------------------------------------------------
// 用法墙 — 本周圈内「学会的用法」聚合。
// 输入 entry 白名单：{ accountId, usageId, week, count }，出现未知字段
// （例如任何标题类字段）整体拒绝返回 null，绝不静默剥离（对齐 D2 纪律）。
// 输出条目只有 { usageId, count }：不携带任何成员身份，序列化安全。
// ---------------------------------------------------------------------------

var WALL_ENTRY_FIELDS = ['accountId', 'usageId', 'week', 'count'];

function wallEntryOk(entry) {
  if (!isPlainObject(entry)) return false;
  var keys = Object.keys(entry);
  if (keys.length !== WALL_ENTRY_FIELDS.length) return false;
  for (var i = 0; i < WALL_ENTRY_FIELDS.length; i += 1) {
    if (keys.indexOf(WALL_ENTRY_FIELDS[i]) < 0) return false;
  }
  return accountIdOk(entry.accountId) && isUsageId(entry.usageId)
    && isIsoWeek(entry.week) && nonNegInt(entry.count, WEEKLY_COUNT_MAX);
}

export function circleUsageWall(entries, options) {
  if (!Array.isArray(entries) || !isPlainObject(options) || !isIsoWeek(options.week)) return null;
  var totals = {};
  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    if (!wallEntryOk(entry)) return null; // 未知/残缺字段：整体拒绝
    if (entry.week !== options.week) continue; // 只算本周
    totals[entry.usageId] = (totals[entry.usageId] || 0) + entry.count;
  }
  var list = Object.keys(totals).map(function (usageId) {
    return { usageId: usageId, count: totals[usageId] };
  });
  list.sort(function (x, y) {
    return y.count - x.count || (x.usageId < y.usageId ? -1 : x.usageId > y.usageId ? 1 : 0);
  });
  return list.slice(0, CIRCLE_WALL_MAX);
}

// ---------------------------------------------------------------------------
// 「空出来的时间」去向汇总 — 只显示占比，不显示个人（PRD §4.6）。
// 按每人 freedMinutesConfirmed（只算本人确认过的，PRD §3.1）加权平均；
// 没有任何确认分钟时返回 null —— 不造假数据。输出必须过
// contracts.validateFreedToSummary（键固定、占比 0–1、总和 1）。
// ---------------------------------------------------------------------------

var MEMBER_FEATURES_FIELDS = ['freedTo', 'freedMinutesConfirmed'];

export function circleFreedToSummary(memberFeatures) {
  if (!Array.isArray(memberFeatures)) return null;
  var totalMinutes = 0;
  var sums = {};
  for (var k = 0; k < FREED_TO_KEYS.length; k += 1) sums[FREED_TO_KEYS[k]] = 0;
  for (var i = 0; i < memberFeatures.length; i += 1) {
    var mf = memberFeatures[i];
    if (!isPlainObject(mf)) return null;
    var keys = Object.keys(mf);
    if (keys.length !== MEMBER_FEATURES_FIELDS.length
      || MEMBER_FEATURES_FIELDS.some(function (f) { return keys.indexOf(f) < 0; })) return null;
    if (!validateFreedToSummary(mf.freedTo)) return null; // 残缺/越界占比表：整体拒绝
    if (!nonNegInt(mf.freedMinutesConfirmed, FREED_MINUTES_MAX)) return null;
    totalMinutes += mf.freedMinutesConfirmed;
    for (var j = 0; j < FREED_TO_KEYS.length; j += 1) {
      var key = FREED_TO_KEYS[j];
      sums[key] += mf.freedTo[key] * mf.freedMinutesConfirmed;
    }
  }
  if (totalMinutes === 0) return null;
  var summary = {};
  for (var m = 0; m < FREED_TO_KEYS.length; m += 1) {
    summary[FREED_TO_KEYS[m]] = sums[FREED_TO_KEYS[m]] / totalMinutes;
  }
  return validateFreedToSummary(summary) ? summary : null;
}

// ---------------------------------------------------------------------------
// 圈内排名 — D5 红线：只按传棒数（batons）与毕业数（graduations）。
// 输入成员条目白名单 { accountId, alias, avatarColor, batons, graduations }：
// 任何工时/分钟/时长字段都是白名单外字段，整体拒绝 null（与上传白名单
// 同纪律 —— 拒绝，不是剥离）。输出 = contracts.validateCircleRankView
// 形状：top ≤ CIRCLE_RANK_SHOWN（competition ranking 并列同名次）+ 你
// 不在前 3 时的「你」。排序：batons ↓、graduations ↓、alias ↑（确定性）。
// ---------------------------------------------------------------------------

var RANK_MEMBER_FIELDS = ['accountId', 'alias', 'avatarColor', 'batons', 'graduations'];

function rankMemberOk(member) {
  if (!isPlainObject(member)) return false;
  var keys = Object.keys(member);
  if (keys.length !== RANK_MEMBER_FIELDS.length
    || RANK_MEMBER_FIELDS.some(function (f) { return keys.indexOf(f) < 0; })) return false;
  return accountIdOk(member.accountId) && !!validateAlias(member.alias)
    && isAvatarColor(member.avatarColor)
    && nonNegInt(member.batons, WEEKLY_COUNT_MAX)
    && nonNegInt(member.graduations, WEEKLY_COUNT_MAX);
}

export function circleRanking(members, viewerAccount) {
  if (!Array.isArray(members) || members.length === 0) return null;
  var viewer = viewerAccount != null && accountIdOk(viewerAccount) ? viewerAccount : null;
  var sorted = members.slice().sort(function (x, y) {
    if (y.batons !== x.batons) return y.batons - x.batons;
    if (y.graduations !== x.graduations) return y.graduations - x.graduations;
    return x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0;
  });
  // 先校验全部成员（任何工时字段 → null），再排序产出。
  for (var c = 0; c < sorted.length; c += 1) {
    if (!rankMemberOk(sorted[c])) return null;
  }
  var rows = [];
  var viewerIndex = -1;
  for (var i = 0; i < sorted.length; i += 1) {
    var m = sorted[i];
    var prev = rows[rows.length - 1];
    var rank = prev && prev.batons === m.batons && prev.graduations === m.graduations
      ? prev.rank
      : i + 1;
    if (viewer != null && m.accountId === viewer) viewerIndex = i;
    rows.push({ rank: rank, alias: m.alias, avatarColor: m.avatarColor, batons: m.batons, graduations: m.graduations });
  }
  var top = rows.slice(0, CIRCLE_RANK_SHOWN);
  // 「你」只在你不在前 3 时单独展示（在前 3 里已经可见，不重复）。
  var you = viewerIndex >= CIRCLE_RANK_SHOWN ? rows[viewerIndex] : null;
  var view = { top: top, you: you };
  return validateCircleRankView(view) ? view : null;
}
