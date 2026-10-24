// web/story/pages/year-wall.js — 年书 年度四格墙（12 张月度四格拼成的年度墙）
// (SPEC §2 年度专属；page type 'yearWall'；contracts YEAR_PAGE_TYPES)。
//
// 数据：契约 stats.panels（sanitizePanels 上限恰为 12 = 12 个月；年书生成方
// 逐月各出一行：label「N月」+ 当月四格主题句 ≤24 字）。每行渲染为一格：
// 月标 + 主题句 + 2×2 迷你四格纹样。纹样四色 = 原型 p7 四格底色循环
// #6E8FD6/#E8B04B/#E9826A/#5FA67F（按格位轮转的装饰，与原型月章四格同为
// 位置性配色，不冒充数据；aria-hidden）。格数不足 12（周年书/未满年）如实
// 渲染 N 格；无月度四格 → 事实性空态。
//
// 文案可编辑：沿用 T6 four.js 的 captions key 约定 panels-<i>（第 i 格覆盖）。
//
// 视觉：月章 ⑦ 浅色纸面（#F4EFE4/#2a2620）；3×4 宫格、逐格翻入
// （rotateY 翻开，月章四格同语言）；reduce → 直接终态。
// 【跨线注意】浅色页，player.js LIGHT_PAGES 需加 yearWall（见 pending）。
// Caption key: yearWall.title。

import { esc, periodYear } from './year-common.js';

export var PAGE_TYPE = 'yearWall';
export var METRICS = [];
export var CELL_STAGGER_MS = 150;
export var PANEL_CYCLE = ['#6E8FD6', '#E8B04B', '#E9826A', '#5FA67F'];

function readPanels(stats) {
  var raw = stats && Array.isArray(stats.panels) ? stats.panels : [];
  var rows = [];
  for (var i = 0; i < raw.length && rows.length < 12; i += 1) {
    var row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    var label = String(row.label == null ? '' : row.label).trim().slice(0, 12);
    var caption = String(row.caption == null ? '' : row.caption).trim().slice(0, 24);
    if (!label || !caption) continue;
    rows.push({ label: label, caption: caption });
  }
  return rows;
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'yearWall.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.period) return null;
  var rows = readPanels(chapter.stats);
  var year = periodYear(chapter);
  var count = rows.length;
  var title = count === 12
    ? '十二个月，拼成这一年'
    : count > 0 ? count + ' 个月，拼成这一年' : '这一年还没有月度四格';
  return { year: year, rows: rows, count: count, empty: count === 0, title: title };
}

function glyphHtml(index) {
  var out = '';
  for (var j = 0; j < 4; j += 1) {
    out += '<i style="background:' + PANEL_CYCLE[(index + j) % 4] + '"></i>';
  }
  return out;
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = String(cap['yearWall.title'] != null ? cap['yearWall.title'] : model.title);
  var head = '<span class="st-k">' + esc(model.year) + ' 年度墙</span>' +
    '<h1 class="st-big st-ywall-title">' + esc(title) + '</h1>';
  var foot = '<div class="st-foot"><span>每月一格，来自当月四格</span><span>›</span></div>';
  if (model.empty) {
    return '<div class="st-page st-ywall"><div class="st-ywall-inner">' + head +
      '<div class="st-ywall-empty">月度章节的每月四格，会在这里拼成一面墙。</div>' +
      foot + '</div></div>';
  }
  var cells = '';
  for (var i = 0; i < model.rows.length; i += 1) {
    var row = model.rows[i];
    var caption = cap['panels-' + i] != null ? String(cap['panels-' + i]) : row.caption;
    cells += '<div class="st-ywall-cell" style="animation-delay:' + (i * CELL_STAGGER_MS) + 'ms">' +
      '<span class="st-ywall-glyph" aria-hidden="true">' + glyphHtml(i) + '</span>' +
      '<small>' + esc(row.label) + '</small>' +
      '<b>' + esc(caption) + '</b></div>';
  }
  return '<div class="st-page st-ywall"><div class="st-ywall-inner">' + head +
    '<div class="st-ywall-grid">' + cells + '</div>' + foot + '</div></div>';
}

export var PAGE_CSS = [
  '.st-page.st-ywall{background:#F4EFE4;color:#2a2620}',
  '.st-ywall-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.7}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;line-height:1.18;margin-top:12px}',
  '.st-ywall-title{font-size:30px}',
  '.st-ywall-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px;',
  '  overflow:auto;min-height:0;flex:1}',
  '.st-ywall-cell{background:rgba(42,38,32,.05);border-radius:16px;padding:12px;min-height:118px;',
  '  display:flex;flex-direction:column;transform-origin:50% 50%;',
  '  animation:st-ywall-flip 260ms cubic-bezier(.22,.61,.36,1) both;overflow:hidden}',
  '@keyframes st-ywall-flip{from{transform:rotateY(90deg);opacity:0}to{transform:none;opacity:1}}',
  '.st-ywall-glyph{display:grid;grid-template-columns:1fr 1fr;gap:3px;width:25px}',
  '.st-ywall-glyph i{width:11px;height:11px;border-radius:3px}',
  '.st-ywall-cell small{font-size:10.5px;opacity:.6;letter-spacing:1px;margin-top:8px}',
  '.st-ywall-cell b{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-size:14.5px;',
  '  line-height:1.45;margin-top:4px;font-weight:700}',
  '.st-ywall-empty{margin-top:22px;border-radius:18px;background:rgba(42,38,32,.06);',
  '  padding:18px;font-size:14px;line-height:1.7;opacity:.85}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between;padding-top:10px}',
  '.st-ywall.st-reduce .st-ywall-cell{animation:none}',
].join('\n');

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
      var root = el.querySelector('.st-ywall');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
    },
    unmount: function () {
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}

export function renderPage(page, ctx) {
  var c = ctx || {};
  var params = page && page.params ? page.params : undefined;
  return pageView(pageModel(c.chapter, params), c.captions);
}
