// web/story/pages/poster-page.js — ⑨ 海报页（SPEC §3 ⑨，原型 p9）。
//
// 页型接口（本线五页统一）：
//   buildPosterModel(chapter, opts)     → 纯 view-model（node 可测，不改 chapter）
//     opts.melodyPitches?: number[]     — 契约 melodyPitches(notes) 的输出
//                                         （SPEC §4：海报上的「时间之歌」波形
//                                          = 这首曲子主旋律的音高序列）；
//                                          缺失时波形区静默降级
//   renderPosterPage(chapter, ctx)      → HTMLElement
//     ctx.reducedMotion?: boolean       — 跳过波形条入场
//     ctx.melodyPitches?: number[]      — 同上（render 侧入口）
//     ctx.onSavePoster?: () => void     — 「保存海报」（canvas 1080×1920 导出
//                                         由 web/story/poster.js 负责，本页只
//                                         发事件；无回调时按钮禁用）
//     ctx.onShareChapter?: () => void   — 「分享这一章」（系统分享/下载降级）
//
// 4 个数字：契约 poster 页 params.metricKeys（METRIC_KEY_RE 白名单键）→
// METRICS registry 解析；缺省四键复刻原型 p9（86 件事 / 23 次 AI 接力 /
// 4 个新用法 / 深夜创作派）。resolve 返回 null → 该格显示「—」，不编造。
//
// 标题：captions['poster.title']（narrative 线模板与 AI 润色的落点，与 cover
// 同章同题；旧键 'chapter-title'/'poster-title' 保留兼容）或规则模板默认标题
// （SPEC §5 模板优先）。
//
// 二维码：SPEC §3 ⑨ 列「二维码」但未定义内容口径——本页渲染 qr 占位容器
// （data-qr），内容由接入方注入；【二维码内容待 CTO 裁决】（见证据文件）。

import { formatHours } from './freed.js';
import { monthNameOf } from './rhythm.js';

export var PAGE_TYPE = 'poster';

export var DEFAULT_METRIC_KEYS = [
  'totals.events',
  'totals.aiRelays',
  'lessons.learned',
  'rhythm.genre',
];

export var POSTER_TITLE_KEYS = ['poster.title', 'chapter-title', 'poster-title'];

// metric registry：键 = 契约 metricKeys 白名单形状；resolve(stats) →
// {value, label} | null。value 一律字符串（canvas 导出同口径）。
export var METRICS = {
  'totals.events': {
    label: '件事',
    resolve: function (stats) {
      return { value: String(stats.totals.events), label: '件事' };
    },
  },
  'totals.aiRelays': {
    label: '次 AI 接力',
    resolve: function (stats) {
      return { value: String(stats.totals.aiRelays), label: '次 AI 接力' };
    },
  },
  'totals.delta': {
    label: '件 · 比上一章',
    resolve: function (stats) {
      var d = stats.totals.delta;
      if (d == null) return null;
      return { value: (d > 0 ? '+' : '') + d, label: '件 · 比上一章' };
    },
  },
  'lessons.learned': {
    label: '个新用法',
    resolve: function (stats) {
      var list = stats.lessons && Array.isArray(stats.lessons.learned) ? stats.lessons.learned : [];
      return { value: String(list.length), label: '个新用法' };
    },
  },
  'savedTime.hours': {
    label: '小时 · 你确认过的',
    resolve: function (stats) {
      var saved = stats.savedTime;
      if (!saved || !saved.confirmedMinutes) return null; // 只统计本人确认过的（红线）
      return { value: formatHours(saved.confirmedMinutes), label: '小时 · 你确认过的' };
    },
  },
  'rhythm.genre': {
    label: '时间流派',
    resolve: function (stats) {
      var genre = stats.rhythm && stats.rhythm.genre;
      if (!genre) return null;
      return { value: genre.title, label: '时间流派' };
    },
  },
  'keywords.top': {
    label: '第一关键词',
    resolve: function (stats) {
      var words = stats.keywords && Array.isArray(stats.keywords) ? stats.keywords : [];
      if (!words.length) return null;
      return { value: words[0].word, label: '第一关键词' };
    },
  },
};

// 期间称呼：月章用月名；周记/年书不得冒用月份名（周可跨月、年书跨多月）。
export function posterPeriodName(period, type) {
  if (type === 'week') return '这一周';
  if (type === 'year') return '这一年';
  return monthNameOf({ period: period });
}

// 规则模板默认标题（SPEC §5 模板优先；原型 p9「十月，我把 6 小时还给了自己」）。
export function defaultPosterTitle(stats, period, type) {
  var name = posterPeriodName(period, type);
  var confirmed = stats.savedTime && stats.savedTime.confirmedMinutes;
  if (confirmed >= 60) {
    return name + '，我把 ' + formatHours(confirmed) + ' 小时还给了自己';
  }
  return name + '，你记下了 ' + stats.totals.events + ' 件事';
}

// 波形高度：midi 序列 → 6..20px（原型 p9 波形条高度区间），线性归一；
// 屏幕页采样前 11 根（原型 11 根；完整波形归 canvas 导出 poster.js）。
export var WAVE_MIN_PX = 6;
export var WAVE_MAX_PX = 20;
export var WAVE_BARS = 11;

export function waveformHeights(pitches) {
  if (!Array.isArray(pitches) || !pitches.length) return null;
  var sample = pitches.slice(0, WAVE_BARS);
  var min = Infinity;
  var max = -Infinity;
  for (var i = 0; i < sample.length; i += 1) {
    if (sample[i] < min) min = sample[i];
    if (sample[i] > max) max = sample[i];
  }
  var span = max - min;
  return sample.map(function (midi) {
    var ratio = span > 0 ? (midi - min) / span : 0.5;
    return Math.round(WAVE_MIN_PX + (WAVE_MAX_PX - WAVE_MIN_PX) * ratio);
  });
}

function metricKeysOf(chapter) {
  var pages = (chapter && chapter.pages) || [];
  for (var i = 0; i < pages.length; i += 1) {
    if (pages[i] && pages[i].type === 'poster') {
      var params = pages[i].params || {};
      if (Array.isArray(params.metricKeys) && params.metricKeys.length === 4) {
        return params.metricKeys;
      }
    }
  }
  return DEFAULT_METRIC_KEYS;
}

// captions 槽：poster.title（narrative 模板/AI 润色的落点；与 cover 同章同题）。
export function captionDefaults(model) {
  return { 'poster.title': (model && model.title) || '' };
}

export function buildPosterModel(chapter, opts) {
  opts = opts || {};
  var stats = chapter && chapter.stats;
  var captions = (chapter && chapter.captions) || {};
  var title = null;
  for (var t = 0; t < POSTER_TITLE_KEYS.length && !title; t += 1) {
    if (captions[POSTER_TITLE_KEYS[t]]) title = captions[POSTER_TITLE_KEYS[t]];
  }
  if (!title) title = defaultPosterTitle(stats, chapter.period, chapter && chapter.type);

  var metrics = metricKeysOf(chapter).map(function (key) {
    var metric = METRICS[key];
    if (!metric) return { value: '—', label: key };
    var hit = metric.resolve(stats);
    return hit ? hit : { value: '—', label: metric.label };
  });

  var periodName = posterPeriodName(chapter && chapter.period, chapter && chapter.type);
  return {
    pageType: PAGE_TYPE,
    heading: '探戈 Done&Go · 第 ' + (chapter && chapter.no) + ' 章',
    title: title,
    metrics: metrics,
    songLabel: '♪ ' + periodName + ' · 时间之歌（由我的数据生成）',
    waveHeights: waveformHeights(opts.melodyPitches || null),
    saveLabel: '保存海报',
    shareLabel: '分享这一章',
    shelfLabel: '↑ 回到书架看其他章节',
  };
}

// ---------------------------------------------------------------------------
// DOM 渲染（原型 p9：.pg.p9 → inner → k, .pp 卡, .shareb, .hold）。
// 波形条入场 stagger；reducedMotion 直接终态。SPEC §4：海报页 = 尾段，
// 音乐在此回主和弦淡出（soundtrack/player 职责，本页不触碰音频）。
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderPosterPage(chapter, ctx) {
  ctx = ctx || {};
  var model = buildPosterModel(chapter, { melodyPitches: ctx.melodyPitches });
  var page = el('section', 'pg p9');
  page.dataset.storyPage = PAGE_TYPE;

  var inner = el('div', 'inner');
  page.appendChild(inner);

  inner.appendChild(el('span', 'k', model.heading));

  var card = el('div', 'pp');
  card.style.marginTop = '6px';
  inner.appendChild(card);

  var ttl = el('div', 'ttl', model.title);
  ttl.dataset.metric = 'poster.title';
  card.appendChild(ttl);

  var grid = el('div', 'g');
  grid.style.marginTop = '16px';
  card.appendChild(grid);
  model.metrics.forEach(function (metric) {
    var cell = el('div');
    var b = el('b', null, metric.value);
    if (metric.value.length > 3) b.style.fontSize = '20px'; // 长词（流派名）缩字号
    b.dataset.metric = 'poster.metric';
    cell.appendChild(b);
    cell.appendChild(el('span', null, metric.label));
    grid.appendChild(cell);
  });

  var song = el('div', 'song');
  song.style.marginTop = '14px';
  var wave = el('span', 'wv');
  song.appendChild(wave);
  if (model.waveHeights) {
    model.waveHeights.forEach(function (height, index) {
      var bar = el('i');
      bar.style.height = height + 'px';
      wave.appendChild(bar);
      if (bar.animate && !ctx.reducedMotion) {
        bar.animate(
          [{ transform: 'scaleY(0.2)' }, { transform: 'scaleY(1)' }],
          { duration: 300, delay: index * 70, fill: 'backwards', easing: 'ease-out' }
        );
      }
    });
  } else {
    wave.appendChild(el('i')).style.height = WAVE_MIN_PX + 'px';
  }
  song.appendChild(el('span', null, model.songLabel));
  card.appendChild(song);

  // 二维码容器：内容口径未定（SPEC §3 ⑨ 未定义指向），由接入方注入；
  // 【二维码内容待 CTO 裁决】。
  var qr = el('div', 'qr');
  qr.dataset.qr = 'pending';
  qr.setAttribute('aria-hidden', 'true');
  qr.style.cssText =
    'width:34px;height:34px;border-radius:6px;background:rgba(255,255,255,.25);margin-top:12px';
  card.appendChild(qr);

  var shareb = el('div', 'shareb');
  shareb.style.marginTop = 'auto';
  inner.appendChild(shareb);
  var saveBtn = el('button', 's1', model.saveLabel);
  saveBtn.type = 'button';
  var shareBtn = el('button', 's2', model.shareLabel);
  shareBtn.type = 'button';
  if (typeof ctx.onSavePoster === 'function') {
    saveBtn.addEventListener('click', function () { ctx.onSavePoster(); });
  } else {
    saveBtn.disabled = true;
    saveBtn.style.opacity = '.55';
  }
  if (typeof ctx.onShareChapter === 'function') {
    shareBtn.addEventListener('click', function () { ctx.onShareChapter(); });
  } else {
    shareBtn.disabled = true;
    shareBtn.style.opacity = '.55';
  }
  shareb.appendChild(saveBtn);
  shareb.appendChild(shareBtn);

  var hold = el('p', 'hold', model.shelfLabel);
  hold.style.cssText = 'text-align:center;margin-top:12px';
  inner.appendChild(hold);

  return page;
}
