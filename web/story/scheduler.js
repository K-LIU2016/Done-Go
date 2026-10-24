// web/story/scheduler.js — 时光故事书的调度器（SPEC design/story-recap/SPEC.md §2/§6）。
//
// 职责（纯函数，无 DOM / 无存储 IO，node --test 可直接驱动）：
//   · 判断「现在该生成哪一章」：周记（周日 20:00 本地）、月章（每月 1 日
//     09:00 本地，生成上个月）、年书（12 月 31 日 20:00 本地，生成全年）、
//     周年书（注册满一周年）— SPEC §2 触发表。
//   · 下一章章号（全局单调，存进 chapter.no，修剪永不重排 — contracts.js 头注）。
//   · 首页横幅数据结构（SPEC §2「📖 你的第 10 章到了」，二期接入消费）。
//
// ============================== 时区契约 ==============================
// 所有判断以「本地时间」为准，但本模块绝不读取系统时区：调用方按 now 瞬间
// 的 UTC 偏移（分钟，东正西负；= -new Date(now).getTimezoneOffset()）显式注
// 入 utcOffsetMinutes。浏览器里一行 `localUtcOffset(date)` 即得；node 单测里
// 传常量即可跨时区证明边界。偏移取 now 瞬间的值：跨 DST 的历史触发点 ±1h
// 不影响判断（now 至少晚于该触发点数小时）。
//
// ============================ pinned 决策（SPEC 未明说，待 CTO 裁决）============================
// · 周记 period = 周一 .. 触发周日（含当天）：周日本身算进「本周」。
// · 错过不追溯：每个类型只补「最近一个已过触发点」对应的那一章（连续漏开
//   几周不批量补写；SPEC §2 未定义补写行为）。
// · 注册门槛：period.from ≥ 注册本地日才出章 — 注册当周/当月/当年的不完整
//   章不生成；注册时间缺失或在未来 → 不设门槛（防御，绝不全部静默封锁）。
// · 周年书触发时刻取周年日本地 20:00（SPEC 只说「满一周年」，对齐其他仪式
//   书的 20:00）；period = 注册本地日 .. 周年日前一天。
// · 2 月 29 日注册 → 次年 2 月 28 日触发。
// · 周年书与新历年书 period 完全重合（1 月 1 日注册）时只出一本，reason 取
//   'anniversary'（更特别的那本）。
// · 多章同时到期按 (period.to 升序, 粒度 week<month<year) 排序 = 生成顺序
//   = 书架阅读顺序：周 → 月 → 年（年书收尾整年）。
// · 横幅「第 N 章」= nextChapterNo（本次批量生成的最小新章号）；多章时文案
//   附总数（「共 K 章待翻开」）。
//
// 依赖：形状与上限一律 import web/story/contracts.js，本模块不自定义。

import { SHORT_CHAPTER_MIN_EVENTS } from './contracts.js';

// 触发时刻表（SPEC §2）+ pinned 的周年时刻。
export var TRIGGER = {
  weeklyWeekday: 0,   // 周日
  weeklyHour: 20,     // 20:00 本地
  monthlyDay: 1,      // 每月 1 日
  monthlyHour: 9,     // 09:00 本地
  yearlyMonth: 12,    // 12 月 31 日
  yearlyDay: 31,
  yearlyHour: 20,     // 20:00 本地
  anniversaryHour: 20, // pinned：周年日 20:00 本地
};

var TYPE_RANK = { week: 0, month: 1, year: 2 };

// type+period 的规范化去重键（已存章节抑制同键 spec）。
export function chapterKey(type, period) {
  var f = period && typeof period === 'object' && !Array.isArray(period) ? String(period.from == null ? '' : period.from) : '';
  var t = period && typeof period === 'object' && !Array.isArray(period) ? String(period.to == null ? '' : period.to) : '';
  return String(type == null ? '' : type) + '\u0000' + f + '\u0000' + t;
}

// ---------------------------------------------------------------------------
// 墙钟换算 — 全部经 Date.UTC 推算，跨平台确定。
// ---------------------------------------------------------------------------

function validMs(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validOffset(off) {
  return typeof off === 'number' && Number.isFinite(off)
    && Math.floor(off) === off && off >= -840 && off <= 840; // UTC-14 .. UTC+14
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function ymdOf(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

function parseYmd(s) {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

function shiftYmd(s, days) {
  var p = parseYmd(s);
  var t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return ymdOf(t.getUTCFullYear(), 1 + t.getUTCMonth(), t.getUTCDate());
}

function prevMonth(y, m) { return m === 1 ? { y: y - 1, m: 12 } : { y: y, m: m - 1 }; }

// epoch ms → 本地墙钟（偏移注入）。非法输入返回 null。
export function wallClock(now, utcOffsetMinutes) {
  if (!validMs(now) || !validOffset(utcOffsetMinutes)) return null;
  var shifted = new Date(now + utcOffsetMinutes * 60000);
  var y = shifted.getUTCFullYear();
  var m = 1 + shifted.getUTCMonth();
  var d = shifted.getUTCDate();
  return {
    year: y,
    month: m,
    day: d,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(), // 0 = 周日
    ymd: ymdOf(y, m, d),
  };
}

// 本地墙钟 (y, m, d, hh, mm) + 偏移 → epoch ms。非法输入返回 null。
export function epochFromWall(year, month, day, hour, minute, utcOffsetMinutes) {
  if (!validOffset(utcOffsetMinutes)) return null;
  var args = [year, month, day, hour, minute];
  for (var i = 0; i < args.length; i += 1) {
    if (typeof args[i] !== 'number' || !Number.isFinite(args[i]) || Math.floor(args[i]) !== args[i]) return null;
  }
  var t = Date.UTC(year, month - 1, day, hour, minute);
  return Number.isNaN(t) ? null : t - utcOffsetMinutes * 60000;
}

// 浏览器接线用：某瞬间的本地 UTC 偏移（分钟，东正西负）。这是本模块唯一
// 允许触碰 Date 本地时区的地方，调度判断函数本身保持纯。
export function localUtcOffset(date) {
  var d = date == null ? new Date() : date;
  try { return -d.getTimezoneOffset(); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// 触发判断 — dueChapterSpecs
// ---------------------------------------------------------------------------

// 输出 spec：{ type:'week'|'month'|'year', period:{from,to}, reason } —
//   reason ∈ 'weekly' | 'monthly' | 'newYear' | 'anniversary'。
// options：{ utcOffsetMinutes（必填）, registeredAt（epoch ms，可空）, chapters（已存章节）}
// 非法输入返回 null；无到期返回 []。
export function dueChapterSpecs(now, options) {
  if (!validMs(now)) return null;
  var opts = options || {};
  if (!validOffset(opts.utcOffsetMinutes)) return null;
  var wall = wallClock(now, opts.utcOffsetMinutes);
  if (!wall) return null;
  var off = opts.utcOffsetMinutes;
  var chapters = Array.isArray(opts.chapters) ? opts.chapters : [];

  // 注册门槛：本地注册日；缺失或未来注册时间不设门槛（pinned）。
  var regYmd = null;
  if (validMs(opts.registeredAt) && opts.registeredAt <= now) {
    var regWall = wallClock(opts.registeredAt, off);
    if (regWall) regYmd = regWall.ymd;
  }

  var specs = [];
  var push = function (type, from, to, reason) {
    specs.push({ type: type, period: { from: from, to: to }, reason: reason });
  };

  // —— 周记：最近一个 20:00 已过的周日；period = 周一 .. 该周日 ——
  var sunday = shiftYmd(wall.ymd, -wall.weekday);
  var sundayTrigger = epochFromWall(parseYmd(sunday).y, parseYmd(sunday).m, parseYmd(sunday).d, TRIGGER.weeklyHour, 0, off);
  if (sundayTrigger == null || now < sundayTrigger) sunday = shiftYmd(sunday, -7);
  push('week', shiftYmd(sunday, -6), sunday, 'weekly');

  // —— 月章：最近一个「1 日 09:00」已过 → 生成其上个月 ——
  var monthTrigger = epochFromWall(wall.year, wall.month, TRIGGER.monthlyDay, TRIGGER.monthlyHour, 0, off);
  var anchor = monthTrigger != null && now >= monthTrigger
    ? { y: wall.year, m: wall.month }
    : prevMonth(wall.year, wall.month);
  var completed = prevMonth(anchor.y, anchor.m);
  push('month', ymdOf(completed.y, completed.m, 1), ymdOf(completed.y, completed.m, daysInMonth(completed.y, completed.m)), 'monthly');

  // —— 年书：最近一个「12-31 20:00」已过 → 生成那一年 ——
  var year = wall.year;
  var yearTrigger = epochFromWall(year, TRIGGER.yearlyMonth, TRIGGER.yearlyDay, TRIGGER.yearlyHour, 0, off);
  if (yearTrigger == null || now < yearTrigger) year -= 1;
  push('year', ymdOf(year, 1, 1), ymdOf(year, 12, 31), 'newYear');

  // —— 周年书：注册满一周年（周年日 20:00 本地；period = 注册日 .. 周年日前一天）——
  if (regYmd != null) {
    var reg = parseYmd(regYmd);
    var aY = reg.y + 1;
    var aM = reg.m;
    var aD = reg.d;
    if (aM === 2 && aD === 29 && daysInMonth(aY, 2) !== 29) aD = 28; // 闰日 pinned
    var anniversaryTrigger = epochFromWall(aY, aM, aD, TRIGGER.anniversaryHour, 0, off);
    if (anniversaryTrigger != null && now >= anniversaryTrigger) {
      push('year', regYmd, shiftYmd(ymdOf(aY, aM, aD), -1), 'anniversary');
    }
  }

  // —— 注册门槛：注册前不完整的周/月/年不出章 ——
  var gated = [];
  for (var i = 0; i < specs.length; i += 1) {
    if (regYmd == null || specs[i].period.from >= regYmd) gated.push(specs[i]);
  }

  // —— 幂等：已存章节抑制同键 spec（垃圾条目防御性跳过）——
  var existing = {};
  for (var j = 0; j < chapters.length; j += 1) {
    var c = chapters[j];
    if (!c || typeof c !== 'object') continue;
    existing[chapterKey(c.type, c.period)] = true;
  }
  var fresh = [];
  var seenKeys = {};
  for (var k = 0; k < gated.length; k += 1) {
    var spec = gated[k];
    var key = chapterKey(spec.type, spec.period);
    if (existing[key]) continue;
    // 周年书与新历年书同 period 只出一本：anniversary 优先（pinned）。
    if (seenKeys[key]) {
      if (spec.reason === 'anniversary') {
        for (var q = 0; q < fresh.length; q += 1) {
          if (chapterKey(fresh[q].type, fresh[q].period) === key) { fresh[q] = spec; break; }
        }
      }
      continue;
    }
    seenKeys[key] = true;
    fresh.push(spec);
  }

  // —— 生成顺序 = (period.to 升序, 粒度)：周 → 月 → 年 ——
  fresh.sort(function (a, b) {
    if (a.period.to !== b.period.to) return a.period.to < b.period.to ? -1 : 1;
    return TYPE_RANK[a.type] - TYPE_RANK[b.type];
  });
  return fresh;
}

// ---------------------------------------------------------------------------
// 章号 / 短章变体 / 横幅
// ---------------------------------------------------------------------------

// 下一章章号 = 现存最大 no + 1（空书架 → 1）。章号全局单调、跨类型共用
// （SPEC §3 封面「第 10 章」）；修剪淘汰不改写存量 no。
export function nextChapterNo(chapters) {
  var max = 0;
  var list = Array.isArray(chapters) ? chapters : [];
  for (var i = 0; i < list.length; i += 1) {
    var no = list[i] && typeof list[i] === 'object' ? list[i].no : null;
    if (typeof no === 'number' && Number.isFinite(no) && Math.floor(no) === no && no > max) max = no;
  }
  return max + 1;
}

// 短章判定（SPEC §2：本期事项少于 5 件 → 3 页短章；阈值来自契约）。
export function variantForEvents(eventCount) {
  if (typeof eventCount !== 'number' || !Number.isFinite(eventCount)) return null;
  if (Math.floor(eventCount) !== eventCount || eventCount < 0) return null;
  return eventCount < SHORT_CHAPTER_MIN_EVENTS ? 'short' : 'full';
}

// 首页横幅数据结构（二期「开始」页接入消费；本线只供数）：
//   { visible, count, nextNo, latest, specs, text }
//   · nextNo = 本次批量生成的最小新章号；文案「📖 你的第 N 章到了」用它。
//   · latest = 排序最后的 spec（粒度最大的那章）；specs 为完整生成清单。
//   · text 为默认中文文案（只陈述事实，符合 SPEC §5 叙事红线）。
export function bannerFor(now, options) {
  var opts = options || {};
  var chapters = Array.isArray(opts.chapters) ? opts.chapters : [];
  var specs = dueChapterSpecs(now, opts) || [];
  var nextNo = nextChapterNo(chapters);
  if (!specs.length) {
    return { visible: false, count: 0, nextNo: nextNo, latest: null, specs: [], text: '' };
  }
  return {
    visible: true,
    count: specs.length,
    nextNo: nextNo,
    latest: specs[specs.length - 1],
    specs: specs,
    text: '📖 你的第 ' + nextNo + ' 章到了' + (specs.length > 1 ? '（共 ' + specs.length + ' 章待翻开）' : ''),
  };
}
