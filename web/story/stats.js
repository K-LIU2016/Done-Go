// web/story/stats.js — 时光故事书统计（全部纯函数，SPEC design/story-recap/
// SPEC.md §6：输入原始数据和期间，输出 stats）。
//
// 纯度纪律：无 DOM、无 storage、无 Date.now/Math.random；日期运算全部走
// Date.UTC（任何 TZ 环境结果一致），接力记录的 ISO 时刻 → 本地日期由可注入
// 的 localDateOfIso / utcOffsetMinutes 决定（浏览器默认取运行环境本地时区，
// node 测试注入固定偏移保证确定性）。
//
// 形状纪律：所有枚举与阈值 import web/story/contracts.js（六类 KINDS、短章
// 阈值、StatsInput/Stats 校验），绝不在本模块重定义；接力记录由 relay
// contracts.sanitizeRecord 清洗后进入，本模块只消费白名单字段。
//
// 口径纪律：每个指标的计算方式在 web/story/definitions.js 有一段可读口径
// （长按数字可见），本文件注释与之一致。省时只统计本人确认过的
// （stillness state=kept/partial 且 kept ∈ [0, 预留时长]，与账本
// web/index.html personalUseSummary 的口径一致）。
import {
  KINDS,
  SHORT_CHAPTER_MIN_EVENTS,
  validateStatsInput,
  validateStats,
} from './contracts.js';

// ---------------------------------------------------------------------------
// 本地日期纯工具（YYYY-MM-DD 字符串；零填充字符串序即日期序）
// ---------------------------------------------------------------------------
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function dayUtcMs(ymd) {
  var p = String(ymd).split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function ymdFromUtcMs(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function addDays(ymd, n) {
  return ymdFromUtcMs(dayUtcMs(ymd) + n * 86400000);
}

function diffDays(a, b) {
  return Math.round((dayUtcMs(b) - dayUtcMs(a)) / 86400000);
}

// 周一 = 0 … 周日 = 6（经 Date.UTC，与环境时区无关）
function mondayOffset(ymd) {
  return (new Date(dayUtcMs(ymd)).getUTCDay() + 6) % 7;
}

function weekAnchor(ymd) {
  return addDays(ymd, -mondayOffset(ymd));
}

// 期间覆盖的周一锚定自然周数（第 1 周从包含 from 的周开始）
function weekCount(period) {
  return Math.floor(diffDays(weekAnchor(period.from), weekAnchor(period.to)) / 7) + 1;
}

function weekIndexOf(date, anchor) {
  return Math.floor(diffDays(anchor, weekAnchor(date)) / 7);
}

function minuteOf(hm) {
  var p = String(hm).split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

function isInt(value, lo, hi) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.floor(value) === value &&
    value >= lo &&
    value <= hi
  );
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// ISO 时刻 → 本地 {date, time}。默认用运行环境本地时区（浏览器即用户时区，
// 含夏令时）；可注入 utcOffsetMinutes（固定偏移，分钟、东正西负）或整个
// localDateOfIso 函数（unit 测试用）。
// ---------------------------------------------------------------------------
function localFromRuntime(iso) {
  var ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  var d = new Date(ms);
  return {
    date: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
    time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
  };
}

function localFromOffset(off) {
  return function (iso) {
    var ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    var d = new Date(ms + off * 60000);
    return {
      date: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
      time: pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()),
    };
  };
}

function resolveLocalizer(options) {
  if (options && typeof options.localDateOfIso === 'function') return options.localDateOfIso;
  if (options && typeof options.utcOffsetMinutes === 'number' && Number.isFinite(options.utcOffsetMinutes)) {
    return localFromOffset(Math.round(options.utcOffsetMinutes));
  }
  return localFromRuntime;
}

// ---------------------------------------------------------------------------
// 计划时长口径：completion.before（完成时记录的原计划分钟）优先，否则回退
// end − start（契约注释：无效 completion 静默丢弃，stats 回退计划时长）。
// ---------------------------------------------------------------------------
export function plannedMinutes(entry) {
  if (!entry) return 0;
  if (entry.completion && isInt(entry.completion.before, 0, 1440)) return entry.completion.before;
  var m = minuteOf(entry.end) - minuteOf(entry.start);
  return m > 0 ? m : 0;
}

// ---------------------------------------------------------------------------
// 关键词（SPEC §3 ⑦：来自事项标题分词，去掉停用词后取 Top N；无词典的朴素
// 分词，口径见 definitions）。按「不同标题」计数：同一标题重复出现只计一次，
// 避免每日重复事项灌出切分噪声。
// ---------------------------------------------------------------------------
var STOP_CHARS = '的吗呢吧啊呀哦嘛啦是在和与跟把被给就也都还又再很太不没我你他她它个这那';
var STOP_WORDS = {
  一个: 1, 一下: 1, 一些: 1, 这个: 1, 那个: 1, 什么: 1, 没有: 1, 可以: 1,
  我们: 1, 你们: 1, 他们: 1, 时间: 1, 事情: 1, 今天: 1, 明天: 1, 昨天: 1,
  现在: 1, 然后: 1, 可能: 1, 需要: 1, 应该: 1, 有点: 1, 时候: 1, 开始: 1,
  结束: 1, 完成: 1,
};

// 中文标题 → 无停用字的 2..4 字词组；≥5 字的长串交给 2/3 元片段（需出现≥2次）
function cjkSubruns(title) {
  var runs = String(title).match(/[\u4e00-\u9fff]+/g) || [];
  var out = [];
  for (var r = 0; r < runs.length; r++) {
    var chars = runs[r].split('');
    var segs = [];
    var cur = [];
    for (var i = 0; i < chars.length; i++) {
      if (STOP_CHARS.indexOf(chars[i]) >= 0) {
        if (cur.length) segs.push(cur.join(''));
        cur = [];
      } else {
        cur.push(chars[i]);
      }
    }
    if (cur.length) segs.push(cur.join(''));
    for (var s = 0; s < segs.length; s++) if (segs[s].length >= 2) out.push(segs[s]);
  }
  return out;
}

function latinRuns(title) {
  return String(title).toLowerCase().match(/[a-z][a-z0-9-]{1,23}/g) || [];
}

export function topKeywords(titles, limit) {
  var cap = isInt(limit, 1, 10) ? limit : 6; // 契约 keywords ≤ 10
  var df = {};
  var minDf = {};
  var seenTitle = {};
  var list = Array.isArray(titles) ? titles : [];
  for (var t = 0; t < list.length; t++) {
    var title = String(list[t] == null ? '' : list[t]);
    if (!title || seenTitle[title]) continue;
    seenTitle[title] = true;
    var perTitle = {};
    var segs = cjkSubruns(title);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].length <= 4) {
        perTitle[segs[i]] = Math.max(perTitle[segs[i]] || 1, 1);
      } else {
        for (var n = 2; n <= 3; n++) {
          for (var j = 0; j + n <= segs[i].length; j++) {
            var g = segs[i].substr(j, n);
            perTitle[g] = Math.max(perTitle[g] || 1, 2);
          }
        }
      }
    }
    var lat = latinRuns(title);
    for (var k = 0; k < lat.length; k++) perTitle[lat[k]] = Math.max(perTitle[lat[k]] || 1, 1);
    for (var w in perTitle) {
      if (STOP_WORDS[w]) continue;
      if (!df[w]) {
        df[w] = 0;
        minDf[w] = 1;
      }
      df[w] += 1;
      if (perTitle[w] > minDf[w]) minDf[w] = perTitle[w];
    }
  }
  var all = [];
  for (var w2 in df) if (df[w2] >= minDf[w2]) all.push(w2);
  all.sort(function (a, b) {
    return df[b] - df[a] || b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
  });
  var picked = [];
  for (var p = 0; p < all.length && picked.length < cap; p++) {
    var cand = all[p];
    var overlapping = false;
    for (var q = 0; q < picked.length; q++) {
      if (picked[q].indexOf(cand) >= 0 || cand.indexOf(picked[q]) >= 0) {
        overlapping = true;
        break;
      }
    }
    if (!overlapping) picked.push(cand);
  }
  return picked.map(function (w) {
    return { word: w, weight: df[w] };
  });
}

// ---------------------------------------------------------------------------
// 短章判定（SPEC §2：本期事项少于 5 件 → 3 页短章变体）
// ---------------------------------------------------------------------------
export function variantForEventCount(count) {
  if (!isInt(count, 0, 1e7)) return null;
  return count < SHORT_CHAPTER_MIN_EVENTS ? 'short' : 'full';
}

// ---------------------------------------------------------------------------
// 内部聚合
// ---------------------------------------------------------------------------
function inPeriod(date, period) {
  return date >= period.from && date <= period.to;
}

function computeTotals(periodEntries, prevChapter) {
  var events = periodEntries.length;
  var ai = 0;
  for (var i = 0; i < periodEntries.length; i++) {
    if (periodEntries[i].ai && periodEntries[i].ai.used === true) ai += 1;
  }
  var prevEvents = prevChapter && prevChapter.stats ? prevChapter.stats.totals.events : null;
  var delta = prevEvents == null ? null : events - prevEvents;
  return { events: events, aiRelays: ai, prevEvents: prevEvents, delta: delta };
}

function computeKindMinutes(periodEntries) {
  var byKind = {};
  var total = 0;
  for (var i = 0; i < KINDS.length; i++) byKind[KINDS[i]] = 0;
  for (var j = 0; j < periodEntries.length; j++) {
    var m = plannedMinutes(periodEntries[j]);
    byKind[periodEntries[j].kind] += m;
    total += m;
  }
  if (total > 1e7) return null; // 超出存储契约 isInt(0,1e7)：诚实失败，不静默截断
  var rows = [];
  for (var k = 0; k < KINDS.length; k++) {
    rows.push({
      kind: KINDS[k],
      minutes: byKind[KINDS[k]],
      share: total > 0 ? round6(byKind[KINDS[k]] / total) : 0,
    });
  }
  return rows;
}

function computeTopDay(periodEntries) {
  if (!periodEntries.length) return null;
  var byDate = {};
  for (var i = 0; i < periodEntries.length; i++) {
    var e = periodEntries[i];
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  }
  var dates = Object.keys(byDate).sort();
  var best = null;
  for (var d = 0; d < dates.length; d++) {
    var n = byDate[dates[d]].length;
    if (!best || n > best.events) best = { date: dates[d], events: n, entries: byDate[dates[d]] };
  }
  var day = byDate[best.date].slice().sort(function (a, b) {
    return (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) ||
      (a.end < b.end ? -1 : a.end > b.end ? 1 : 0) ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  }).slice(0, 24); // 契约 timeline ≤ 24：取开始时间最早的前 24 条
  var timeline = [];
  for (var t = 0; t < day.length; t++) {
    timeline.push({
      time: day[t].start,
      title: day[t].title,
      ai: day[t].ai && day[t].ai.used === true,
    });
  }
  var warmIndex = null;
  for (var w = 0; w < timeline.length; w++) {
    var kind = day[w].kind;
    if (kind === 'connect' || kind === 'restore') warmIndex = w; // 最晚一条连接/恢复
  }
  return { date: best.date, events: best.events, timeline: timeline, warmIndex: warmIndex };
}

// 接力记录的本地化包装：{record, ms, local}
function localizeRelays(relays, localOf) {
  var out = [];
  for (var i = 0; i < relays.length; i++) {
    var ms = Date.parse(relays[i].at);
    if (!Number.isFinite(ms)) continue;
    var local = localOf(relays[i].at);
    if (!local) continue;
    out.push({ record: relays[i], ms: ms, local: local });
  }
  out.sort(function (a, b) { return a.ms - b.ms; });
  return out;
}

function computeLessons(localRelays, period, usages) {
  var catalog = {};
  for (var u = 0; u < usages.length; u++) catalog[usages[u].id] = usages[u].title;
  var firstSeen = {}; // usageId → 首次成功接力的本地日期
  var periodCount = {};
  for (var i = 0; i < localRelays.length; i += 1) {
    var r = localRelays[i];
    if (r.record.failed != null) continue; // 失败尝试不算使用
    var usageId = r.record.usageId;
    if (!usageId) continue; // v1 迁移记录无 usageId
    if (firstSeen[usageId] == null || r.local.date < firstSeen[usageId]) firstSeen[usageId] = r.local.date;
    if (inPeriod(r.local.date, period)) periodCount[usageId] = (periodCount[usageId] || 0) + 1;
  }
  var learned = [];
  for (var key in periodCount) {
    if (!(firstSeen[key] >= period.from && firstSeen[key] <= period.to)) continue; // 首次使用不在本期 → 不是新学会
    learned.push({
      usageId: key,
      title: String(catalog[key] || key).slice(0, 60),
      count: periodCount[key],
    });
  }
  learned.sort(function (a, b) {
    return b.count - a.count || (a.usageId < b.usageId ? -1 : a.usageId > b.usageId ? 1 : 0);
  });
  learned = learned.slice(0, 12); // 契约 learned ≤ 12
  // 「第一次毕业」红线口径：只认每个应用生平第一次毕业（localRelays 含期间外
  // 全部历史），且该第一次必须落在本期内才上报——否则本期不再自称「第一次」
  // （旧口径取期内最早一条毕业，导致 9 月周章与 10 月月章对同一应用各自宣称
  // 「第一次」，跨章自相矛盾）。
  var firstByApp = {}; // app → 生平第一条带应用的毕业（时间升序扫描先到先得）
  for (var g = 0; g < localRelays.length; g += 1) {
    var rec = localRelays[g].record; // 已按时间升序
    if (rec.graduated !== true) continue;
    if (!rec.graduatedApp) continue; // 契约要求 app id；无应用的毕业不计（口径见 definitions）
    if (firstByApp[rec.graduatedApp] == null) {
      firstByApp[rec.graduatedApp] = {
        date: localRelays[g].local.date,
        time: localRelays[g].local.time,
        app: rec.graduatedApp,
      };
    }
  }
  var firstGraduation = null;
  for (var app in firstByApp) {
    if (!inPeriod(firstByApp[app].date, period)) continue;
    if (firstGraduation == null
        || firstByApp[app].date < firstGraduation.date
        || (firstByApp[app].date === firstGraduation.date && firstByApp[app].time < firstGraduation.time)) {
      firstGraduation = firstByApp[app];
    }
  }
  return { learned: learned, firstGraduation: firstGraduation };
}

// 省时：只统计本人确认过的（红线）。与 web/index.html personalUseSummary 同口径：
// 只看 stillness；kept 必须是 [0, 预留时长] 的整数，否则视为未确认不计。
function computeSavedTime(entries, period) {
  var confirmed = 0;
  var alloc = {};
  var seen = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.kind !== 'stillness' || !inPeriod(e.date, period)) continue;
    var duration = minuteOf(e.end) - minuteOf(e.start);
    if (!(duration > 0)) continue;
    var key = e.date + ':' + (e.id ? e.id : '#' + i); // 同日同 id 去重（无 id 用位置）
    if (seen[key]) continue;
    seen[key] = true;
    if (e.state === 'kept' || e.state === 'partial') {
      if (!isInt(e.kept, 0, duration)) continue;
      confirmed += e.kept;
      var use = KINDS.indexOf(e.use) >= 0 ? e.use : 'stillness';
      alloc[use] = (alloc[use] || 0) + e.kept;
    }
  }
  var allocations = [];
  for (var k in alloc) allocations.push({ use: k, minutes: alloc[k] });
  allocations.sort(function (a, b) {
    return b.minutes - a.minutes || KINDS.indexOf(a.use) - KINDS.indexOf(b.use);
  });
  return { confirmedMinutes: confirmed, allocations: allocations };
}

function computeRhythm(periodEntries) {
  var hourly = new Array(24).fill(0);
  for (var i = 0; i < periodEntries.length; i++) {
    var hour = Number(String(periodEntries[i].start).slice(0, 2));
    if (!Number.isFinite(hour)) continue;
    if (hour > 23) hour = 23; // 24:00 记入 23 点档
    hourly[hour] += 1;
  }
  var goldenHour = null;
  var best = 0;
  for (var h = 0; h < 24; h++) {
    if (hourly[h] > best) {
      best = hourly[h];
      goldenHour = h; // 并列取更早的小时
    }
  }
  return { hourly: hourly, goldenHour: goldenHour, genre: null };
  // genre（时间流派）：与同频分支共用算法（SPEC §3 ⑥）。同频线算法未落地
  // （social PRD §3.2 阈值尚为示意），本期如实置空、不自行变通；
  // 接入方式待 CTO 裁决。
}

// 四格分桶：≤10 天单桶；≤45 天按周一锚定自然周；更长按日历月（年章）。
// 周年书跨 13 个月时第 13 格并入第 12 格（契约 panels ≤ 12）。
function panelBuckets(period) {
  var span = diffDays(period.from, period.to) + 1;
  if (span <= 10) {
    return [{ kind: 'single', label: '本期', single: true }];
  }
  if (span <= 45) {
    var anchor = weekAnchor(period.from);
    var n = weekCount(period);
    var weeks = [];
    for (var i = 0; i < n; i++) {
      weeks.push({ kind: 'week', label: '第 ' + (i + 1) + ' 周', anchor: anchor, week: i });
    }
    return weeks;
  }
  var yms = [];
  var cur = { y: Number(period.from.slice(0, 4)), m: Number(period.from.slice(5, 7)) };
  var last = { y: Number(period.to.slice(0, 4)), m: Number(period.to.slice(5, 7)) };
  while (cur.y * 12 + cur.m <= last.y * 12 + last.m) {
    yms.push({ y: cur.y, m: cur.m });
    cur.m += 1;
    if (cur.m > 12) {
      cur.m = 1;
      cur.y += 1;
    }
  }
  var buckets = [];
  var kept = yms.length > 12 ? yms.slice(0, 11) : yms.slice();
  for (var k = 0; k < kept.length; k++) {
    buckets.push({ kind: 'month', label: kept[k].m + ' 月', yms: [kept[k].y * 12 + kept[k].m] });
  }
  if (yms.length > 12) {
    var mergedYms = [];
    for (var x = 11; x < yms.length; x++) mergedYms.push(yms[x].y * 12 + yms[x].m);
    buckets.push({ kind: 'month', label: yms[11].m + '–' + yms[yms.length - 1].m + ' 月', yms: mergedYms });
  }
  return buckets;
}

function panelCaption(bucket, events, ai) {
  if (!events) {
    if (bucket.kind === 'week') return '这一周没有记录';
    if (bucket.kind === 'month') return '这个月没有记录';
    return '这一期没有记录';
  }
  var prefix = bucket.kind === 'week' ? '本周 ' : bucket.kind === 'month' ? '本月 ' : '本期 ';
  return prefix + events + ' 件事' + (ai ? ' · ' + ai + ' 次接力' : '');
}

function computePanels(period, periodEntries) {
  var buckets = panelBuckets(period);
  var rows = [];
  for (var b = 0; b < buckets.length; b++) {
    var bucket = buckets[b];
    var events = 0;
    var ai = 0;
    for (var i = 0; i < periodEntries.length; i++) {
      var e = periodEntries[i];
      var hit = false;
      if (bucket.single) hit = true;
      else if (bucket.kind === 'week') hit = weekIndexOf(e.date, bucket.anchor) === bucket.week;
      else hit = bucket.yms.indexOf(Number(e.date.slice(0, 4)) * 12 + Number(e.date.slice(5, 7))) >= 0;
      if (!hit) continue;
      events += 1;
      if (e.ai && e.ai.used === true) ai += 1;
    }
    rows.push({ label: bucket.label, caption: panelCaption(bucket, events, ai) });
  }
  return rows;
}

function computeWeekly(period, periodEntries, localRelays) {
  var anchor = weekAnchor(period.from);
  var count = Math.min(weekCount(period), 53); // 契约 weeklyCounts ≤ 53：多出的周并入最后一周
  var weekly = new Array(count).fill(0);
  var graduations = new Array(count).fill(0);
  for (var i = 0; i < periodEntries.length; i++) {
    var idx = Math.min(weekIndexOf(periodEntries[i].date, anchor), count - 1);
    weekly[idx] += 1;
  }
  for (var r = 0; r < localRelays.length; r++) {
    if (localRelays[r].record.graduated !== true) continue;
    if (!inPeriod(localRelays[r].local.date, period)) continue;
    var gi = Math.min(weekIndexOf(localRelays[r].local.date, anchor), count - 1);
    graduations[gi] += 1;
  }
  return { weeklyCounts: weekly, graduations: graduations };
}

function computeBusyness(period, periodEntries, entries) {
  var days = diffDays(period.from, period.to) + 1;
  var rate = periodEntries.length / days;
  var histByDate = {};
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].date < period.from) histByDate[entries[i].date] = (histByDate[entries[i].date] || 0) + 1;
  }
  var histDays = Object.keys(histByDate).length;
  if (histDays === 0) return 0.5; // 首章无历史 → 中性
  var le = 0;
  for (var d in histByDate) if (histByDate[d] <= rate) le += 1;
  return round4(le / histDays);
}

function computeMood(localRelays, period) {
  var rated = 0;
  var much = 0;
  for (var i = 0; i < localRelays.length; i++) {
    var r = localRelays[i];
    if (r.record.failed != null) continue; // 失败接力不计自评
    if (r.record.rating == null) continue;
    if (!inPeriod(r.local.date, period)) continue;
    rated += 1;
    if (r.record.rating === 'much') much += 1; // relay RATINGS: much=省了不少
  }
  return rated === 0 ? 0.5 : round4(much / rated); // 无自评 → 中性
}

function computeDominantKind(kindMinutesRows, periodEntries) {
  var best = null;
  var bestMinutes = 0;
  for (var i = 0; i < kindMinutesRows.length; i++) {
    if (kindMinutesRows[i].minutes > bestMinutes) {
      bestMinutes = kindMinutesRows[i].minutes;
      best = kindMinutesRows[i].kind;
    }
  }
  if (best) return best; // 并列取 canonical 顺序在前（> 严格比较）
  var counts = {};
  var bestCount = 0;
  var fallback = null;
  for (var j = 0; j < periodEntries.length; j++) {
    counts[periodEntries[j].kind] = (counts[periodEntries[j].kind] || 0) + 1;
  }
  for (var k = 0; k < KINDS.length; k++) {
    if ((counts[KINDS[k]] || 0) > bestCount) {
      bestCount = counts[KINDS[k]];
      fallback = KINDS[k];
    }
  }
  return fallback || 'necessary'; // 完全零数据 → necessary（口径见 definitions）
}

// ---------------------------------------------------------------------------
// 心愿回应（SPEC §3 ⑧：可量化心愿给数据，不可量化只温柔复述）
// ---------------------------------------------------------------------------
function dayLastEnds(entries, from, to) {
  var byDay = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.date < from || e.date > to) continue;
    if (!byDay[e.date] || e.end > byDay[e.date]) byDay[e.date] = e.end;
  }
  return byDay;
}

function daysEndedBeforeMidnight(entries, from, to) {
  var byDay = dayLastEnds(entries, from, to);
  var n = 0;
  for (var d in byDay) if (byDay[d] < '24:00') n += 1;
  return n;
}

function kindMinutesWithin(entries, from, to, kind) {
  var total = 0;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].kind === kind && entries[i].date >= from && entries[i].date <= to) total += plannedMinutes(entries[i]);
  }
  return total;
}

function fmtHours(minutes) {
  var h = Math.round((minutes / 60) * 2) / 2;
  if (h === 0) return '0 小时';
  return (h % 1 === 0 ? String(h) : h.toFixed(1)) + ' 小时';
}

function computeWishEcho(prevChapter, entries, localRelays, usages, period) {
  var wish = prevChapter && prevChapter.wish ? prevChapter.wish : null;
  if (!wish) return null;
  var prevPeriod = prevChapter.period;
  var text = wish.text;
  if (wish.category === 'sleep') {
    var x = daysEndedBeforeMidnight(entries, period.from, period.to);
    var y = daysEndedBeforeMidnight(entries, prevPeriod.from, prevPeriod.to);
    return {
      text: text,
      reply: '本期有 ' + x + ' 天在 12 点前收工，上一期是 ' + y + ' 天。',
      matched: true,
      facts: [
        { label: '12点前收工', value: x + ' 天' },
        { label: '上一期', value: y + ' 天' },
      ],
    };
  }
  if (wish.category === 'exercise') {
    var now = fmtHours(kindMinutesWithin(entries, period.from, period.to, 'restore'));
    var prev = fmtHours(kindMinutesWithin(entries, prevPeriod.from, prevPeriod.to, 'restore'));
    return {
      text: text,
      reply: '本期恢复类时间 ' + now + '，上一期 ' + prev + '。',
      matched: true,
      facts: [
        { label: '恢复类时间', value: now },
        { label: '上一期', value: prev },
      ],
    };
  }
  if (wish.category === 'learning') {
    var lessons = computeLessons(localRelays, period, usages);
    var learned = lessons.learned.length;
    var explore = fmtHours(kindMinutesWithin(entries, period.from, period.to, 'explore'));
    return {
      text: text,
      reply: '本期新学会 ' + learned + ' 个用法，探索类时间 ' + explore + '。',
      matched: true,
      facts: [
        { label: '新用法', value: learned + ' 个' },
        { label: '探索类时间', value: explore },
      ],
    };
  }
  if (wish.category === 'company') {
    var nowC = fmtHours(kindMinutesWithin(entries, period.from, period.to, 'connect'));
    var prevC = fmtHours(kindMinutesWithin(entries, prevPeriod.from, prevPeriod.to, 'connect'));
    return {
      text: text,
      reply: '本期连接类时间 ' + nowC + '，上一期 ' + prevC + '。',
      matched: true,
      facts: [
        { label: '连接类时间', value: nowC },
        { label: '上一期', value: prevC },
      ],
    };
  }
  // other / null：不可量化 → 温柔复述，不编数据
  return {
    text: text,
    reply: '上一章的心愿：「' + text + '」。这一章继续照看它。',
    matched: false,
    facts: [],
  };
}

// ---------------------------------------------------------------------------
// 年度扩展块 — computeYear(period, periodEntries) → stats.year（SPEC §2 年书
// 专属：12 个月光谱长卷 / 年度第一次和最后一次 / 年度最长连续接力）。
// 导出供 demo 回退引擎复用（同一份年度口径，两引擎不分叉）。
// 形状与守卫 = contracts.sanitizeYearStats（页面层拟扩展形状的最小实现）：
//   months: 期间覆盖的每个日历月一行（>12 个月时第 13+ 并入第 12 格，
//           与 computePanels 的年章分桶同规则；kindMinutes 恒 6 行 KINDS 序）
//   first / last: 期间首件事 / 末件事（按日期 + 开始时间排序；last 按日期 +
//           结束时间，并列取更晚开始）
//   streak: 连续每天 ≥1 次 AI 接力（事项 ai.used，与年书页 footnote
//           「接力 = 交给 AI 的事项」同口径）的最长一段；无两天连续 → null。
//   genre 恒 null：同频流派线未定稿（computeRhythm 同注，待 CTO 裁决）。
// ---------------------------------------------------------------------------
function monthRowsOf(period) {
  var yms = [];
  var cur = { y: Number(period.from.slice(0, 4)), m: Number(period.from.slice(5, 7)) };
  var last = { y: Number(period.to.slice(0, 4)), m: Number(period.to.slice(5, 7)) };
  while (cur.y * 12 + cur.m <= last.y * 12 + last.m && yms.length < 12) {
    yms.push({ y: cur.y, m: cur.m });
    cur.m += 1;
    if (cur.m > 12) {
      cur.m = 1;
      cur.y += 1;
    }
  }
  return yms; // >12 个月的多出部分并入最后一格（kindMinutes/events 累加同格）
}

export function computeYear(period, periodEntries) {
  var yms = monthRowsOf(period);
  var byMonth = {};
  var lastBucketKey = null;
  for (var b = 0; b < yms.length; b += 1) {
    var bucketKey = yms[b].y * 12 + yms[b].m;
    byMonth[bucketKey] = { m: yms[b].m, entries: [] };
    lastBucketKey = bucketKey;
  }
  for (var i = 0; i < periodEntries.length; i += 1) {
    var e = periodEntries[i];
    var key = Number(e.date.slice(0, 4)) * 12 + Number(e.date.slice(5, 7));
    if (byMonth[key]) byMonth[key].entries.push(e);
    else if (lastBucketKey != null && key > lastBucketKey) byMonth[lastBucketKey].entries.push(e); // 周年书第 13+ 月并入第 12 格（与 computePanels 同规则，不静默丢）
  }
  var months = [];
  var monthKeys = Object.keys(byMonth).sort(function (a, b) { return a - b; });
  for (var mk = 0; mk < monthKeys.length; mk += 1) {
    var bucket = byMonth[monthKeys[mk]];
    var bucketMinutes = computeKindMinutes(bucket.entries);
    if (!bucketMinutes) return { months: null, first: null, last: null, streak: null }; // 超存储上限：诚实留空
    months.push({ m: bucket.m, events: bucket.entries.length, kindMinutes: bucketMinutes, genre: null });
  }

  var first = null;
  var last = null;
  for (var f = 0; f < periodEntries.length; f += 1) {
    var entry = periodEntries[f];
    if (first == null
        || entry.date < first.date
        || (entry.date === first.date && entry.start < first.start)) {
      first = entry;
    }
    if (last == null
        || entry.date > last.date
        || (entry.date === last.date && entry.end >= last.end)) {
      last = entry;
    }
  }
  var firstOut = null;
  var lastOut = null;
  if (first) {
    firstOut = {
      date: first.date, time: first.start, title: first.title, kind: first.kind,
      ai: !!(first.ai && first.ai.used === true),
    };
  }
  if (last) {
    lastOut = {
      date: last.date, time: last.start, title: last.title, kind: last.kind,
      ai: !!(last.ai && last.ai.used === true),
    };
  }

  // 最长连续接力段：按天聚合 ai.used 事项，扫最长连续日；relays = 段内
  // ai.used 事项数（守卫 relays ≥ days 由构造保证：每天至少 1 条）。
  var streak = null;
  var aiDays = {};
  for (var a = 0; a < periodEntries.length; a += 1) {
    var en = periodEntries[a];
    if (en.ai && en.ai.used === true) {
      if (!aiDays[en.date]) aiDays[en.date] = 0;
      aiDays[en.date] += 1;
    }
  }
  var dayList = Object.keys(aiDays).sort();
  var runFrom = null;
  var runTo = null;
  var runLen = 0;
  for (var d = 0; d < dayList.length; d += 1) {
    if (runTo != null && diffDays(runTo, dayList[d]) === 1) {
      runTo = dayList[d];
      runLen += 1;
    } else {
      runFrom = dayList[d];
      runTo = dayList[d];
      runLen = 1;
    }
    if (runLen >= 2 && (!streak || runLen > streak.days)) { // 单日不算「连成串」：年书页走 scattered 空态如实说明
      var relaysInRun = 0;
      for (var rd = runFrom; rd <= runTo; ) {
        relaysInRun += aiDays[rd] || 0;
        rd = addDays(rd, 1);
      }
      streak = { days: runLen, from: runFrom, to: runTo, relays: relaysInRun };
    }
  }
  return { months: months, first: firstOut, last: lastOut, streak: streak };
}

// ---------------------------------------------------------------------------
// 主入口：computeStats(rawInput, options) → 契约校验过的 stats 或 null
// ---------------------------------------------------------------------------
export function computeStats(rawInput, options) {
  var input = validateStatsInput(rawInput);
  if (!input) return null;
  var localOf = resolveLocalizer(options);
  var period = input.period;
  var entries = input.entries;
  var periodEntries = [];
  for (var i = 0; i < entries.length; i++) {
    if (inPeriod(entries[i].date, period)) periodEntries.push(entries[i]);
  }
  var localRelays = localizeRelays(input.relays, localOf);
  var periodTitles = [];
  for (var t = 0; t < periodEntries.length; t++) periodTitles.push(periodEntries[t].title);

  var totals = computeTotals(periodEntries, input.prevChapter);
  var kindMinutes = computeKindMinutes(periodEntries);
  if (!kindMinutes) return null;
  var keywordLimit = options && isInt(options.topKeywords, 1, 10) ? options.topKeywords : 6;
  var weekly = computeWeekly(period, periodEntries, localRelays);

  var stats = {
    totals: totals,
    kindMinutes: kindMinutes,
    topDay: computeTopDay(periodEntries),
    lessons: computeLessons(localRelays, period, input.usages),
    savedTime: computeSavedTime(entries, period),
    rhythm: computeRhythm(periodEntries),
    panels: computePanels(period, periodEntries),
    keywords: topKeywords(periodTitles, keywordLimit),
    wishEcho: computeWishEcho(input.prevChapter, entries, localRelays, input.usages, period),
    song: {
      busyness: computeBusyness(period, periodEntries, entries),
      mood: computeMood(localRelays, period),
      dominantKind: computeDominantKind(kindMinutes, periodEntries),
      weeklyCounts: weekly.weeklyCounts,
      graduations: weekly.graduations,
    },
    year: computeYear(period, periodEntries),
  };
  return validateStats(stats); // 输出一定是契约形状；不合法宁可 null 不硬凑
}
