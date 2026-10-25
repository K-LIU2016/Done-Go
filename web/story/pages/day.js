// web/story/pages/day.js — 时光故事书 ③ 最特别的一天（SPEC §3 page 3；
// page type 'specialDay'；视觉契约 = prototype.html .p3，晨→夜天光渐变）。
//
// T5页型A line deliverable. Data: stats.topDay {date, events, timeline[],
// warmIndex}（contracts sanitizeTopDay；可为 null）。背景渐变由当天时间线
// 的首末时间驱动（skyStops 纯函数：分段天光色板 + 通道线性插值），原型
// .p3 的固定渐变是 10.18（08:30–22:10）一天的样子。
//
// 结语（SPEC §3 ③ 选出一件温暖的事写成结语）：
//   warmIndex 有效 → 「最忙的一天，你还是留了「{title}」。」
//   warmIndex null → 「那一天，从 {first} 到 {last}，你一件一件把它们做完了。」
// Caption key: day.warm（narrative 线润色基线：输入只有统计，title 是用户
// 自己写下的事项名，页面显示本就来自用户）。
// params.maxTimeline（契约 1–24）截长列表并给出「等 N 件事」尾注。
// 动效：时间线逐项滑入（TL_STAGGER_MS）；reduceMotion 直接显示。

export var PAGE_TYPE = 'specialDay';
export var METRICS = ['topDay.events', 'topDay.timeline'];
export var TL_STAGGER_MS = 90;
export var INK = '#1f2a2a'; // 原型 .p3 文字墨色

// 分段天光色板（分钟区段 [from,to) → 天色，0..1440 连续无缝）。边界钉在
// prototype .p3 的锚点上：原型一天 08:30–22:10 的固定渐变是
// #F6C9A0 0% / #E9E4CF 35%(≈13:24) / #9FC0C6 70%(≈17:54) / #3E4C86 100%，
// 所以黎明带覆盖到 11:45 前、暮前带含青蓝 #9FC0C6（不是端点混色出来的灰）。
var SKY_BANDS = [
  { from: 0, to: 300, hex: '#232B52' },    // 夜（凌晨）
  { from: 300, to: 570, hex: '#F6C9A0' },  // 黎明（05:00–09:30，含原型 08:30 起始色）
  { from: 570, to: 705, hex: '#EFE9D8' },  // 上午（09:30–11:45）
  { from: 705, to: 945, hex: '#E9E4CF' },  // 午间（11:45–15:45，含原型 35% 色标 ≈13:24）
  { from: 945, to: 1035, hex: '#BCD3D6' }, // 暮前浅（15:45–17:15）
  { from: 1035, to: 1105, hex: '#9FC0C6' },// 暮前青蓝（17:15–18:25，含原型 70% 色标 ≈17:54）
  { from: 1105, to: 1190, hex: '#E9B98F' },// 黄昏（18:25–19:50）
  { from: 1190, to: 1440, hex: '#3E4C86' },// 夜（19:50–24:00，含原型 22:10 末色）
];

function hmToMinutes(hm) {
  var parts = String(hm).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb) {
  var s = '#';
  for (var i = 0; i < 3; i += 1) {
    var v = Math.max(0, Math.min(255, Math.round(rgb[i])));
    s += (v < 16 ? '0' : '') + v.toString(16).toUpperCase();
  }
  return s;
}

export function skyMix(hexA, hexB, t) {
  var a = hexToRgb(hexA);
  var b = hexToRgb(hexB);
  var x = Math.min(1, Math.max(0, t));
  return rgbToHex([a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x, a[2] + (b[2] - a[2]) * x]);
}

// 天光表查询：色板连续无缝，直接命中所处的带（原型 .p3 的渐变本身就是
// 调色板锚点间的线性过渡，由 CSS linear-gradient 完成，不在 JS 里混色）。
export function skyAt(hm) {
  var mins = hmToMinutes(hm);
  for (var i = 0; i < SKY_BANDS.length; i += 1) {
    var band = SKY_BANDS[i];
    if (mins >= band.from && (mins < band.to || (i === SKY_BANDS.length - 1 && mins <= band.to))) {
      return band.hex;
    }
  }
  return SKY_BANDS[SKY_BANDS.length - 1].hex;
}

// 分钟数 → 'HH:MM'（skyStops 内部用）。
function minsToHm(mins) {
  var m = Math.max(0, Math.min(1440, Math.round(mins)));
  return (m < 600 ? '0' : '') + Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60);
}

// 4 个色标（0% / 35% / 70% / 100%）：按时间跨度等比取时刻，各自查天光表。
// 原型一天（08:30–22:10）由此逐值复现：
// #F6C9A0 / #E9E4CF / #9FC0C6 / #3E4C86 —— 中段是真实色标，不是首末端点
// 的 RGB 均匀混合（旧实现 1/3、2/3 混色把暖沙与青蓝洗成了灰）。
export function skyStops(fromHm, toHm) {
  var a = hmToMinutes(fromHm);
  var b = hmToMinutes(toHm);
  if (!(b > a)) return [skyAt(fromHm), skyAt(fromHm), skyAt(fromHm), skyAt(toHm)];
  var atFrac = function (f) { return skyAt(minsToHm(a + (b - a) * f)); };
  return [atFrac(0), atFrac(0.35), atFrac(0.7), atFrac(1)];
}

export function dateLabel(date) {
  var s = String(date);
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  return m + ' 月 ' + d + ' 日';
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'day.warm': model.warmText };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats) return null;
  var topDay = chapter.stats.topDay;
  if (!topDay) {
    return { empty: true, period: chapter.period || null, type: chapter.type };
  }
  var cap = params && params.maxTimeline ? Math.max(1, Math.min(24, params.maxTimeline)) : topDay.timeline.length;
  var timeline = topDay.timeline.slice(0, Math.min(cap, topDay.timeline.length));
  var dropped = topDay.timeline.length - timeline.length;
  var warm = null;
  if (topDay.warmIndex != null && topDay.warmIndex >= 0 && topDay.warmIndex < topDay.timeline.length) {
    var pick = topDay.timeline[topDay.warmIndex];
    warm = { time: pick.time, title: pick.title };
  }
  var first = topDay.timeline[0];
  var last = topDay.timeline[topDay.timeline.length - 1];
  var stops = skyStops(first.time, last.time);
  var warmText = warm
    ? '最忙的一天，你还是留了「' + warm.title + '」。'
    : '那一天，从 ' + first.time + ' 到 ' + last.time + '，你一件一件把它们做完了。';
  return {
    empty: false,
    date: topDay.date,
    dateLabel: dateLabel(topDay.date),
    events: topDay.events,
    timeline: timeline,
    dropped: dropped,
    warm: warm,
    warmText: warmText,
    stops: stops,
    background: 'linear-gradient(180deg,' + stops[0] + ' 0%,' + stops[1] + ' 35%,' + stops[2] + ' 70%,' + stops[3] + ' 100%)',
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
      '<div class="st-page st-day" style="background:linear-gradient(180deg,#E9E4CF 0%,#9FC0C6 55%,#3E4C86 100%);color:' + INK + '">' +
        '<div class="st-day-inner">' +
          '<span class="st-k">最特别的一天</span>' +
          '<h1 class="st-big">这一章还没有这样的一天</h1>' +
          '<p class="st-lead-sm">下一章记下的事多了，这里会出现那一天的时间线。</p>' +
          '<div class="st-foot"><span data-metric="topDay.events">按事项数最多的一天</span><span>轻点继续 ›</span></div>' +
        '</div>' +
      '</div>'
    );
  }
  var cap = captions || {};
  var closer = clipCaption(cap['day.warm'] != null ? cap['day.warm'] : model.warmText, 60);
  var rows = '';
  for (var i = 0; i < model.timeline.length; i += 1) {
    var item = model.timeline[i];
    rows += '<div class="st-tl-item' + (item.ai ? ' st-tl-ai' : '') +
      '" data-metric="topDay.timeline" style="animation-delay:' + (i * TL_STAGGER_MS) + 'ms">' +
      '<small>' + esc(item.time) + '</small>' + esc(item.title) + (item.ai ? ' ✦' : '') + '</div>';
  }
  var more = model.dropped > 0 ? '<div class="st-tl-more">等 ' + model.dropped + ' 件事</div>' : '';
  return (
    '<div class="st-page st-day" style="background:' + model.background + ';color:' + INK + '">' +
      '<div class="st-day-inner">' +
        '<span class="st-k">还记得 ' + esc(model.dateLabel) + '吗</span>' +
        '<h1 class="st-big">那天你做了<br><span data-metric="topDay.events">' + model.events + ' 件事</span></h1>' +
        '<div class="st-tl">' + rows + more + '</div>' +
        '<p class="st-lead-sm">' + esc(closer) + '</p>' +
        '<div class="st-foot"><span>✦ = AI 同行</span><span>轻点继续 ›</span></div>' +
      '</div>' +
    '</div>'
  );
}

export var PAGE_CSS = [
  '.st-day{color:' + INK + '}',
  '.st-day .st-k{opacity:.7}',
  '.st-day-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;font-size:34px;line-height:1.18;margin-top:12px;color:' + INK + '}',
  '.st-tl{margin-top:20px;position:relative;padding-left:22px}',
  '.st-tl::before{content:"";position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:rgba(31,42,42,.35)}',
  '.st-tl-item{position:relative;font-size:14px;margin-bottom:12px;animation:st-tl-in 400ms both}',
  '.st-tl-item::before{content:"";position:absolute;left:-21px;top:4px;width:12px;height:12px;border-radius:50%;',
  '  background:#fff;border:2px solid ' + INK + '}',
  '.st-tl-ai::before{background:#E8B04B;border-color:#E8B04B;box-shadow:0 0 0 4px rgba(232,176,75,.3)}',
  '.st-tl-item small{opacity:.65;margin-right:6px;font-variant-numeric:tabular-nums}',
  '.st-tl-more{font-size:12px;opacity:.55;margin:2px 0 12px 0}',
  '@keyframes st-tl-in{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}',
  '.st-lead-sm{font-size:14.5px;line-height:1.75;margin-top:14px}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between;color:' + INK + '}',
  '.st-day.st-reduce .st-tl-item{animation:none}',
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
      var root = el.querySelector('.st-day');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
    },
    unmount: function () {
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}
