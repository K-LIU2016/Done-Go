// web/story/pages/freed.js — ⑤ 省下的时间去了哪（SPEC §3 ⑤，原型 p5）。
//
// 页型接口（本线五页统一，供 player.js 挂载）：
//   buildSavedTimeModel(chapter)            → 纯 view-model（node 可测，不改 chapter）
//   renderSavedTimePage(chapter, ctx)       → HTMLElement（DOM 仅在调用时触碰）
//     ctx.reducedMotion?: boolean           — prefers-reduced-motion：跳过入场动画
// （其余 ctx 字段本页不需要。）
//
// 红线（SPEC §1.3 / 任务 D 红线 4）：省时只统计本人确认过的——数据侧由契约
// sanitizeSavedTime 的 confirmedMinutes 保证（web/story/contracts.js「只统计
// 本人确认过的（红线）」注释），本页只读 stats.savedTime，绝不从预留或
// 估计推导数字；页脚固定「只算你确认过的时间 · 长按看口径」（原型 p5）。
//
// 去向展示映射：契约 allocations[].use 存账本 use kind 原始真值（KINDS 六值，
// 见 contracts.js sanitizeSavedTime 注释「去向按账本 use kind 存原始真值」）；
// SPEC §3 ⑤ 的六个去向词（运动、陪家人、学新东西、早点睡、兴趣、其他）是
// 展示层词汇，本页定义 KIND → {label, icon} 的一一映射（六对六）：
//   restore→运动（恢复类：跑步、锻炼）  connect→陪家人（相聚）
//   explore→学新东西（探索）            stillness→早点睡（自己的时间/静息）
//   create→兴趣（创作型兴趣）           necessary→其他（必要杂务）
// 该映射为本线裁量（SPEC 未逐词配对），已在证据 st-t6-pages-b.md 标注待 CTO 确认。

import { KINDS } from '../contracts.js';

export var PAGE_TYPE = 'savedTime';

export var SAVED_USE_META = {
  restore: { label: '运动', icon: '🏃' },
  connect: { label: '陪家人', icon: '👨‍👩‍👧' },
  explore: { label: '学新东西', icon: '📚' },
  stillness: { label: '早点睡', icon: '🌙' },
  create: { label: '兴趣', icon: '🎨' },
  necessary: { label: '其他', icon: '🧺' },
};

// 空状态文案：事实性，不鸡汤、不硬凑（红线 4），不使用「留白」。
export var EMPTY_NOTE = '这个月你还没有确认过省下的时间。';

// 分钟 → 主数字（1 位小数，整数值不带 .0；原型 p5 「6 小时」）。
export function formatHours(minutes) {
  var h = minutes / 60;
  var s = (Math.round(h * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// 分钟 → 条目行（固定 1 位小数 + h；原型 p5 「2.5h / 1.8h / 1.0h / 0.7h」）。
export function formatHoursShort(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

// captions 槽：freed.lead（narrative 线模板/AI 润色的落点；缺省走本页事实文案）。
export function captionDefaults(model) {
  return { 'freed.lead': (model && model.lead) || EMPTY_NOTE };
}

export function buildSavedTimeModel(chapter) {
  var saved = (chapter && chapter.stats && chapter.stats.savedTime) || null;
  var captions = (chapter && chapter.captions) || {};
  var confirmed =
    saved && typeof saved.confirmedMinutes === 'number' ? saved.confirmedMinutes : 0;
  var allocations = (saved && Array.isArray(saved.allocations) ? saved.allocations : [])
    .filter(function (row) {
      return (
        row &&
        KINDS.indexOf(row.use) >= 0 &&
        typeof row.minutes === 'number' &&
        row.minutes > 0
      );
    });

  // 条形宽度相对最大去向归一：原型 150/108/60/42 → 100%/72%/40%/28%。
  var maxMinutes = allocations.reduce(function (m, row) { return Math.max(m, row.minutes); }, 0);
  var rows = allocations
    .map(function (row) {
      var meta = SAVED_USE_META[row.use];
      return {
        kind: row.use,
        label: meta.label,
        icon: meta.icon,
        hours: formatHoursShort(row.minutes),
        pct: maxMinutes > 0 ? Math.round((row.minutes / maxMinutes) * 100) : 0,
        minutes: row.minutes,
      };
    })
    .sort(function (a, b) {
      return b.minutes - a.minutes || // 降序；并列保持 allocations 原序（稳定排序）
        allocations.findIndex(function (r) { return r.use === a.kind; }) -
        allocations.findIndex(function (r) { return r.use === b.kind; });
    });

  var defaultLead = confirmed > 0 ? '你把它们，给了这些：' : EMPTY_NOTE;
  return {
    pageType: PAGE_TYPE,
    hasConfirmed: confirmed > 0,
    hoursLabel: formatHours(confirmed),
    lead: typeof captions['freed.lead'] === 'string' && captions['freed.lead']
      ? captions['freed.lead']
      : defaultLead,
    emptyNote: EMPTY_NOTE,
    rows: confirmed > 0 ? rows : [],
    footnote: '只算你确认过的时间 · 长按看口径',
  };
}

// ---------------------------------------------------------------------------
// DOM 渲染（原型 p5 结构：.pg.p5 → moon / inner → k, num, lead, alloc, foot）。
// 入场动效「条形随鼓点逐条长出」（SPEC §3 ⑤）：WAAPI 逐条 stagger，宽度从 0
// 长到 pct；reducedMotion 时直接终态。DOM/WAAPI 只在本函数调用时触碰。
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderSavedTimePage(chapter, ctx) {
  ctx = ctx || {};
  var model = buildSavedTimeModel(chapter);
  var page = el('section', 'pg p5');
  page.dataset.storyPage = PAGE_TYPE;

  var moon = el('span', 'moon');
  page.appendChild(moon);

  var inner = el('div', 'inner');
  page.appendChild(inner);

  inner.appendChild(el('span', 'k', 'AI 帮你省下的'));

  var num = el('span', 'num');
  num.style.marginTop = '14px';
  num.dataset.metric = 'savedTime.confirmedMinutes';
  num.appendChild(document.createTextNode(model.hoursLabel));
  var unit = el('small', null, '小时');
  num.appendChild(unit);
  inner.appendChild(num);

  inner.appendChild(el('p', 'lead', model.lead));

  var alloc = el('div', 'alloc');
  alloc.style.marginTop = '22px';
  inner.appendChild(alloc);

  model.rows.forEach(function (row, index) {
    var line = el('div');
    var ico = el('span', 'ico', row.icon);
    var t = el('span', 't');
    t.appendChild(el('b', null, row.label));
    var bar = el('i');
    bar.dataset.metric = 'savedTime.allocations.' + row.kind;
    bar.style.width = row.pct + '%';
    t.appendChild(bar);
    line.appendChild(ico);
    line.appendChild(t);
    line.appendChild(el('span', 'h', row.hours));
    alloc.appendChild(line);

    // 条形逐条长出（SPEC §3 ⑤「随鼓点」）：默认 120ms/条兜底；宿主（player/
    // lab）经 ctx.barStaggerMs 传入本章配乐的每拍时长（plan.params.beat），
    // 音乐在播时逐条严格踩拍，无音乐时用固定步进。
    var staggerMs = typeof ctx.barStaggerMs === 'number' && ctx.barStaggerMs > 0 ? ctx.barStaggerMs : 120;
    if (bar.animate && !ctx.reducedMotion) {
      bar.style.width = '0%';
      bar.animate(
        [{ width: '0%' }, { width: row.pct + '%' }],
        { duration: 480, delay: index * staggerMs, fill: 'forwards', easing: 'ease-out' }
      ).onfinish = function () { bar.style.width = row.pct + '%'; };
    }
  });

  var foot = el('div', 'foot');
  foot.appendChild(el('span', null, model.footnote));
  foot.appendChild(el('span', null, '›'));
  inner.appendChild(foot);

  return page;
}
