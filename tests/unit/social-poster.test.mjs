import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO·S8分享引导 line: web/social/poster.js — 流派海报 canvas 导出
// 1080×1920（PRD design/social-sync/PRD.md §4.1 "生成分享图"、§6；原型
// design/social-sync/prototype.html section ④ poster）。
//
// Hard gates proven here:
// - D2 海报数据面白名单：输入只允许 {styleCard, facts}，任何未知字段
//   （含 FORBIDDEN_UPLOAD_FIELDS 全清单逐个注入）一律【拒绝】并给出
//   path 定位，sanitize 返回 null —— 绝不静默剥离。事项标题/材料/时间/
//   地点永远进不了海报数据面，更进不了任何绘制文本。
// - 布局纯函数 layoutPoster：所有绘制 op 落在 1080×1920 画布内；证据
//   三条完整可见；只有白名单文本会出现在绘制文本里。
// - drawPoster / exportPosterDataURL 通过注入的 canvas/ctx 驱动，
//   node --test 无 DOM 即可全覆盖（浏览器视觉验收归集成节点）。

import {
  STYLES, STYLE_IDS, STYLE_EVIDENCE_MAX,
  validateStyleCard, FORBIDDEN_UPLOAD_FIELDS, FREED_TO_KEYS,
} from '../../web/social/contracts.js';
import {
  POSTER_WIDTH, POSTER_HEIGHT, POSTER_MIME, POSTER_SITE_LABEL,
  POSTER_FIELDS, POSTER_FACT_KINDS, POSTER_FACT_LABELS,
  validatePosterInput, sanitizePosterInput,
  estimateTextWidth, truncateText, mixHex,
  freedMinutesLabel, weekNumberLabel, layoutPoster,
  drawPoster, exportPosterDataURL,
} from '../../web/social/poster.js';

// ---------------------------------------------------------------------------
// Fixtures — styleCard must satisfy contracts validateStyleCard so the
// fixtures prove poster.js consumes real contract output, not a private shape.
// ---------------------------------------------------------------------------
const NIGHT_EVIDENCE = [
  '58% 的事在晚上 9 点后开始',
  '创作类的事占了 41%',
  '学会 2 个新用法，自己做到 1 次',
];

function mkStyleCard(over = {}) {
  const base = {
    style: 'night-creator',
    week: '2026-W43',
    evidence: NIGHT_EVIDENCE.slice(),
    ...over,
  };
  const validated = validateStyleCard(base);
  assert.ok(validated, 'fixture styleCard must satisfy contracts validateStyleCard');
  return validated;
}

function mkPosterInput(over = {}) {
  return {
    styleCard: mkStyleCard(),
    facts: [
      { kind: 'relays', value: 9 },
      { kind: 'self-kept', value: 3 },
      { kind: 'batons', value: 2 },
      { kind: 'freed', value: 180, freedTo: 'exercise' },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 尺寸与常量（原型 ④：1080×1920 导出）。
// ---------------------------------------------------------------------------
test('poster canvas is 1080x1920 PNG with a stable site label', () => {
  assert.equal(POSTER_WIDTH, 1080);
  assert.equal(POSTER_HEIGHT, 1920);
  assert.equal(POSTER_MIME, 'image/png');
  assert.equal(typeof POSTER_SITE_LABEL, 'string');
  assert.ok(POSTER_SITE_LABEL.length > 0);
});

test('poster fact kinds are the four aggregate counters from the PRD prototype', () => {
  assert.deepEqual(POSTER_FACT_KINDS, ['relays', 'self-kept', 'batons', 'freed']);
  assert.deepEqual(POSTER_FIELDS, ['styleCard', 'facts']);
  for (const kind of POSTER_FACT_KINDS) {
    assert.ok(POSTER_FACT_LABELS[kind], 'fact kind needs a zh label: ' + kind);
  }
});

// ---------------------------------------------------------------------------
// 2. D2 海报数据面白名单 — 未知字段一律拒绝（不是剥离）。
// ---------------------------------------------------------------------------
test('valid poster input passes and the sanitized value carries exactly the whitelisted keys', () => {
  const result = validatePosterInput(mkPosterInput());
  assert.equal(result.ok, true, JSON.stringify(result.errors || null));
  assert.deepEqual(Object.keys(result.value).sort(), ['facts', 'styleCard']);
  assert.deepEqual(Object.keys(result.value.styleCard).sort(), ['evidence', 'style', 'week']);
  for (const fact of result.value.facts) {
    assert.ok(fact.kind === 'freed'
      ? Object.keys(fact).sort().join(',') === 'freedTo,kind,value'
      : Object.keys(fact).sort().join(',') === 'kind,value');
  }
  // round-trips through contracts validation — poster value stays contract-shaped
  assert.deepEqual(validateStyleCard(result.value.styleCard), result.value.styleCard);
});

test('D2: every name in FORBIDDEN_UPLOAD_FIELDS injected at top level is REJECTED with a located error', () => {
  for (const field of FORBIDDEN_UPLOAD_FIELDS) {
    const input = mkPosterInput();
    input[field] = '9 点写周报';
    const result = validatePosterInput(input);
    assert.equal(result.ok, false, field + ' must be rejected');
    assert.ok(result.errors.some((e) => e.path === 'poster.' + field), field + ' error must be located');
    assert.equal(sanitizePosterInput(input), null, field + ' sanitize must be null');
  }
});

test('D2: raw-content style fields injected into styleCard or a fact are REJECTED', () => {
  // styleCard face is guarded by contracts validateStyleCard (exact keys)
  const withTitle = mkPosterInput();
  withTitle.styleCard = { ...mkStyleCard(), title: '给妈妈讲体检单' };
  assert.equal(validatePosterInput(withTitle).ok, false);
  assert.equal(sanitizePosterInput(withTitle), null);

  // facts face rejects any key beyond {kind, value, freedTo}
  for (const field of ['title', 'note', 'material', 'startTime', 'location']) {
    const input = mkPosterInput();
    input.facts = [{ kind: 'relays', value: 9, [field]: 'x' }];
    const result = validatePosterInput(input);
    assert.equal(result.ok, false, 'fact.' + field + ' must be rejected');
    assert.ok(result.errors.some((e) => e.path.startsWith('poster.facts.')), 'fact error located');
    assert.equal(sanitizePosterInput(input), null);
  }
});

test('facts face enforces kinds, values and the freed/freedTo pairing', () => {
  const cases = [
    [{ kind: 'nope', value: 1 }],                       // unknown kind
    [{ kind: 'relays' }],                               // missing value
    [{ kind: 'relays', value: 1.5 }],                   // non-integer
    [{ kind: 'relays', value: -1 }],                    // negative
    [{ kind: 'relays', value: '9' }],                   // string value
    [{ kind: 'freed', value: 180 }],                    // freed without freedTo
    [{ kind: 'relays', value: 9, freedTo: 'family' }],  // freedTo on a non-freed kind
    [{ kind: 'freed', value: 180, freedTo: 'homework' }], // freedTo outside FREED_TO_KEYS
  ];
  for (const facts of cases) {
    const input = mkPosterInput({ facts });
    assert.equal(validatePosterInput(input).ok, false, JSON.stringify(facts));
    assert.equal(sanitizePosterInput(input), null);
  }
  // freed minutes cap comes from contracts FREED_MINUTES_MAX scale (weekly)
  const over = mkPosterInput({ facts: [{ kind: 'freed', value: 10081, freedTo: 'rest' }] });
  assert.equal(validatePosterInput(over).ok, false);
  // non-array / wrong styleCard type / non-object input
  assert.equal(validatePosterInput({ styleCard: mkStyleCard(), facts: 'nope' }).ok, false);
  assert.equal(validatePosterInput(null).ok, false);
  assert.equal(sanitizePosterInput({ styleCard: null, facts: [] }), null);
});

test('the sanitized poster value contains no forbidden key anywhere in its tree', () => {
  const value = sanitizePosterInput(mkPosterInput());
  assert.ok(value);
  const seen = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    seen.push(...Object.keys(node));
    Object.values(node).forEach(walk);
  })(value);
  for (const key of seen) {
    assert.equal(FORBIDDEN_UPLOAD_FIELDS.includes(key), false, 'forbidden key leaked: ' + key);
  }
});

// ---------------------------------------------------------------------------
// 3. 纯函数 helpers。
// ---------------------------------------------------------------------------
test('estimateTextWidth: CJK glyphs are ~1em, ASCII narrower, deterministic', () => {
  assert.equal(estimateTextWidth('深夜创作派', 100), 5 * 100);
  assert.equal(estimateTextWidth('AAAAA', 100), estimateTextWidth('AAAAA', 100));
  assert.ok(estimateTextWidth('AAAAA', 100) < 5 * 100);
  assert.ok(estimateTextWidth('58% 的事', 36) > 0);
  assert.equal(estimateTextWidth('', 36), 0);
});

test('truncateText keeps text that fits and appends ellipsis only when it overflows', () => {
  assert.equal(truncateText('创作类的事占了 41%', 36, 880), '创作类的事占了 41%');
  const eighty = '一'.repeat(80); // 80 CJK chars can never fit 880px at 36px
  const out = truncateText(eighty, 36, 880);
  assert.ok(out.endsWith('…'));
  assert.ok(estimateTextWidth(out, 36) <= 880);
  assert.ok(out.length >= 2);
});

test('mixHex blends two hex colors deterministically', () => {
  assert.equal(mixHex('#000000', '#FFFFFF', 0), '#000000');
  assert.equal(mixHex('#000000', '#FFFFFF', 1), '#FFFFFF');
  const mid = mixHex('#4C7A93', '#000000', 0.5);
  assert.equal(mid, '#263D49'); // each channel halved and floored
  assert.equal(mixHex('#4C7A93', '#000000', 0.5), mid);
});

test('freedMinutesLabel renders hours with one decimal, like the prototype 3.0h', () => {
  assert.equal(freedMinutesLabel(180), '3.0h');
  assert.equal(freedMinutesLabel(90), '1.5h');
  assert.equal(freedMinutesLabel(0), '0.0h');
});

test('weekNumberLabel parses the ISO week code', () => {
  assert.equal(weekNumberLabel('2026-W43'), '第 43 周');
  assert.equal(weekNumberLabel('2026-W07'), '第 07 周');
});

// ---------------------------------------------------------------------------
// 4. layoutPoster — 纯布局：界内、证据三条、白名单文本封闭集。
// ---------------------------------------------------------------------------
function opBoundsOk(ops) {
  for (const op of ops) {
    if (op.op === 'rect') {
      if (op.x < 0 || op.y < 0 || op.x + op.w > POSTER_WIDTH + 1e-6 || op.y + op.h > POSTER_HEIGHT + 1e-6) return false;
    } else if (op.op === 'circle') {
      if (op.cx - op.r < -1e-6 || op.cy - op.r < -1e-6 || op.cx + op.r > POSTER_WIDTH + 1e-6 || op.cy + op.r > POSTER_HEIGHT + 1e-6) return false;
    } else if (op.op === 'text') {
      if (op.x < 0 || op.x > POSTER_WIDTH || op.y < 0 || op.y > POSTER_HEIGHT) return false;
    } else if (op.op === 'fill-gradient') {
      if (op.cx < 0 || op.cy < 0 || op.r <= 0) return false;
    } else {
      return false; // unknown op kind
    }
  }
  return true;
}

test('layout: every draw op of the canonical poster stays inside 1080x1920', () => {
  const value = sanitizePosterInput(mkPosterInput());
  const ops = layoutPoster(value);
  assert.ok(Array.isArray(ops) && ops.length > 10);
  assert.equal(opBoundsOk(ops), true, JSON.stringify(ops.filter((o) => !opBoundsOk([o]))));
});

test('layout: evidence three lines, style label, motto and week label are all drawn verbatim', () => {
  const value = sanitizePosterInput(mkPosterInput());
  const texts = layoutPoster(value).filter((o) => o.op === 'text').map((o) => o.text);
  for (const line of NIGHT_EVIDENCE) assert.ok(texts.includes(line), 'missing evidence: ' + line);
  assert.ok(texts.includes('深夜创作派'));
  assert.ok(texts.includes('灯熄了，你的想法才刚开始。'));
  assert.ok(texts.includes('探戈 Done&Go · 第 43 周'), 'brand row must carry the week label');
  assert.ok(texts.includes('你是什么流派？'));
});

test('layout: the drawn text set is CLOSED over the whitelist — no raw item content can appear', () => {
  const value = sanitizePosterInput(mkPosterInput());
  const texts = layoutPoster(value).filter((o) => o.op === 'text').map((o) => o.text);
  const allowed = new Set([
    '探戈 Done&Go · 第 43 周', '同频', '这一周，我是', '深夜创作派',
    '本周证据', ...NIGHT_EVIDENCE,
    '9', '3', '2', '3.0h',
    '次 AI 接力', '次自己做到', '次传棒', '空出来给了运动',
    '灯熄了，你的想法才刚开始。', '你是什么流派？',
    '扫码测测你的时间流派', POSTER_SITE_LABEL,
  ]);
  for (const text of texts) assert.ok(allowed.has(text), 'non-whitelisted poster text: ' + text);
  // and the poster never draws any of the D2 forbidden sample strings
  for (const raw of ['给妈妈讲体检单', '9 点写周报', 'meeting notes 原文']) {
    assert.equal(texts.some((t) => t.includes(raw)), false);
  }
});

test('layout: an 80-char evidence line is truncated with an ellipsis and stays in bounds', () => {
  const long = '长'.repeat(STYLE_EVIDENCE_MAX === 3 ? 80 : 80);
  const value = sanitizePosterInput(mkPosterInput({
    styleCard: mkStyleCard({ evidence: [long, '第二条', '第三条'] }),
  }));
  assert.ok(value);
  const texts = layoutPoster(value).filter((o) => o.op === 'text').map((o) => o.text);
  const drawnLong = texts.find((t) => t.endsWith('…'));
  assert.ok(drawnLong, 'long evidence must be truncated');
  assert.ok(!texts.includes(long), 'untruncated 80-char evidence must not be drawn');
  assert.equal(opBoundsOk(layoutPoster(value)), true);
});

test('layout: adapts to 1..3 evidence lines and 1..4 facts across ALL six styles', () => {
  for (const style of STYLE_IDS) {
    for (const n of [1, 2, 3]) {
      for (const facts of [
        [{ kind: 'relays', value: 0 }],
        [{ kind: 'relays', value: 9 }, { kind: 'self-kept', value: 3 }, { kind: 'batons', value: 2 }, { kind: 'freed', value: 45, freedTo: 'family' }],
      ]) {
        const value = sanitizePosterInput(mkPosterInput({
          styleCard: mkStyleCard({ style, evidence: NIGHT_EVIDENCE.slice(0, n) }),
          facts,
        }));
        assert.ok(value, style + ' n=' + n);
        const ops = layoutPoster(value);
        assert.equal(opBoundsOk(ops), true, style + ' n=' + n);
      }
    }
  }
  // gradient stops derive from the style color: same input → same output
  const a = layoutPoster(sanitizePosterInput(mkPosterInput()));
  const b = layoutPoster(sanitizePosterInput(mkPosterInput()));
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// 5. drawPoster / exportPosterDataURL — 注入 canvas + 记录型 ctx stub。
// ---------------------------------------------------------------------------
function stubCanvas() {
  const calls = { ops: [], gradients: [], setSize: [] };
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'createRadialGradient') {
        return (cx, cy, r0, cx2, cy2, r1) => {
          calls.gradients.push({ cx, cy, r0, cx2, cy2, r1, stops: [] });
          return { addColorStop: (at, color) => calls.gradients[calls.gradients.length - 1].stops.push({ at, color }) };
        };
      }
      if (typeof prop === 'string' && ['beginPath', 'moveTo', 'lineTo', 'arcTo', 'closePath', 'fill', 'fillRect', 'fillText'].includes(prop)) {
        return (...args) => calls.ops.push({ method: prop, args });
      }
      return target[prop];
    },
    set(target, prop, v) { target[prop] = v; return true; },
  });
  const canvas = {
    width: 0, height: 0,
    getContext: () => ctx,
    toDataURL: (mime) => 'data:' + mime + ';base64,STUB',
  };
  return { canvas, calls };
}

test('drawPoster sizes the canvas 1080x1920 and executes every layout op', () => {
  const { canvas, calls } = stubCanvas();
  assert.equal(drawPoster(canvas, mkPosterInput()), true);
  assert.deepEqual([canvas.width, canvas.height], [POSTER_WIDTH, POSTER_HEIGHT]);
  const value = sanitizePosterInput(mkPosterInput());
  const expectTexts = layoutPoster(value).filter((o) => o.op === 'text').length;
  const drawnTexts = calls.ops.filter((o) => o.method === 'fillText').length;
  assert.equal(drawnTexts, expectTexts);
  assert.ok(calls.gradients.length >= 1, 'background gradient created');
  assert.equal(calls.gradients[0].r1 >= POSTER_WIDTH, true);
  const stops = calls.gradients[0].stops;
  assert.equal(stops.length, 3);
  assert.deepEqual(stops.map((s) => s.at), [0, 0.55, 1]);
});

test('drawPoster rejects invalid input WITHOUT touching the canvas', () => {
  const { canvas, calls } = stubCanvas();
  const bad = mkPosterInput();
  bad.title = '9 点写周报';
  assert.equal(drawPoster(canvas, bad), false);
  assert.equal(canvas.width, 0);
  assert.equal(calls.ops.length, 0);
  // a canvas without a 2d context degrades to false, never throws
  assert.equal(drawPoster({ width: 0, height: 0, getContext: () => null }, mkPosterInput()), false);
});

test('exportPosterDataURL returns a PNG dataURL via the canvas', () => {
  const { canvas } = stubCanvas();
  assert.equal(exportPosterDataURL(canvas), 'data:' + POSTER_MIME + ';base64,STUB');
  assert.equal(exportPosterDataURL({}), null);
  assert.equal(exportPosterDataURL(null), null);
});
