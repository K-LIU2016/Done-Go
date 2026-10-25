// web/story/pages/learned.js — 时光故事书 ④ 学会的用法（SPEC §3 page 4；
// page type 'lessons'；视觉契约 = prototype.html .p4，奖章落下）。
//
// T5页型A line deliverable. Data: stats.lessons {learned[{usageId,title,
// count}], firstGraduation{date,time,app}|null}（contracts sanitizeLessons）。
// params.limit（契约 1–8）截奖章展示数，默认 8。
//
// 奖章规则：count===1 的奖章置灰（原型 .m filter:grayscale(.6)）；奖章依次
// 落下（MEDAL_STAGGER_MS 错峰），createPage 在每枚落地时刻回调
// onMedalFall(index)——「每枚一声叮，和配乐同调」（SPEC §3 ④）的音效由
// player/soundtrack 线在此回调上接（钟琴音高取当周段，SPEC §4）；
// reduceMotion 不落下、不回调。
//
// 第一次毕业文案（规则模板）：「{date} {时段}，你第一次自己在 {app} 里完成
// 了接力。那是你自己接住的第一棒。」——app 显示名走本表（relay external
// apps 的白名单子集，未知名原样透传，不猜）。
// Caption key: learned.first。接口约定与 cover.js 文件头一致。

export var PAGE_TYPE = 'lessons';
export var METRICS = ['lessons.learned', 'lessons.firstGraduation'];
export var MEDAL_STAGGER_MS = 280;

var MONTHS_ZH = ['', '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

var APP_NAMES = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  doubao: '豆包',
  chatglm: '智谱清言',
  qwen: '通义千问',
  gemini: 'Gemini',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
};

export function appName(app) {
  var id = String(app == null ? '' : app);
  return APP_NAMES[id] || id;
}

export function hourLabel(hour) {
  var h = ((Math.floor(hour) % 24) + 24) % 24;
  var display = h % 12 === 0 ? 12 : h % 12;
  var part;
  if (h === 0) return '午夜 12 点';
  if (h <= 4) part = '凌晨';
  else if (h <= 7) part = '清晨';
  else if (h <= 11) part = '上午';
  else if (h === 12) return '中午 12 点';
  else if (h <= 17) part = '下午';
  else if (h === 18) part = '傍晚';
  else part = '晚上';
  return part + ' ' + display + ' 点';
}

function dateLabel(date) {
  var s = String(date);
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  return m + ' 月 ' + d + ' 日';
}

function periodLead(type, period) {
  if (type === 'week') return '这一周，你多会了';
  if (type === 'year') return '这一年，你多会了';
  var m = Number(String(period.from).slice(5, 7));
  return (MONTHS_ZH[m] || '这个月') + '，你多会了';
}

function firstText(firstGraduation) {
  var d = dateLabel(firstGraduation.date);
  var t = hourLabel(Number(String(firstGraduation.time).slice(0, 2)));
  var app = appName(firstGraduation.app);
  return d + ' ' + t + '，你第一次自己在 ' + app + ' 里完成了接力。<br>那是你自己接住的第一棒。';
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'learned.first': model.firstPlainText || '' };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.stats.lessons) return null;
  var lessons = chapter.stats.lessons;
  var limit = params && params.limit ? Math.max(1, Math.min(8, params.limit)) : 8;
  var learned = lessons.learned || [];
  var medals = [];
  var dimFlags = [];
  for (var i = 0; i < learned.length && medals.length < limit; i += 1) {
    medals.push({ usageId: learned[i].usageId, title: learned[i].title, count: learned[i].count });
    dimFlags.push(learned[i].count === 1);
  }
  var first = lessons.firstGraduation;
  return {
    lead: periodLead(chapter.type, chapter.period || { from: '', to: '' }),
    count: learned.length,
    medals: medals,
    dimFlags: dimFlags,
    firstGraduation: first,
    firstText: first ? firstText(first) : '',
    firstPlainText: first
      ? firstText(first).replace(/<br>/g, ' ').replace(/<[^>]+>/g, '')
      : '',
    empty: learned.length === 0,
  };
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clipCaption(text, max) {
  var s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
}

export function pageView(model, captions) {
  if (!model) return '';
  if (model.empty) {
    return (
      '<div class="st-page st-learned">' +
        '<div class="st-learned-inner">' +
          '<span class="st-k">这一章，你多会了</span>' +
          '<h1 class="st-big">还没有新的用法</h1>' +
          '<p class="st-lead-sm">这一章还没有新的用法。下一次接力毕业，这里会落下第一枚奖章。</p>' +
          '<div class="st-foot"><span data-metric="lessons.learned">来自你的接力记录</span><span>轻点继续 ›</span></div>' +
        '</div>' +
      '</div>'
    );
  }
  var cap = captions || {};
  var firstLine = model.firstGraduation
    ? clipCaption(cap['learned.first'] != null ? cap['learned.first'] : model.firstText, 60)
    : '';
  var medals = '';
  for (var i = 0; i < model.medals.length; i += 1) {
    var m = model.medals[i];
    medals += '<div class="st-medal' + (model.dimFlags[i] ? ' st-medal-dim' : '') +
      '" data-medal-index="' + i + '" style="animation-delay:' + ((i + 1) * MEDAL_STAGGER_MS) + 'ms">' +
      '<div class="st-medal-ball" aria-hidden="true"></div>' +
      '<b>' + esc(m.title) + '</b><small>用了 ' + m.count + ' 次</small></div>';
  }
  var firstBox = firstLine
    ? '<p class="st-first" data-metric="lessons.firstGraduation">' + firstLine + '</p>'
    : '';
  return (
    '<div class="st-page st-learned">' +
      '<div class="st-learned-inner">' +
        '<span class="st-k">' + esc(model.lead) + '</span>' +
        '<h1 class="st-big" data-metric="lessons.learned">' + model.count + ' 个 AI 用法</h1>' +
        '<div class="st-medals">' + medals + '</div>' +
        firstBox +
        '<div class="st-foot"><span>来自你的接力记录</span><span>轻点继续 ›</span></div>' +
      '</div>' +
    '</div>'
  );
}

export var PAGE_CSS = [
  '.st-learned{background:radial-gradient(100% 70% at 50% 0%,#5A3E1E 0%,#2A1F14 70%);color:#fff}',
  '.st-learned-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;font-size:36px;line-height:1.18;margin-top:12px}',
  '.st-medals{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:24px}',
  '.st-medal{background:rgba(255,255,255,.07);border:1px solid rgba(232,176,75,.35);border-radius:18px;',
  '  padding:14px;text-align:center;animation:st-medal-fall 550ms cubic-bezier(.34,1.56,.64,1) both}',
  '.st-medal-ball{width:52px;height:52px;border-radius:50%;margin:0 auto 8px;',
  '  background:radial-gradient(circle at 35% 30%,#FFE7A6,#E8B04B 60%,#9A6A10);',
  '  box-shadow:0 0 20px rgba(232,176,75,.45)}',
  '.st-medal-dim .st-medal-ball{filter:grayscale(.6)}',
  '.st-medal b{font-size:13.5px;display:block;line-height:1.4}',
  '.st-medal small{font-size:11px;opacity:.7}',
  '@keyframes st-medal-fall{from{opacity:0;transform:translateY(-40px)}to{opacity:1;transform:translateY(0)}}',
  '.st-first{margin-top:18px;background:rgba(232,176,75,.15);border-radius:16px;padding:14px;',
  '  font-size:14px;line-height:1.7}',
  '.st-lead-sm{font-size:14px;line-height:1.7;opacity:.85;margin-top:14px}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-learned.st-reduce .st-medal{animation:none}',
].join('\n');

// createPage — mount 渲染并按 MEDAL_STAGGER_MS 调度 onMedalFall(i)（奖章
// 落地=animation-delay 到点）；reduceMotion 时不调度（无落下动效）。
export function createPage(options) {
  var opts = options || {};
  var styleEl = null;
  var timers = [];
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
      var root = el.querySelector('.st-learned');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
      if (typeof opts.onMedalFall === 'function' && !opts.reduceMotion && opts.model && !opts.model.empty) {
        for (var i = 0; i < opts.model.medals.length; i += 1) {
          timers.push(setTimeout(opts.onMedalFall, (i + 1) * MEDAL_STAGGER_MS + 550, i));
        }
      }
    },
    unmount: function () {
      for (var i = 0; i < timers.length; i += 1) clearTimeout(timers[i]);
      timers = [];
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}

export function renderPage(page, ctx) {
  var c = ctx || {};
  return pageView(pageModel(c.chapter, page && page.params), c.captions);
}
