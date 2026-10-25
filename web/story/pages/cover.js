// web/story/pages/cover.js — 时光故事书 ⓪ 封面（SPEC design/story-recap/SPEC.md
// §3 page 0；视觉契约 = design/story-recap/prototype.html .p0，逐值对照）。
//
// T5页型A line deliverable. Data binding comes exclusively from the chapter
// (validated by web/story/contracts.js): 章号 no、period、totals.events/
// aiRelays、savedTime.confirmedMinutes。标题与致谁是可编辑文案 → captions
// （SPEC §5 用户可以编辑任何一句）:
//   cover.title       书名标题（默认由规则模板按下文规则生成，narrative 线
//                     以此为 AI 润色基线；输入只有统计数字）
//   cover.dedication  致谁（默认「致 认真的你」）
//
// Page-module interface (shared convention across pages/*, alignment point
// for the player/T5页型B lines — mirrors the relay v2 home.js precedent):
//   PAGE_TYPE         page id in contracts PAGE_TYPES
//   METRICS           metric keys long-pressable on this page (data-metric
//                     attributes; player.js listens, definitions.js 口径)
//   PAGE_CSS          scoped stylesheet injected by createPage().mount()
//   captionDefaults(model) → { key: 模板文案 }（narrative 线润色基线）
//   pageModel(chapter, params) → view model | null   (pure, node --test-able)
//   pageView(model, captions)  → markup string        (pure, no DOM)
//   createPage(options) → { type, mount(el), unmount() }
//     options: { captions, reduceMotion, onOpen }
//     mount 注入样式、渲染、启动书本浮动动效并接「翻开这一章」点击；
//     onOpen 由 player 转发 soundtrack（SPEC §3 ⓪ 轻点翻开后音乐 2.5 秒淡入）。
//     reduceMotion 关闭浮动（SPEC §1/D5 prefers-reduced-motion 降级）。
//
// Styles are self-contained on purpose: every selector is scoped under
// .st-cover inside .st-page, so web/story/story.css (player chrome/外壳线)
// never collides. Values below are copied verbatim from prototype .p0.

import { CAPTION_MAX } from '../contracts.js';

export var PAGE_TYPE = 'cover';
export var METRICS = ['totals.events', 'totals.aiRelays'];
export var COVER_FLOAT_MS = 6000;

var MONTHS_ZH = ['', '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
var TYPE_LABELS = { week: '周记', month: '月章', year: '年书' };

export function monthZh(m) {
  return MONTHS_ZH[m] || '';
}

export function chapterTag(no, type) {
  return '第 ' + no + ' 章 · ' + (TYPE_LABELS[type] || '');
}

// 2026.10.01 — 10.31；跨年时终点带年（原型封面期间行格式）。
export function periodLine(period) {
  if (!period) return '';
  var from = String(period.from);
  var to = String(period.to);
  var f = from.replace(/-/g, '.');
  var t = to.replace(/-/g, '.');
  if (to.slice(0, 4) !== from.slice(0, 4)) return f + ' — ' + t;
  return f + ' — ' + t.slice(5);
}

function periodName(type, period) {
  if (type === 'week') return '这一周';
  if (type === 'year') return '这一年';
  var m = Number(String(period.from).slice(5, 7));
  return monthZh(m) || '这个月';
}

function hoursLabel(minutes) {
  var h = minutes / 60;
  if (Math.abs(h - Math.round(h)) < 0.05) return String(Math.round(h));
  return (Math.round(h * 10) / 10).toFixed(1);
}

// 规则模板标题（SPEC §5 模板优先）：有确认省时 → 省时；事多 → 记下；否则安静。
// 「事多」阈值按章型分档：周记 8 / 月章 20 / 年书 80。
function busyThreshold(type) {
  if (type === 'week') return 8;
  if (type === 'year') return 80;
  return 20;
}

function defaultHeadline(type, period, stats) {
  var name = periodName(type, period);
  var saved = stats.savedTime ? stats.savedTime.confirmedMinutes : 0;
  if (saved >= 60) return name + '，你把 ' + hoursLabel(saved) + ' 小时还给了自己';
  if (stats.totals.events >= busyThreshold(type)) return name + '，你记下了 ' + stats.totals.events + ' 件事';
  return name + '，安静的一章';
}

export function captionDefaults(model) {
  if (!model) return {};
  return {
    'cover.title': model.headline,
    'cover.dedication': '致 认真的你',
  };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.stats.totals) return null;
  var stats = chapter.stats;
  var period = chapter.period || { from: '', to: '' };
  return {
    no: chapter.no,
    type: chapter.type,
    typeLabel: TYPE_LABELS[chapter.type] || '',
    tag: chapterTag(chapter.no, chapter.type),
    periodLine: periodLine(period),
    events: stats.totals.events,
    aiRelays: stats.totals.aiRelays,
    savedMinutes: stats.savedTime ? stats.savedTime.confirmedMinutes : 0,
    savedHours: stats.savedTime ? hoursLabel(stats.savedTime.confirmedMinutes) : '0',
    headline: defaultHeadline(chapter.type, period, stats),
  };
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clip(text) {
  var s = String(text == null ? '' : text);
  return s.length > CAPTION_MAX ? s.slice(0, CAPTION_MAX) : s;
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var title = clip(cap['cover.title'] != null ? cap['cover.title'] : model.headline);
  var who = clip(cap['cover.dedication'] != null ? cap['cover.dedication'] : '致 认真的你');
  return (
    '<div class="st-page st-cover">' +
      '<div class="st-cover-inner">' +
        '<div class="st-book" role="img" aria-label="' + esc(title) + '">' +
          '<span class="st-book-ch">' + esc(model.tag) + '</span>' +
          '<h2 class="st-book-title">' + esc(title) + '</h2>' +
          '<p class="st-book-meta">' + esc(model.periodLine) + '<br>' +
            '<span data-metric="totals.events">' + model.events + ' 件事</span> · ' +
            '<span data-metric="totals.aiRelays">' + model.aiRelays + ' 次 AI 接力</span></p>' +
          '<span class="st-book-who">' + esc(who) + '</span>' +
        '</div>' +
        '<button type="button" class="st-open"><i aria-hidden="true">📖</i>翻开这一章</button>' +
        '<p class="st-hold">戴上耳机更好 · 约 2 分钟</p>' +
      '</div>' +
    '</div>'
  );
}

export var PAGE_CSS = [
  '.st-cover{background:linear-gradient(160deg,#2C3E35 0%,#1E2B25 100%);color:#fff}',
  '.st-cover-inner{position:absolute;inset:60px 26px 40px;display:flex;flex-direction:column}',
  '.st-book{margin:50px auto 0;width:236px;height:320px;border-radius:6px 16px 16px 6px;',
  '  background:linear-gradient(135deg,#E95432,#B8401F);',
  '  box-shadow:inset 10px 0 0 rgba(0,0,0,.18),0 30px 60px rgba(0,0,0,.45);',
  '  position:relative;padding:28px 22px;display:flex;flex-direction:column;animation:st-book-float ' + COVER_FLOAT_MS + 'ms ease-in-out infinite alternate}',
  '.st-book-ch{font-size:12px;letter-spacing:3px;opacity:.85}',
  '.st-book-title{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;font-size:34px;line-height:1.2;margin-top:18px}',
  '.st-book-meta{font-size:13px;opacity:.85;margin-top:10px;line-height:1.6}',
  '.st-book-who{margin-top:auto;font-size:12px;opacity:.8}',
  '.st-book::after{content:"";position:absolute;right:12px;top:10px;bottom:10px;width:6px;border-radius:3px;',
  '  background:repeating-linear-gradient(180deg,rgba(255,255,255,.5) 0 2px,transparent 2px 5px)}',
  '@keyframes st-book-float{from{transform:translateY(0) rotate(.4deg)}to{transform:translateY(-8px) rotate(-.4deg)}}',
  '.st-open{margin:36px auto 0;height:52px;border-radius:26px;padding:0 30px;background:#fff;color:#1E2B25;',
  '  font-weight:700;font-size:16px;border:0;display:flex;align-items:center;gap:10px;min-width:48px;min-height:48px}',
  '.st-open i{font-style:normal;font-size:18px}',
  '.st-hold{font-size:11.5px;opacity:.65;margin-top:14px;text-align:center}',
  '.st-cover.st-reduce .st-book{animation:none}',
].join('\n');

// createPage — controller. mount(el) 注入 PAGE_CSS（幂等，一次）、渲染
// markup、绑定「翻开这一章」→ onOpen；reduceMotion 时加 st-reduce 关浮动。
export function createPage(options) {
  var opts = options || {};
  var styleEl = null;
  var openBtn = null;
  var onOpenClick = null;
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
      var model = opts.model || null;
      el.innerHTML = pageView(model, opts.captions || null);
      var root = el.querySelector('.st-cover');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
      openBtn = el.querySelector('.st-open');
      if (openBtn && typeof opts.onOpen === 'function') {
        onOpenClick = function () { opts.onOpen(); };
        openBtn.addEventListener('click', onOpenClick);
      }
    },
    unmount: function () {
      if (openBtn && onOpenClick) openBtn.removeEventListener('click', onOpenClick);
      openBtn = null;
      onOpenClick = null;
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}
