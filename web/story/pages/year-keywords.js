// web/story/pages/year-keywords.js — 年书 年度十大关键词
// (SPEC §2 年度专属；page type 'yearKeywords'；contracts YEAR_PAGE_TYPES)。
//
// 数据：契约 stats.keywords（sanitizeKeywords 上限恰为 10，「Top 6 / 年度十大」
// 同一字段），页型参数 topN（契约白名单 1..20，契约页参数已校验，此处只做
// 防御性复检）。按权重降序、字号线性映射 17..38px（与 T6 four.js 月章关键词
// 同一约定：原型 p7 六词 38/30/26/22/20/17 与权重比吻合）；第二大词红
// #B8401F、末位 opacity .7（原型逐值）。词数不足 10 时标题如实说 N 个，
// 不硬凑「十大」。
//
// 视觉：月章 ⑦ 的浅色纸面（#F4EFE4 / #2a2620，原型 p7）；词云逐个浮起。
// 【跨线注意】本页为浅色页，player.js LIGHT_PAGES 目前只列
// specialDay/panels——集成时需把 yearKeywords（和 yearWall）加进浅色页清单
// （player 非本线文件，已列入 pending）。
// Caption key: yearKeywords.title。

import { esc, periodYear } from './year-common.js';

export var PAGE_TYPE = 'yearKeywords';
export var METRICS = ['keywords.top'];
export var SIZE_MIN = 17;
export var SIZE_MAX = 38;
export var WORD_STAGGER_MS = 90;
var DEFAULT_TOP_N = 10;

function readKeywords(stats) {
  var raw = stats && Array.isArray(stats.keywords) ? stats.keywords : [];
  var rows = [];
  for (var i = 0; i < raw.length && rows.length < DEFAULT_TOP_N * 2; i += 1) {
    var row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    var word = String(row.word == null ? '' : row.word).trim();
    if (!word || word.length > 16) continue; // 契约口径：>16 字的词拒绝，不截断
    if (typeof row.weight !== 'number' || !Number.isFinite(row.weight) || row.weight <= 0) continue;
    rows.push({ word: word, weight: row.weight });
  }
  rows.sort(function (a, b) { return b.weight - a.weight; });
  return rows;
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'yearKeywords.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.period) return null;
  var topN = DEFAULT_TOP_N;
  if (params && typeof params.topN === 'number' && Number.isFinite(params.topN)
    && params.topN >= 1) {
    topN = Math.min(Math.floor(params.topN), 20);
  }
  var rows = readKeywords(chapter.stats).slice(0, topN);
  var max = rows.length ? rows[0].weight : 0;
  var sized = [];
  for (var i = 0; i < rows.length; i += 1) {
    var ratio = max > 0 ? rows[i].weight / max : 0;
    var size = Math.round(SIZE_MIN + ratio * (SIZE_MAX - SIZE_MIN));
    sized.push({
      word: rows[i].word,
      weight: rows[i].weight,
      size: Math.min(SIZE_MAX, Math.max(SIZE_MIN, size)),
    });
  }
  var year = periodYear(chapter);
  var count = sized.length;
  var title = count >= DEFAULT_TOP_N
    ? year + ' 年的十个关键词'
    : count > 0 ? year + ' 年的 ' + count + ' 个关键词' : year + ' 年还没有关键词';
  return { year: year, rows: sized, count: count, empty: count === 0, title: title };
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = String(cap['yearKeywords.title'] != null ? cap['yearKeywords.title'] : model.title);
  var head = '<span class="st-k">这一年，它们出现得最多</span>' +
    '<h1 class="st-big st-ykw-title">' + esc(title) + '</h1>';
  var foot = '<div class="st-foot"><span>来自事项标题分词 · 去掉停用词</span><span>›</span></div>';
  if (model.empty) {
    return '<div class="st-page st-ykw"><div class="st-ykw-inner">' + head +
      '<div class="st-ykw-empty">这一年的事项标题里，还没有抽出关键词。</div>' +
      foot + '</div></div>';
  }
  var spans = '';
  for (var i = 0; i < model.rows.length; i += 1) {
    var cls = 'st-ykw';
    if (i === 1) cls += ' st-ykw-2';
    if (i === model.rows.length - 1 && model.rows.length > 1) cls += ' st-ykw-last';
    spans += '<span class="' + cls + '" style="font-size:' + model.rows[i].size +
      'px;animation-delay:' + (i * WORD_STAGGER_MS) + 'ms">' + esc(model.rows[i].word) + '</span>';
  }
  return '<div class="st-page st-ykw"><div class="st-ykw-inner">' + head +
    '<div class="st-ykw-cloud" data-metric="keywords.top">' + spans + '</div>' +
    foot + '</div></div>';
}

export var PAGE_CSS = [
  '.st-page.st-ykw{background:#F4EFE4;color:#2a2620}',
  '.st-ykw-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.7}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;line-height:1.18;margin-top:12px}',
  '.st-ykw-title{font-size:32px}',
  '.st-ykw-cloud{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:baseline;margin-top:28px}',
  '.st-ykw-cloud span{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;',
  '  animation:st-ykw-rise 380ms cubic-bezier(.22,.61,.36,1) both}',
  '@keyframes st-ykw-rise{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}',
  '.st-ykw-cloud .st-ykw-2{color:#B8401F}',
  '.st-ykw-cloud .st-ykw-last{opacity:.7}',
  '.st-ykw-empty{margin-top:22px;border-radius:18px;background:rgba(42,38,32,.06);',
  '  padding:18px;font-size:14px;line-height:1.7;opacity:.85}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-ykw.st-reduce .st-ykw-cloud span{animation:none}',
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
      var root = el.querySelector('.st-ykw');
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
