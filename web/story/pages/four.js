// web/story/pages/four.js — ⑦ 四格与关键词（SPEC §3 ⑦，原型 p7）。
//
// 页型接口（本线五页统一）：
//   buildPanelsModel(chapter)          → 纯 view-model（node 可测，不改 chapter）
//   renderPanelsPage(chapter, ctx)     → HTMLElement（DOM 仅在调用时触碰）
//     ctx.reducedMotion?: boolean      — 跳过「四格依次翻开」入场动画
//
// captions key 约定（本线定义；契约 sanitizeCaptions 只锁形状/上限）：
//   PANEL_CAPTION_KEY + '-<i>'  → 覆盖第 i 格旁白（用户可编辑，SPEC §5）。
// 旁白来源与 ≤24 字上限由契约 sanitizePanels 保证；页面只做展示与覆盖。
//
// 四格底色锁定原型 p7 循环：explore 蓝 / create 金 / connect 橘 / restore 绿
// （>4 格时循环取色；月章恰为四周四格）。
// 关键词字号：weight 相对最大词线性映射 17..38px（原型六词 38/30/26/22/20/17
// 与 weight 比 1/.62/.43/.24/.14/0 完全吻合）；第二大词用原型红 #B8401F 点缀，
// 最小词 opacity .7（对齐原型可见效果）。

import { monthNameOf } from './rhythm.js';

export var PAGE_TYPE = 'panels';

export var PANEL_COLORS = ['#6E8FD6', '#E8B04B', '#E9826A', '#5FA67F'];

export var PANEL_CAPTION_KEY = 'panels';

export var KEYWORD_MIN_PX = 17;
export var KEYWORD_MAX_PX = 38;
export var KEYWORD_SECOND_COLOR = '#B8401F';

// weight → 字号（px，整数）：最大词 38，零权重 17，中间线性。
export function keywordFontSize(weight, maxWeight) {
  var max = maxWeight > 0 ? maxWeight : 1;
  var w = typeof weight === 'number' && weight > 0 ? weight : 0;
  var ratio = Math.min(1, w / max);
  return Math.round(KEYWORD_MIN_PX + (KEYWORD_MAX_PX - KEYWORD_MIN_PX) * ratio);
}

export function buildPanelsModel(chapter) {
  var stats = chapter && chapter.stats;
  var captions = (chapter && chapter.captions) || {};
  var month = monthNameOf(chapter);
  var rawPanels = (stats && Array.isArray(stats.panels) ? stats.panels : []).map(
    function (row, index) {
      var overrideKey = PANEL_CAPTION_KEY + '-' + index;
      return {
        label: row.label,
        caption: captions[overrideKey] || row.caption,
        color: PANEL_COLORS[index % PANEL_COLORS.length],
      };
    }
  );
  var rawWords = stats && Array.isArray(stats.keywords) ? stats.keywords : [];
  var maxWeight = 0;
  for (var i = 0; i < rawWords.length; i += 1) {
    if (rawWords[i].weight > maxWeight) maxWeight = rawWords[i].weight;
  }
  var last = rawWords.length - 1;
  var keywords = rawWords.map(function (row, index) {
    return {
      word: row.word,
      size: keywordFontSize(row.weight, maxWeight),
      color: index === 1 && rawWords.length > 1 ? KEYWORD_SECOND_COLOR : null,
      dim: index === last && rawWords.length > 1,
    };
  });
  return {
    pageType: PAGE_TYPE,
    heading: '你的' + month + '四格',
    panels: rawPanels,
    keywordsHeading: month + '关键词',
    keywords: keywords,
    footnote: '旁白由 AI 根据统计生成，可修改',
  };
}

// ---------------------------------------------------------------------------
// DOM 渲染（原型 p7：.pg.p7 浅底 → inner → k, .four 2×2, 关键词, foot）。
// 动效「四格依次翻开」（SPEC §3 ⑦）：rotateY 翻入 stagger；reducedMotion 直接终态。
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderPanelsPage(chapter, ctx) {
  ctx = ctx || {};
  var model = buildPanelsModel(chapter);
  var page = el('section', 'pg p7');
  page.dataset.storyPage = PAGE_TYPE;

  var inner = el('div', 'inner');
  page.appendChild(inner);

  inner.appendChild(el('span', 'k', model.heading));

  var grid = el('div', 'four');
  grid.style.marginTop = '20px';
  inner.appendChild(grid);
  model.panels.forEach(function (panel, index) {
    var cell = el('div');
    cell.style.background = panel.color;
    cell.appendChild(el('small', null, panel.label));
    var cap = el('b', null, panel.caption);
    cap.dataset.metric = 'panels.' + index;
    cell.appendChild(cap);
    grid.appendChild(cell);

    if (cell.animate && !ctx.reducedMotion) {
      cell.animate(
        [
          { transform: 'perspective(600px) rotateY(90deg)', opacity: '0' },
          { transform: 'perspective(600px) rotateY(0deg)', opacity: '1' },
        ],
        { duration: 420, delay: index * 180, fill: 'backwards', easing: 'ease-out' }
      );
    }
  });

  inner.appendChild(el('p', 'k', model.keywordsHeading)).style.marginTop = '20px';

  var kw = el('div', 'kw');
  kw.style.marginTop = '16px';
  inner.appendChild(kw);
  model.keywords.forEach(function (row) {
    var span = el('span', null, row.word);
    span.style.fontSize = row.size + 'px';
    if (row.color) span.style.color = row.color;
    if (row.dim) span.style.opacity = '.7';
    span.dataset.metric = 'keywords.' + row.word;
    kw.appendChild(span);
  });

  var foot = el('div', 'foot');
  foot.appendChild(el('span', null, model.footnote));
  foot.appendChild(el('span', null, '›'));
  inner.appendChild(foot);

  return page;
}
