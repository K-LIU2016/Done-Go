// web/story/pages/count.js — 时光故事书 ① 开篇数字（SPEC §3 page 1；page
// type 'numbers'；视觉契约 = prototype.html .p1）。
//
// T5页型A line deliverable. Data: stats.totals {events, aiRelays, prevEvents,
// delta}（contracts sanitizeTotals）。动效：大数字 0→目标 1.2 秒滚动
// （COUNT_ROLL_MS，SPEC §3 ①）；每件事一个点、金点是 AI 接力；点阵按
// DOT_STAGGER_MS 逐个浮现。
//
// Caption key: count.lead（第二段结语，默认规则模板；narrative 线润色基线）。
// 接口约定与 cover.js 文件头一致（PAGE_TYPE/METRICS/PAGE_CSS/
// captionDefaults/pageModel/pageView/createPage）。
//
// 红线：文案只陈述事实（多/少/持平），不与他人比较、不夸大。

var MONTHS_ZH = ['', '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

export var PAGE_TYPE = 'numbers';
export var METRICS = ['totals.events', 'totals.aiRelays', 'totals.delta'];
export var COUNT_ROLL_MS = 1200;   // SPEC §3 ① 数字滚动 1.2 秒
export var DOT_STAGGER_MS = 15;    // 点阵逐个浮现
export var DOTS_MAX = 500;         // 渲染保护：点阵上限（events 上限 1e7 不可全绘）

function periodName(type, period) {
  if (type === 'week') return '这一周';
  if (type === 'year') return '这一年';
  var m = Number(String(period.from).slice(5, 7));
  return MONTHS_ZH[m] || '这个月';
}

function periodLead(type, period) {
  if (type === 'week') return '这一周，你记下了';
  if (type === 'year') return '这一年，你记下了';
  return '这个月，你记下了';
}

// 上一期称呼：月章=上月月名（跨年→去年十二月）；周记=上一周；年书=去年。
export function prevLabel(type, period) {
  if (type === 'week') return '上一周';
  if (type === 'year') return '去年';
  var from = String(period.from);
  var y = Number(from.slice(0, 4));
  var m = Number(from.slice(5, 7));
  if (m === 1) return '去年十二月';
  return MONTHS_ZH[m - 1] || '上个月';
}

// 确定性点阵：events 个点中均匀撒 aiRelays 个金点（同输入同输出，可 unit）。
export function dotPattern(events, aiRelays) {
  var total = Math.max(0, Math.floor(events));
  var gold = Math.min(Math.max(0, Math.floor(aiRelays)), total);
  var out = new Array(total).fill(false);
  if (gold === 0) return out;
  if (gold >= total) return new Array(total).fill(true);
  for (var k = 0; k < gold; k += 1) {
    var idx = Math.floor(((k + 0.5) * total) / gold);
    while (idx < total && out[idx]) idx += 1;
    if (idx >= total) {
      idx = 0;
      while (idx < total && out[idx]) idx += 1;
    }
    if (idx < total) out[idx] = true;
  }
  return out;
}

export function easeOutCubic(t) {
  var x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

// t ∈ [0,1] → 滚动显示值（0 → target，easeOutCubic）。
export function rollValue(target, t) {
  return Math.round(target * easeOutCubic(t));
}

function deltaText(delta, prev) {
  if (prev == null || delta == null) return '这是你的第一章。';
  if (delta > 0) return '比' + prev + '多了 ' + delta + ' 件。';
  if (delta < 0) return '比' + prev + '少了 ' + (-delta) + ' 件。';
  return '与' + prev + '持平。';
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'count.lead': model.leadText };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.stats.totals) return null;
  var totals = chapter.stats.totals;
  var period = chapter.period || { from: '', to: '' };
  var dotsEvents = totals.events;
  var dotsGold = totals.aiRelays;
  var dotsOverflow = false;
  if (dotsEvents > DOTS_MAX) {
    dotsOverflow = true;
    dotsGold = Math.round((totals.aiRelays * DOTS_MAX) / dotsEvents);
    dotsEvents = DOTS_MAX;
  }
  var relayLine = totals.aiRelays > 0
    ? '其中 <b class="st-gold"> ' + totals.aiRelays + ' 件</b>交给了 AI 接力。'
    : '每一件都是你自己做完的。';
  var dText = deltaText(totals.delta, totals.prevEvents == null ? null : prevLabel(chapter.type, period));
  return {
    events: totals.events,
    aiRelays: totals.aiRelays,
    delta: totals.delta,
    periodName: periodName(chapter.type, period),
    leadText: relayLine + '<br>' + dText,
    deltaText: dText,
    dots: dotPattern(dotsEvents, dotsGold),
    dotsOverflow: dotsOverflow,
    dotsDropped: dotsOverflow ? totals.events - DOTS_MAX : 0,
    lead: periodLead(chapter.type, period),
  };
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function pageView(model, captions) {
  if (!model) return '';
  var cap = captions || {};
  var lead = cap['count.lead'] != null ? String(cap['count.lead']) : model.leadText;
  var dots = '';
  for (var i = 0; i < model.dots.length; i += 1) {
    dots += '<i class="st-dot' + (model.dots[i] ? ' st-dot-ai' : '') +
      '" style="animation-delay:' + (i * DOT_STAGGER_MS) + 'ms"></i>';
  }
  var overflow = model.dotsOverflow
    ? '<span class="st-dots-more">+' + model.dotsDropped + '</span>'
    : '';
  return (
    '<div class="st-page st-count">' +
      '<div class="st-count-inner">' +
        '<span class="st-k">' + esc(model.lead) + '</span>' +
        '<span class="st-num" data-metric="totals.events" data-roll-target="' + model.events + '">' +
          '<span class="st-num-val">0</span><small>件事</small></span>' +
        '<p class="st-lead"><span data-metric="totals.aiRelays">' + lead + '</span></p>' +
        '<div class="st-dots" role="img" aria-label="' + model.events + ' 个点，其中 ' + model.aiRelays + ' 个金点是 AI 接力">' +
          dots + overflow + '</div>' +
        '<div class="st-foot"><span data-metric="totals.delta">长按数字看口径</span><span>轻点继续 ›</span></div>' +
      '</div>' +
    '</div>'
  );
}

export var PAGE_CSS = [
  '.st-count{background:radial-gradient(120% 80% at 20% 0%,#3A5A8C 0%,#1D2D4B 60%,#141E33 100%);color:#fff}',
  '.st-count-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-num{font-family:"Avenir Next","Helvetica Neue",sans-serif;font-weight:700;font-size:96px;line-height:1;',
  '  letter-spacing:-2px;margin-top:14px;display:block}',
  '.st-num small{font-size:22px;font-weight:600;margin-left:4px;letter-spacing:0}',
  '.st-lead{font-size:16px;line-height:1.75;opacity:.92;margin-top:14px}',
  '.st-gold{color:#FFB27A}',
  '.st-dots{display:flex;flex-wrap:wrap;gap:5px;margin-top:22px;align-items:center}',
  '.st-dot{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.35);',
  '  animation:st-dot-in 300ms both}',
  '.st-dot-ai{background:#FFB27A;box-shadow:0 0 8px #FFB27A}',
  '@keyframes st-dot-in{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:scale(1)}}',
  '.st-dots-more{font-size:11.5px;opacity:.6;margin-left:4px}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-count.st-reduce .st-dot{animation:none;opacity:1}',
].join('\n');

// createPage — mount 后跑 1.2 秒数字滚动（rAF；reduceMotion 直接落定）。
export function createPage(options) {
  var opts = options || {};
  var styleEl = null;
  var rafId = 0;
  var startedAt = 0;
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
      var root = el.querySelector('.st-count');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
      var val = el.querySelector('.st-num-val');
      var target = opts.model ? opts.model.events : 0;
      if (!val) return;
      if (opts.reduceMotion) {
        val.textContent = String(target);
        return;
      }
      startedAt = 0;
      var step = function (ts) {
        if (!startedAt) startedAt = ts;
        var t = (ts - startedAt) / COUNT_ROLL_MS;
        val.textContent = String(rollValue(target, t));
        if (t < 1) rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    },
    unmount: function () {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}
