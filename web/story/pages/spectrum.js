// web/story/pages/spectrum.js — 时光故事书 ② 时间的颜色（SPEC §3 page 2；
// page type 'timeColors'；视觉契约 = prototype.html .p2，六色光谱）。
//
// T5页型A line deliverable. Data: stats.kindMinutes（contracts
// sanitizeKindMinutes：恒 6 行、KINDS canonical 序，含 0 占位）。色块 flex =
// round(share×100)（原型 31/22/18/13/11/5），显示按 share 降序。
//
// 标题规则模板（SPEC §3 ②「标题按前两个类别生成」）：
//   前两类接近（share2 ≥ share1×0.85）→ 「{色1}的{名1}，与{色2}的{名2}同行」
//   第二类很小（share2 < 0.10）      → 「一片{色1}的{名1}」
//   默认（原型）                      → 「{色1}的{名1}，夹着{色2}的{名2}」
// Caption key: spectrum.title。零数据（全 0 分钟）渲染空态短句，不硬凑。
//
// 动效：色块自下而上铺开（transform-origin bottom scaleY，SPEC §3 ②），
// SPEC_STAGGER_MS 逐块错峰；reduceMotion 直接铺满。
// 接口约定与 cover.js 文件头一致。

import { KINDS } from '../contracts.js';

export var PAGE_TYPE = 'timeColors';
export var METRICS = KINDS.map(function (k) { return 'kindMinutes.' + k; });
export var SPEC_STAGGER_MS = 120;

// 原型 .p2 六色（linear-gradient 上下两色 + --k-* 基色）逐值对照。
export var KIND_COLORS = {
  create: { base: '#E8B04B', top: '#F2C46A' },
  necessary: { base: '#7C8A99', top: '#8E9BAA' },
  connect: { base: '#E9826A', top: '#F0957F' },
  explore: { base: '#6E8FD6', top: '#86A4E0' },
  restore: { base: '#5FA67F', top: '#78B996' },
  stillness: { base: '#B9A8D8', top: '#CBBDE3' },
};

var KIND_LABELS = {
  create: '创造', necessary: '必要', connect: '相聚',
  explore: '探索', restore: '恢复', stillness: '自己的时间',
};

var KIND_COLOR_NAMES = {
  create: '金色', necessary: '灰色', connect: '橘色',
  explore: '蓝色', restore: '绿色', stillness: '紫色',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || '';
}

export function kindColorName(kind) {
  return KIND_COLOR_NAMES[kind] || '';
}

var MONTHS_ZH = ['', '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

function periodName(type, period) {
  if (type === 'week') return '这一周';
  if (type === 'year') return '这一年';
  var m = Number(String(period.from).slice(5, 7));
  return MONTHS_ZH[m] || '这个月';
}

// 标题取「前两个类别」（SPEC §3 ②），但 SPEC 自己的例子「金色的创作，夹着
// 橘色的相聚」与原型页面在十月数据（create .31 > necessary .22 > connect
// .18）下都指向 create+connect——necessary 被跳过。矛盾已上报 specConflicts
// （待 CTO 裁决）；本期落地按例子对齐：necessary 占比 < 0.40 时视为背景色
// 不进标题叙事，取前两个非 necessary 类别；necessary ≥ 0.40（近半）时按
// 事实进入标题。规则可解释、纯函数可测。
function titleRows(rows) {
  if (rows.length && rows[0].kind === 'necessary' && rows[0].share >= 0.40) return rows.slice(0, 2);
  var rest = [];
  for (var i = 0; i < rows.length && rest.length < 2; i += 1) {
    if (rows[i].kind !== 'necessary') rest.push(rows[i]);
  }
  if (rest.length < 2) return rows.slice(0, 2);
  return rest;
}

function titleFor(rows) {
  var pair = titleRows(rows);
  var a = pair[0];
  var b = pair[1];
  if (!b || b.share < 0.10) return '一片' + kindColorName(a.kind) + '的' + kindLabel(a.kind);
  if (b.share >= a.share * 0.85) {
    return kindColorName(a.kind) + '的' + kindLabel(a.kind) + '，与' + kindColorName(b.kind) + '的' + kindLabel(b.kind) + '同行';
  }
  return kindColorName(a.kind) + '的' + kindLabel(a.kind) + '，夹着' + kindColorName(b.kind) + '的' + kindLabel(b.kind);
}

export function captionDefaults(model) {
  if (!model) return {};
  return { 'spectrum.title': model.title };
}

export function pageModel(chapter, params) {
  if (!chapter || !chapter.stats || !chapter.stats.kindMinutes) return null;
  var stats = chapter.stats;
  var rows = [];
  for (var i = 0; i < stats.kindMinutes.length; i += 1) {
    var row = stats.kindMinutes[i];
    rows.push({
      kind: row.kind,
      minutes: row.minutes,
      share: row.share,
      pct: Math.round(row.share * 100),
      flex: Math.max(1, Math.round(row.share * 100)),
    });
  }
  rows.sort(function (a, b) { return b.share - a.share || b.minutes - a.minutes; });
  var total = 0;
  for (var j = 0; j < rows.length; j += 1) total += rows[j].minutes;
  return {
    periodName: periodName(chapter.type, chapter.period || { from: '', to: '' }),
    rows: rows,
    totalMinutes: total,
    empty: total === 0,
    title: total === 0 ? '这一章还没有时间的颜色' : titleFor(rows),
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
  var cap = captions || {};
  var title = clipCaption(cap['spectrum.title'] != null ? cap['spectrum.title'] : model.title, 60);
  if (model.empty) {
    return (
      '<div class="st-page st-spectrum">' +
        '<div class="st-spectrum-inner">' +
          '<span class="st-k">你的' + esc(model.periodName) + '是这个颜色</span>' +
          '<h1 class="st-big">这一章还没有时间的颜色</h1>' +
          '<div class="st-spec-empty">下一章，把做过的事记进来，颜色会自己长出来。</div>' +
          '<div class="st-foot"><span>按事项计划时长统计</span><span>轻点继续 ›</span></div>' +
        '</div>' +
      '</div>'
    );
  }
  var bars = '';
  var legend = '';
  for (var i = 0; i < model.rows.length; i += 1) {
    var r = model.rows[i];
    var c = KIND_COLORS[r.kind] || { base: '#888888', top: '#999999' };
    bars += '<i class="st-spec-bar" style="flex:' + r.flex + ';background:linear-gradient(180deg,' +
      c.top + ',' + c.base + ');animation-delay:' + (i * SPEC_STAGGER_MS) + 'ms"></i>';
    legend += '<span class="st-spec-lg-row" data-metric="kindMinutes.' + r.kind + '"><b style="background:' +
      c.base + '"></b>' + esc(kindLabel(r.kind)) + ' ' + r.pct + '%</span>';
  }
  return (
    '<div class="st-page st-spectrum">' +
      '<div class="st-spectrum-inner">' +
        '<span class="st-k">你的' + esc(model.periodName) + '是这个颜色</span>' +
        '<h1 class="st-big st-big-sm">' + esc(title) + '</h1>' +
        '<div class="st-spec" role="img" aria-label="时间光谱：按占比从大到小的类别色块">' + bars + '</div>' +
        '<div class="st-spec-lg">' + legend + '</div>' +
        '<div class="st-foot"><span>按事项计划时长统计</span><span>轻点继续 ›</span></div>' +
      '</div>' +
    '</div>'
  );
}

export var PAGE_CSS = [
  '.st-spectrum{background:#18171D;color:#fff}',
  '.st-spectrum-inner{position:absolute;inset:72px 26px 40px;display:flex;flex-direction:column}',
  '.st-k{font-size:12.5px;letter-spacing:2px;opacity:.75}',
  '.st-big{font-family:"Songti SC","Noto Serif SC","STSong",serif;font-weight:900;font-size:32px;line-height:1.18;margin-top:12px}',
  '.st-spec{display:flex;height:300px;border-radius:22px;overflow:hidden;margin-top:22px}',
  '.st-spec-bar{display:block;filter:saturate(1.1);transform-origin:50% 100%;',
  '  animation:st-bar-up 450ms cubic-bezier(.22,.61,.36,1) both}',
  '@keyframes st-bar-up{from{transform:scaleY(0)}to{transform:scaleY(1)}}',
  '.st-spec-lg{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-top:16px;font-size:13px}',
  '.st-spec-lg-row{display:flex;align-items:center;gap:8px}',
  '.st-spec-lg-row b{width:12px;height:12px;border-radius:4px;display:inline-block}',
  '.st-spec-empty{margin-top:22px;border-radius:18px;background:rgba(255,255,255,.06);',
  '  padding:18px;font-size:14px;line-height:1.7;opacity:.85}',
  '.st-foot{margin-top:auto;font-size:11.5px;opacity:.6;display:flex;justify-content:space-between}',
  '.st-spectrum.st-reduce .st-spec-bar{animation:none;transform:none}',
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
      var root = el.querySelector('.st-spectrum');
      if (root && opts.reduceMotion) root.classList.add('st-reduce');
    },
    unmount: function () {
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    },
  };
}
