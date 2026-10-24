// web/story/pages/year-spectrum.js — 年书 12 个月的时间光谱长卷
// (SPEC §2 年度专属；page type 'yearSpectrum'；contracts YEAR_PAGE_TYPES)。
//
// 视觉：月章 ②「时间的颜色」(prototype .p2) 的年度延展——十二根月柱并排成
// 一幅长卷，每根柱内六个类别色带按 KINDS 规范序自底向上堆叠（跨月同一类别
// 处于同一水平层，读得出某类时间在全年的消长）；柱下月标；年份图例沿用
// 契约 stats.kindMinutes（全年真值，今天就有）。色板 = 原型 --k-* 六色渐变。
//
// 数据：逐月组成来自拟扩展形状 stats.year.months（见 year-common.js 头注，
// 待 CTO 裁决）。契约未扩展前渲染事实性空态，不硬凑 12 根柱。
//
// 动效：月柱自下而上铺开（transform-origin bottom scaleY，SPEC ② 同语言），
// COL_STAGGER_MS 逐柱错峰；prefers-reduced-motion → 直接铺满。
// 接口约定与 T5页型A spectrum.js 文件头一致（PAGE_TYPE/METRICS/PAGE_CSS/
// captionDefaults/pageModel/pageView/createPage），另导出 player 用的
// renderPage(page, ctx) 适配器。Caption key: yearSpectrum.title。

import { KINDS } from '../contracts.js';
import {
  KIND_COLORS, KIND_LABELS, KIND_COLOR_NAMES,
  esc, sanitizeYearMonths, readKindMinutes, periodYear,
} from './year-common.js';

export var PAGE_TYPE = 'yearSpectrum';
export var METRICS = KINDS.map(function (k) { return 'kindMinutes.' + k; });
export var COL_STAGGER_MS = 90;

function monthsLabel(n) {
  return n === 12 ? '十二个月' : n + ' 个月';
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'yearSpectrum.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.period) return null;
  var stats = chapter.stats;
  var yearRows = readKindMinutes(stats);
  if (!yearRows) return null;
  var months = sanitizeYearMonths(stats.year && stats.year.months);

  // 全年图例：share 降序（并列按 KINDS 序）——月章 ② 同规则
  var legend = yearRows.slice().sort(function (a, b) {
    return b.share - a.share || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
  });
  var dominant = legend[0];

  var columns = [];
  var busiestM = 0;
  var busiestEvents = -1;
  if (months) {
    for (var i = 0; i < months.length; i += 1) {
      var bands = [];
      for (var j = 0; j < months[i].kindMinutes.length; j += 1) {
        bands.push({
          kind: months[i].kindMinutes[j].kind,
          pct: Math.round(months[i].kindMinutes[j].share * 100),
        });
      }
      columns.push({ m: months[i].m, events: months[i].events, bands: bands });
      if (months[i].events > busiestEvents) {
        busiestEvents = months[i].events;
        busiestM = months[i].m;
      }
    }
  }

  var year = periodYear(chapter);
  var hasColumns = columns.length > 0;
  var title = hasColumns
    ? monthsLabel(columns.length) + '，' + KIND_COLOR_NAMES[dominant.kind] + '的'
      + KIND_LABELS[dominant.kind] + '贯穿全年'
    : '这一年还没有逐月的时间数据';

  return {
    year: year,
    empty: !hasColumns,
    title: title,
    columns: columns,
    busiestM: hasColumns ? busiestM : 0,
    busiestEvents: hasColumns ? busiestEvents : 0,
    legend: legend.map(function (r) {
      return { kind: r.kind, minutes: r.minutes, pct: Math.round(r.share * 100) };
    }),
    dominantKind: dominant.kind,
    kLabel: hasColumns
      ? year + ' 年，你的' + (columns.length === 12 ? '十二个月' : ' ' + columns.length + ' 个月')
      : year + ' 年的时间光谱',
  };
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = String(cap['yearSpectrum.title'] != null ? cap['yearSpectrum.title'] : model.title);
  if (model.empty) {
    return (
      '<div class="st-page st-yspec">' +
        '<div class="st-ys-inner">' +
          '<span class="st-k">' + esc(model.kLabel) + '</span>' +
          '<h1 class="st-big st-ys-title">' + esc(title) + '</h1>' +
          '<div class="st-ys-empty">月度章节积累起来之后，这里会展开逐月的色带。</div>' +
          '<div class="st-foot"><span>按事项计划时长统计 · 长按看口径</span><span>轻点继续 ›</span></div>' +
        '</div>' +
      '</div>'
    );
  }
  var cols = '';
  for (var i = 0; i < model.columns.length; i += 1) {
    var col = model.columns[i];
    var bands = '';
    for (var j = 0; j < col.bands.length; j += 1) {
      var b = col.bands[j];
      var c = KIND_COLORS[b.kind] || { base: '#888888', top: '#999999' };
      bands += '<i style="height:' + b.pct + '%;background:linear-gradient(180deg,' + c.top + ',' + c.base + ')"></i>';
    }
    cols += '<div class="st-ys-col" style="animation-delay:' + (i * COL_STAGGER_MS) + 'ms" data-m="' + col.m + '"' +
      ' title="' + col.m + ' 月 ' + col.events + ' 件事">' +
      '<div class="st-ys-bands">' + bands + '</div>' +
      '<span class="st-ys-lab">' + col.m + '月</span></div>';
  }
  var legend = '';
  for (var t = 0; t < model.legend.length; t += 1) {
    var row = model.legend[t];
    var rc = KIND_COLORS[row.kind] || { base: '#888888' };
    legend += '<span class="st-ys-lg-row" data-metric="kindMinutes.' + row.kind + '"><b style="background:' +
      rc.base + '"></b>' + esc(KIND_LABELS[row.kind]) + ' ' + row.pct + '%</span>';
  }
  return (
    '<div class="st-page st-yspec">' +
      '<div class="st-ys-inner">' +
        '<span class="st-k">' + esc(model.kLabel) + '</span>' +
        '<h1 class="st-big st-ys-title">' + esc(title) + '</h1>' +
        '<div class="st-ys-scroll" role="img" aria-label="十二个月的时间光谱长卷，' +
          esc(String(model.busiestM)) + ' 月最满">' + cols + '</div>' +
        '<div class="st-ys-lg">' + legend + '</div>' +
        '<div class="st-foot"><span>按事项计划时长统计 · 长按看口径</span><span>轻点继续 ›</span></div>' +
      '</div>' +
    '</div>'
  );
}

export var PAGE_CSS = [
  '.st-page.st-yspec{background:#18171D;color:#fff}',
  '.st-ys-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;line-height:1.18;margin-top:12px}',
  '.st-ys-title{font-size:26px}',
  '.st-ys-scroll{display:grid;grid-template-columns:repeat(12,1fr);gap:5px;height:330px;margin-top:20px}',
  '.st-ys-col{display:flex;flex-direction:column;min-width:0;transform-origin:50% 100%;',
  '  animation:st-ys-up 450ms cubic-bezier(.22,.61,.36,1) both}',
  '@keyframes st-ys-up{from{transform:scaleY(0)}to{transform:scaleY(1)}}',
  '.st-ys-bands{flex:1;display:flex;flex-direction:column-reverse;border-radius:8px;overflow:hidden;filter:saturate(1.1)}',
  '.st-ys-bands i{width:100%}',
  '.st-ys-lab{font-size:10px;text-align:center;opacity:.6;margin-top:6px;font-variant-numeric:tabular-nums}',
  '.st-ys-lg{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-top:16px;font-size:13px}',
  '.st-ys-lg-row{display:flex;align-items:center;gap:8px}',
  '.st-ys-lg-row b{width:12px;height:12px;border-radius:4px;display:inline-block}',
  '.st-ys-empty{margin-top:22px;border-radius:18px;background:rgba(255,255,255,.06);',
  '  padding:18px;font-size:14px;line-height:1.7;opacity:.85}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-yspec.st-reduce .st-ys-col{animation:none;transform:none}',
].join('\n');

// T5页型A 统一控制器（mount 注入 scoped 样式；reduceMotion → st-reduce）。
export function createPage(options) {
  var opts = options || {};
  var styleEl = null;
  return {
    type: PAGE_TYPE,
    mount: function (el) {
      if (!el) return;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.setAttribute('data-st-page', PAGE_TYPE);
        styleEl.textContent = PAGE_CSS;
        document.head.appendChild(styleEl);
      }
      el.innerHTML = pageView(opts.model || null, opts.captions || null);
      var root = el.querySelector('.st-yspec');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
    },
    unmount: function () {
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}

// player.createStoryPlayer 的 options.renderPage(page, index, ctx) 适配器。
export function renderPage(page, ctx) {
  var c = ctx || {};
  var params = page && page.params ? page.params : undefined;
  return pageView(pageModel(c.chapter, params), c.captions);
}
