// web/social/poster.js — 流派分享图（S8分享引导线，PRD design/social-sync/PRD.md §4.1「生成分享图」、§6）。
//
// 视觉契约：design/social-sync/prototype.html section ④（poster，1080×1920 导出）。
// 分享图是流派色底的深色渐变海报：品牌行 / 「这一周，我是」+ 流派名 / 探戈机器人
// 吉祥物（几何近似）/ 本周证据三条 / 聚合数字四宫格 / 流派一句话 +「你是什么流派？」/
// 二维码占位。视觉 token 沿用 relay-v2 SPEC §3 的字体栈与圆角语言；主色取
// contracts STYLES 的流派色（海报是流派色主题，不用浅色 app 底）。
//
// 数据面（D2 硬门槛，tests/unit/social-poster.test.mjs 逐条证明）：
// · 输入只允许 { styleCard, facts } 两个键；styleCard 必须通过 contracts
//   validateStyleCard（style/week/evidence 三键、证据 ≤ STYLE_EVIDENCE_MAX 条）；
//   facts 是 {kind,value[,freedTo]} 的固定枚举（relays/self-kept/batons/freed）。
// · 未知字段一律【拒绝】并给 path 定位（含 FORBIDDEN_UPLOAD_FIELDS 全清单注入证明），
//   sanitizePosterInput 拒绝时返回 null，绝不静默剥离。事项标题、材料、AI 结果、
//   具体时间、地点进不了数据面，也进不了任何绘制文本 —— layoutPoster 的文本集
//   对白名单封闭（unit 断言封闭集）。
// · 契约键名/枚举/上限全部 import 自 ./contracts.js（FORBIDDEN_UPLOAD_FIELDS、
//   FREED_TO_KEYS、FREED_MINUTES_MAX、WEEKLY_COUNT_MAX、STYLES…），本文件不重定义。
//
// 纯函数与绘制分离（node --test 无 DOM 全覆盖，relay home/store 同款约定）：
// · layoutPoster(poster) → 绘制 op 列表（fill-gradient / rect / text），全部坐标
//   纯计算并落在 1080×1920 内；同一输入必得同一输出。
// · drawPoster(canvas, input) → 校验 → 设 1080×1920 → 逐 op 执行；canvas/ctx 由
//   调用方提供（浏览器传真实 canvas，测试传记录型 stub）。
// · exportPosterDataURL(canvas) → PNG dataURL（真实 canvas 才有 toDataURL）。
//   浏览器视觉验收与「流派卡 → 生成分享图」按钮接线归二期集成节点（CTO 派单）。
//
// 纯 ES module：无顶层 DOM、无 fetch、无 storage IO；ES5 风格与 contracts.js 一致。

import {
  STYLES, STYLE_EVIDENCE_MAX,
  validateStyleCard, FREED_TO_KEYS,
  FREED_MINUTES_MAX, WEEKLY_COUNT_MAX,
} from './contracts.js';

// ---------------------------------------------------------------------------
// 常量（原型 ④：1080×1920 PNG）。
// ---------------------------------------------------------------------------
export var POSTER_WIDTH = 1080;
export var POSTER_HEIGHT = 1920;
export var POSTER_MIME = 'image/png';
export var POSTER_SITE_LABEL = 'donego.udify.fun';
export var POSTER_FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif';

// 数据面白名单：海报输入的顶层两键（task D1/S8：海报只吃流派卡 + 聚合计数）。
export var POSTER_FIELDS = ['styleCard', 'facts'];
export var POSTER_FACTS_MIN = 1;
export var POSTER_FACTS_MAX = 4;   // 原型四宫格
export var POSTER_FACT_KINDS = ['relays', 'self-kept', 'batons', 'freed'];
export var POSTER_FACT_LABELS = {
  relays: '次 AI 接力',
  'self-kept': '次自己做到',   // 与 contracts KUDOS_EVENT_KINDS 的 self-kept 同词汇
  batons: '次传棒',
  freed: '空出来给了',
};
// freedTo 的展示标签（键来自 contracts FREED_TO_KEYS；zh 文案是 UI copy，与
// onboarding.js 各自维护，键名绝不本地重定义）。
export var POSTER_FREED_TO_LABELS = {
  family: '家人', exercise: '运动', study: '学新东西', rest: '休息', hobby: '爱好', other: '其他',
};

// ---------------------------------------------------------------------------
// 校验 — 白名单制，未知字段拒绝并 path 定位（与 contracts 同错误形状）。
// ---------------------------------------------------------------------------
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonNegInt(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function checkExactKeys(value, allowed, base, errors) {
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i += 1) {
    if (allowed.indexOf(keys[i]) < 0) errors.push({ path: base + '.' + keys[i], message: '未知字段：白名单外一律拒绝' });
  }
  for (var j = 0; j < allowed.length; j += 1) {
    if (!(allowed[j] in value)) errors.push({ path: base + '.' + allowed[j], message: '缺少必填字段' });
  }
}

export function validatePosterInput(input) {
  var errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: 'poster', message: '必须是对象' }] };
  }
  checkExactKeys(input, POSTER_FIELDS, 'poster', errors);

  var card = isPlainObject(input.styleCard) ? validateStyleCard(input.styleCard) : null;
  if (!card) errors.push({ path: 'poster.styleCard', message: '必须是合法流派卡（contracts validateStyleCard：style/week/evidence）' });

  var facts = [];
  if (!Array.isArray(input.facts)) {
    errors.push({ path: 'poster.facts', message: 'facts 必须是数组' });
  } else if (input.facts.length < POSTER_FACTS_MIN || input.facts.length > POSTER_FACTS_MAX) {
    errors.push({ path: 'poster.facts', message: '聚合数字个数必须是 ' + POSTER_FACTS_MIN + '–' + POSTER_FACTS_MAX });
  } else {
    for (var i = 0; i < input.facts.length; i += 1) {
      var raw = input.facts[i];
      var at = 'poster.facts.' + i;
      if (!isPlainObject(raw)) {
        errors.push({ path: at, message: '必须是对象' });
        continue;
      }
      checkExactKeys(raw, raw.kind === 'freed' ? ['kind', 'value', 'freedTo'] : ['kind', 'value'], at, errors);
      if (POSTER_FACT_KINDS.indexOf(raw.kind) < 0) {
        errors.push({ path: at + '.kind', message: 'kind 必须是 ' + POSTER_FACT_KINDS.join(' / ') });
        continue;
      }
      var cap = raw.kind === 'freed' ? FREED_MINUTES_MAX : WEEKLY_COUNT_MAX;
      if (!nonNegInt(raw.value, cap)) {
        errors.push({ path: at + '.value', message: 'value 必须是 0–' + cap + ' 的整数' });
        continue;
      }
      if (raw.kind === 'freed') {
        if (FREED_TO_KEYS.indexOf(raw.freedTo) < 0) {
          errors.push({ path: at + '.freedTo', message: 'freedTo 必须是 ' + FREED_TO_KEYS.join(' / ') });
          continue;
        }
        facts.push({ kind: 'freed', value: raw.value, freedTo: raw.freedTo });
      } else {
        facts.push({ kind: raw.kind, value: raw.value });
      }
    }
  }

  if (errors.length) return { ok: false, errors: errors };
  return { ok: true, value: { styleCard: card, facts: facts } };
}

export function sanitizePosterInput(input) {
  var result = validatePosterInput(input);
  return result.ok ? result.value : null;
}

// ---------------------------------------------------------------------------
// 纯 helpers — 文本宽度估算（无 canvas 也可排版）与颜色混合。
// ---------------------------------------------------------------------------
var ASCII_WIDTH = 0.56; // 相对字号的近似宽度；CJK/全角 = 1.0

export function estimateTextWidth(textValue, size) {
  if (typeof textValue !== 'string' || !textValue) return 0;
  var width = 0;
  for (var i = 0; i < textValue.length; i += 1) {
    var code = textValue.charCodeAt(i);
    var cjk = (code >= 0x2e80 && code <= 0x9fff)   // CJK 部首/汉字
      || (code >= 0x3000 && code <= 0x303f)         // CJK 标点
      || (code >= 0xff00 && code <= 0xffef);        // 全角
    width += cjk ? size : size * ASCII_WIDTH;
  }
  return width;
}

export function truncateText(textValue, size, maxWidth) {
  if (estimateTextWidth(textValue, size) <= maxWidth) return textValue;
  var out = textValue;
  while (out.length > 1 && estimateTextWidth(out + '…', size) > maxWidth) out = out.slice(0, -1);
  return out + '…';
}

function clampByte(value) {
  // 确定性取整：一律向下取整（如 73.5 → 73），同一输入永远同一输出。
  return Math.max(0, Math.min(255, Math.floor(value)));
}

export function mixHex(a, b, t) {
  var ra = parseInt(a.slice(1, 3), 16);
  var ga = parseInt(a.slice(3, 5), 16);
  var ba = parseInt(a.slice(5, 7), 16);
  var rb = parseInt(b.slice(1, 3), 16);
  var gb = parseInt(b.slice(3, 5), 16);
  var bb = parseInt(b.slice(5, 7), 16);
  var hex = function (x) { return ('0' + clampByte(x).toString(16)).slice(-2).toUpperCase(); };
  return '#'
    + hex(ra + (rb - ra) * t)
    + hex(ga + (gb - ga) * t)
    + hex(ba + (bb - ba) * t);
}

export function freedMinutesLabel(minutes) {
  return (minutes / 60).toFixed(1) + 'h';
}

export function weekNumberLabel(week) {
  var match = /^([0-9]{4})-W([0-9]{2})$/.exec(week || '');
  return match ? '第 ' + match[2] + ' 周' : '';
}

function styleById(styleId) {
  for (var i = 0; i < STYLES.length; i += 1) {
    if (STYLES[i].id === styleId) return STYLES[i];
  }
  return STYLES[0];
}

// ---------------------------------------------------------------------------
// layoutPoster — 纯布局。op 形状（绘制层唯一契约）：
//   {op:'fill-gradient', cx, cy, r, stops:[{at,color}]}  背景径向渐变（全幅）
//   {op:'rect', x, y, w, h, r, fill, opacity?}           圆角矩形（r = w/2 即圆）
//   {op:'text', x, y, text, size, weight?, fill, opacity?, align?}
// 所有坐标为 1080×1920 画布坐标；布局按证据条数/聚合个数自适应。
// ---------------------------------------------------------------------------
var MARGIN = 70;
var CONTENT_W = POSTER_WIDTH - MARGIN * 2;   // 940
var EVIDENCE_BAR_H = 88;
var EVIDENCE_GAP = 18;
var FACT_CELL_H = 190;
var FACT_GAP = 24;
var FACT_CELL_W = Math.floor((CONTENT_W - FACT_GAP) / 2); // 458

function textOp(x, y, textValue, size, fill, extra) {
  var op = { op: 'text', x: x, y: y, text: textValue, size: size, fill: fill };
  if (extra) {
    if (extra.weight) op.weight = extra.weight;
    if (extra.opacity != null) op.opacity = extra.opacity;
    if (extra.align) op.align = extra.align;
  }
  return op;
}

function rectOp(x, y, w, h, r, fill, opacity) {
  var op = { op: 'rect', x: x, y: y, w: w, h: h, r: r, fill: fill };
  if (opacity != null) op.opacity = opacity;
  return op;
}

function factFace(fact) {
  if (fact.kind === 'freed') {
    return {
      value: freedMinutesLabel(fact.value),
      label: POSTER_FACT_LABELS.freed + POSTER_FREED_TO_LABELS[fact.freedTo],
    };
  }
  return { value: String(fact.value), label: POSTER_FACT_LABELS[fact.kind] };
}

export function layoutPoster(poster) {
  var value = sanitizePosterInput(poster);
  if (!value) return [];
  var style = styleById(value.styleCard.style);
  var base = style.color;
  var light = mixHex(base, '#FFFFFF', 0.30);
  var mid = mixHex(base, '#000000', 0.25);
  var dark = mixHex(base, '#000000', 0.55);
  var ops = [];

  // 背景：原型 poster 的径向渐变（120% 70% at 80% 0%）。
  ops.push({
    op: 'fill-gradient',
    cx: Math.round(POSTER_WIDTH * 0.8), cy: 0, r: Math.round(POSTER_WIDTH * 1.2),
    stops: [{ at: 0, color: light }, { at: 0.55, color: mid }, { at: 1, color: dark }],
  });

  // 装饰圆（r = 边长/2 的圆角矩形），右上 + 右下。
  ops.push(rectOp(POSTER_WIDTH - MARGIN - 220, 10, 220, 220, 110, '#FFFFFF', 0.08));
  ops.push(rectOp(POSTER_WIDTH - MARGIN - 140, POSTER_HEIGHT - 150, 140, 140, 70, '#FFFFFF', 0.05));

  // 品牌行。
  ops.push(textOp(MARGIN, 88, '探戈 Done&Go · ' + weekNumberLabel(value.styleCard.week), 30, '#FFFFFF', { opacity: 0.85 }));
  ops.push(textOp(POSTER_WIDTH - MARGIN, 88, '同频', 30, '#FFFFFF', { opacity: 0.85, align: 'right' }));

  // 标题区：「这一周，我是」+ 流派名。
  ops.push(textOp(MARGIN, 320, '这一周，我是', 40, '#FFFFFF', { opacity: 0.8 }));
  var labelSize = 148;
  if (estimateTextWidth(style.label, labelSize) > CONTENT_W) {
    labelSize = Math.floor((CONTENT_W / estimateTextWidth(style.label, labelSize)) * labelSize);
  }
  ops.push(textOp(MARGIN, 445, style.label, labelSize, '#FFFFFF', { weight: '700' }));

  // 吉祥物：探戈机器人的几何近似（头 + 双眼 + 触角），流派色提亮。
  var botBody = mixHex(base, '#FFFFFF', 0.55);
  var botDark = mixHex(base, '#000000', 0.45);
  ops.push(rectOp(896, 236, 8, 18, 4, botBody));
  ops.push(rectOp(889, 214, 22, 22, 11, botBody));
  ops.push(rectOp(820, 252, 160, 150, 44, botBody, 0.95));
  ops.push(rectOp(855, 302, 26, 26, 13, botDark));
  ops.push(rectOp(919, 302, 26, 26, 13, botDark));

  // 本周证据（D3：流派卡三条；≤ STYLE_EVIDENCE_MAX 由 contracts 保证）。
  ops.push(textOp(MARGIN, 648, '本周证据', 30, '#FFFFFF', { opacity: 0.8 }));
  var evidenceTop = 700;
  for (var e = 0; e < value.styleCard.evidence.length && e < STYLE_EVIDENCE_MAX; e += 1) {
    var barY = evidenceTop + e * (EVIDENCE_BAR_H + EVIDENCE_GAP);
    ops.push(rectOp(MARGIN, barY, CONTENT_W, EVIDENCE_BAR_H, 22, '#FFFFFF', 0.12));
    ops.push(textOp(MARGIN + 30, barY + 57, truncateText(value.styleCard.evidence[e], 36, CONTENT_W - 60), 36, '#FFFFFF', { opacity: 0.95 }));
  }
  var evidenceBottom = evidenceTop + value.styleCard.evidence.length * (EVIDENCE_BAR_H + EVIDENCE_GAP) - EVIDENCE_GAP;

  // 聚合数字四宫格（1–4 个自适应，两列）。
  var factsTop = evidenceBottom + 70;
  for (var f = 0; f < value.facts.length; f += 1) {
    var col = f % 2;
    var row = Math.floor(f / 2);
    var cellX = MARGIN + col * (FACT_CELL_W + FACT_GAP);
    var cellY = factsTop + row * (FACT_CELL_H + FACT_GAP);
    var face = factFace(value.facts[f]);
    ops.push(rectOp(cellX, cellY, FACT_CELL_W, FACT_CELL_H, 32, '#FFFFFF', 0.10));
    ops.push(textOp(cellX + 34, cellY + 118, face.value, 88, '#FFFFFF', { weight: '700' }));
    ops.push(textOp(cellX + 34, cellY + 162, face.label, 32, '#FFFFFF', { opacity: 0.85 }));
  }
  var factsBottom = factsTop + Math.ceil(value.facts.length / 2) * FACT_CELL_H
    + (Math.ceil(value.facts.length / 2) - 1) * FACT_GAP;

  // 流派一句话 +「你是什么流派？」。
  var mottoY = Math.max(factsBottom + 90, 1560);
  ops.push(textOp(MARGIN, mottoY, style.motto, 42, '#FFFFFF', { opacity: 0.95 }));
  ops.push(textOp(MARGIN, mottoY + 64, '你是什么流派？', 42, '#FFFFFF', { weight: '700' }));

  // 底部：二维码占位 + 站点行。
  ops.push(rectOp(MARGIN, 1756, 104, 104, 20, '#FFFFFF'));
  ops.push(rectOp(MARGIN + 24, 1780, 56, 56, 8, dark));
  ops.push(textOp(MARGIN + 136, 1798, '扫码测测你的时间流派', 30, '#FFFFFF', { opacity: 0.9 }));
  ops.push(textOp(MARGIN + 136, 1840, POSTER_SITE_LABEL, 30, '#FFFFFF', { opacity: 0.9 }));

  return ops;
}

// ---------------------------------------------------------------------------
// 绘制层 — canvas/ctx 由调用方注入（浏览器真实 canvas / 测试记录型 stub）。
// ---------------------------------------------------------------------------
function applyOpacity(ctx, op) {
  ctx.globalAlpha = op.opacity != null ? op.opacity : 1;
}

function pathRoundRect(ctx, x, y, w, h, r) {
  var rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
  ctx.fill();
}

export function drawPoster(canvas, input) {
  var value = sanitizePosterInput(input);
  if (!value || !canvas || typeof canvas.getContext !== 'function') return false;
  canvas.width = POSTER_WIDTH;
  canvas.height = POSTER_HEIGHT;
  var ctx = canvas.getContext('2d');
  if (!ctx) return false;

  var ops = layoutPoster(value);
  for (var i = 0; i < ops.length; i += 1) {
    var op = ops[i];
    if (op.op === 'fill-gradient') {
      var gradient = ctx.createRadialGradient(op.cx, op.cy, 0, op.cx, op.cy, op.r);
      for (var s = 0; s < op.stops.length; s += 1) gradient.addColorStop(op.stops[s].at, op.stops[s].color);
      ctx.globalAlpha = 1;
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);
    } else if (op.op === 'rect') {
      applyOpacity(ctx, op);
      ctx.fillStyle = op.fill;
      pathRoundRect(ctx, op.x, op.y, op.w, op.h, op.r || 0);
    } else if (op.op === 'text') {
      applyOpacity(ctx, op);
      ctx.fillStyle = op.fill;
      ctx.font = (op.weight ? op.weight + ' ' : '') + op.size + 'px ' + POSTER_FONT;
      ctx.textAlign = op.align || 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  ctx.globalAlpha = 1;
  return true;
}

export function exportPosterDataURL(canvas) {
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;
  return canvas.toDataURL(POSTER_MIME);
}
