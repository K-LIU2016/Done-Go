// web/story/pages/year-genres.js — 年书 年度流派变化史
// (SPEC §2 年度专属；page type 'yearGenres'；contracts YEAR_PAGE_TYPES)。
//
// 视觉：十二枚「月章」横向排开（月标 + 流派名，底色 = social PRD §3.2 六派
// 色，与同频/T6 rhythm.js 同 id 同色），流派切换的月份加白描边标记；
// 下方「年度流派卡」沿用原型 p6 .arche 卡（全年真值，来自契约
// stats.rhythm.genre，今天就有）。最长停留流派给一句事实总结。
//
// 数据：逐月流派来自拟扩展形状 stats.year.months[].genre（year-common.js
// 头注，待 CTO 裁决）。无逐月数据（契约现状/月度未积累）→ 只渲染年度卡 +
// 事实性说明，不硬凑变化史。无数据月份（genre null）渲染暗章「—」，
// 不断档也不算变化。
//
// 动效：月章依次浮起（70ms 错峰），变化章额外弹一下；reduce → 直接终态。
// Caption key: yearGenres.title。

import { esc, sanitizeYearMonths, genreColor, periodYear } from './year-common.js';

export var PAGE_TYPE = 'yearGenres';
export var METRICS = ['rhythm.genre'];
export var CHIP_STAGGER_MS = 70;

function readYearGenre(stats) {
  var g = stats && stats.rhythm && stats.rhythm.genre;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  var id = String(g.id == null ? '' : g.id);
  var title = String(g.title == null ? '' : g.title).trim();
  if (!id || !title) return null;
  var tagline = String(g.tagline == null ? '' : g.tagline).trim();
  return { id: id, title: title, tagline: tagline };
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'yearGenres.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.period) return null;
  var stats = chapter.stats;
  var months = sanitizeYearMonths(stats.year && stats.year.months);
  var yearGenre = readYearGenre(stats);

  var chips = [];
  var changes = 0;
  var lastGenreId = null;
  var distinctSet = {};
  var runBest = null; // {id,title,months,fromM}
  var run = null;     // {id,title,months}
  if (months) {
    for (var i = 0; i < months.length; i += 1) {
      var g = months[i].genre;
      var change = false;
      if (g) {
        distinctSet[g.id] = true;
        if (lastGenreId !== null && g.id !== lastGenreId) change = true;
        if (!run || run.id !== g.id) {
          if (run && (!runBest || run.months > runBest.months)) runBest = run;
          run = { id: g.id, title: g.title, months: 1 };
        } else {
          run.months += 1;
        }
      } else {
        // 无数据月断开停留统计：不能宣称「穿过未知仍在同一流派」
        if (run && (!runBest || run.months > runBest.months)) runBest = run;
        run = null;
      }
      if (change) changes += 1;
      if (g) lastGenreId = g.id;
      chips.push({ m: months[i].m, genre: g, change: change, dim: !g });
    }
    if (run && (!runBest || run.months > runBest.months)) runBest = run;
  }
  var distinctIds = Object.keys(distinctSet);
  var longest = runBest && runBest.months > 0
    ? { id: runBest.id, title: runBest.title, months: runBest.months }
    : null;

  var title;
  if (distinctIds.length >= 2) title = distinctIds.length + ' 种流派，走过这一年';
  else if (distinctIds.length === 1) title = '一整年，都是' + longest.title;
  else title = '这一年的流派';

  return {
    year: periodYear(chapter),
    hasMonths: !!months && months.length > 0,
    chips: chips,
    changes: changes,
    distinct: distinctIds.length,
    longest: longest,
    yearGenre: yearGenre,
    title: title,
  };
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = String(cap['yearGenres.title'] != null ? cap['yearGenres.title'] : model.title);
  var head = '<span class="st-k">' + esc(model.year) + ' 年的流派变化</span>' +
    '<h1 class="st-big st-yg-title">' + esc(title) + '</h1>';
  var foot = '<div class="st-foot"><span>流派规则与同频一致 · 可解释</span><span>›</span></div>';
  var showChips = model.chips.some(function (c) { return !!c.genre; });

  var body = '';
  if (showChips) {
    var chips = '';
    for (var i = 0; i < model.chips.length; i += 1) {
      var chip = model.chips[i];
      var color = chip.genre ? genreColor(chip.genre.id) : null;
      var bg = chip.genre
        ? (color || 'rgba(255,255,255,.14)')
        : 'rgba(255,255,255,.06)';
      var attrs = chip.change ? ' data-change="1"' : '';
      if (chip.dim) attrs += ' data-dim="1"';
      chips += '<span class="st-yg-chip' + (chip.dim ? ' st-yg-dim' : '') +
        (chip.change ? ' st-yg-change' : '') + '" style="background:' + bg +
        ';animation-delay:' + (i * CHIP_STAGGER_MS) + 'ms"' + attrs + '>' +
        '<small>' + chip.m + '月</small><b>' + esc(chip.genre ? chip.genre.title : '—') + '</b></span>';
    }
    body += '<div class="st-yg-chips">' + chips + '</div>';
    if (model.longest) {
      body += '<p class="st-yg-longest">' + esc(model.longest.title) + ' 陪你最久，' +
        model.longest.months + ' 个月</p>';
    }
  } else {
    body += '<p class="st-yg-note">逐月的流派，要等月度章节积累起来。</p>';
  }

  var card;
  if (model.yearGenre) {
    var gc = genreColor(model.yearGenre.id);
    card = '<div class="st-yg-card" data-metric="rhythm.genre"' +
      (gc ? ' style="box-shadow:inset 0 0 0 1px ' + gc + '55"' : '') + '>' +
      '<small>' + esc(model.year) + ' 年你的时间流派</small>' +
      '<b>' + esc(model.yearGenre.title) + '</b>' +
      '<p>' + esc(model.yearGenre.tagline) + '</p></div>';
  } else {
    card = '<div class="st-yg-card"><small>' + esc(model.year) + ' 年你的时间流派</small>' +
      '<b>流派待定</b><p>这一年的数据还不足以判定流派。</p></div>';
  }
  body += card;

  return '<div class="st-page st-yg"><div class="st-yg-inner">' + head + body + foot + '</div></div>';
}

export var PAGE_CSS = [
  '.st-page.st-yg{background:#0F1424;color:#fff}',
  '.st-yg-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;line-height:1.18;margin-top:12px}',
  '.st-yg-title{font-size:30px}',
  '.st-yg-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}',
  '.st-yg-chip{min-width:76px;border-radius:14px;padding:8px 10px;text-align:center;color:#fff;',
  '  animation:st-yg-rise 360ms cubic-bezier(.22,.61,.36,1) both}',
  '@keyframes st-yg-rise{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}',
  '.st-yg-chip small{display:block;font-size:10px;opacity:.8;letter-spacing:1px}',
  '.st-yg-chip b{display:block;font-size:13px;margin-top:3px;font-weight:700;white-space:nowrap}',
  '.st-yg-dim{opacity:.55}',
  '.st-yg-change{outline:2px solid rgba(255,255,255,.85);outline-offset:2px;',
  '  animation:st-yg-rise 360ms cubic-bezier(.22,.61,.36,1) both,st-yg-pop 420ms ease 360ms both}',
  '@keyframes st-yg-pop{0%{transform:scale(1)}45%{transform:scale(1.12)}100%{transform:scale(1)}}',
  '.st-yg-longest{font-size:13px;opacity:.85;margin-top:14px}',
  '.st-yg-note{font-size:12.5px;opacity:.7;margin-top:16px;line-height:1.7}',
  '.st-yg-card{margin-top:18px;border-radius:20px;padding:16px;',
  '  background:linear-gradient(135deg,#3B6A82,#24475A)}',
  '.st-yg-card small{font-size:11.5px;opacity:.8;letter-spacing:1px}',
  '.st-yg-card b{display:block;font-family:"Songti SC","Noto Serif SC","STSong",serif;',
  '  font-size:26px;margin-top:4px;font-weight:900}',
  '.st-yg-card p{font-size:13px;opacity:.9;margin-top:4px;line-height:1.6}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-yg.st-reduce .st-yg-chip{animation:none}',
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
      var root = el.querySelector('.st-yg');
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
