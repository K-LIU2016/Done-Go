import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// T4 播放器线: web/story/player.js + web/story/story.css。
// SPEC design/story-recap/SPEC.md §3（页内交互：轻点左/右翻页、长按暂停、
// 顶部进度条 6–8s 自动前进可关闭、右上角静音、底部「轻点继续」、长按数字
// 弹出口径卡）、§4（换页音乐连续不重启、prefers-reduced-motion 不影响音乐、
// 一键静音并记住）、§8（390/1280 两档、桌面居中手机比例卡片+背景模糊）。
// 视觉标准 = design/story-recap/prototype.html（.bars/.chrome/.inner/.foot）。
// token 对齐 relay-v2 SPEC §3（同名 CSS 变量、同名值挂 .st-play 作用域）。
//
// 钉死的决策（T4 线内，均在结果里上报）：
// - 自动前进默认 7000ms（SPEC §3 的 6–8s 区间中值），可注入并钳制到区间内。
// - 长按阈值 500ms（Apple HIG 惯例）；口径卡与「长按暂停」共用该阈值，
//   口径卡优先（[data-metric] 上的长按不触发暂停）。
// - 静音/自动前进偏好存 tango-donego.story-ui.v1（独立于章节存储）。
// - 封面页隐藏进度条（原型 p0 无 .bars）；「翻开」= data-st-open 委托点击，
//   在该手势里启动音频（移动端 Safari 自动播放限制，SPEC §4）。
// - 每页背景 = 原型 p0–p9 渐变，落在 story.css 的
//   .st-play[data-page-type=X] --page-bg（桌面背景模糊需要；年度页型无原型，
//   用中性深色兜底，最终视觉待 pages 线/CTO 定稿）。

import {
  STORY_UI_KEY,
  AUTO_DWELL_MS,
  DWELL_RANGE,
  LONG_PRESS_MS,
  TAP_SLOP_PX,
  LIGHT_PAGES,
  PAGE_TYPE_LABELS,
  classifyTap,
  segmentState,
  fillPercent,
  resolveDwellMs,
  shouldAutoAdvance,
  keyboardAction,
  loadUiPrefs,
  saveUiPrefs,
  prefersReducedMotion,
  pageStatusText,
  muteButtonLabel,
  autoAdvanceButtonLabel,
  esc,
  metricCardModel,
  renderProgress,
  renderChrome,
  renderMetricCard,
  createStoryPlayer,
} from '../../web/story/player.js';
import { PAGE_TYPES, YEAR_PAGE_TYPES, validateChapter, songInputFor } from '../../web/story/contracts.js';

// ---------------------------------------------------------------------------
// 夹具：一份合法的月章 chapter（stats 用最小合法值填充）。
// ---------------------------------------------------------------------------
const STATS_BASE = {
  totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
  kindMinutes: [
    { kind: 'necessary', minutes: 100, share: 0.22 },
    { kind: 'create', minutes: 140, share: 0.31 },
    { kind: 'connect', minutes: 80, share: 0.18 },
    { kind: 'explore', minutes: 60, share: 0.13 },
    { kind: 'restore', minutes: 50, share: 0.11 },
    { kind: 'stillness', minutes: 22, share: 0.05 },
  ],
  topDay: null,
  lessons: { learned: [], firstGraduation: null },
  savedTime: { confirmedMinutes: 360, allocations: [] },
  rhythm: {
    hourly: Array.from({ length: 24 }, () => 0),
    goldenHour: 22,
    genre: { id: 'night-create', title: '深夜创作派', tagline: '灯熄了，想法才刚开始' },
  },
  panels: [{ label: '第 1 周', caption: '开学第一周' }],
  keywords: [{ word: '论文', weight: 9 }],
  wishEcho: null,
  song: { busyness: 0.62, mood: 0.7, dominantKind: 'create', weeklyCounts: [14, 22, 28, 22], graduations: [0, 1, 0, 2] },
};

function fixtureChapter(overrides) {
  const c = {
    id: '3f2a1b2c-1111-4222-8333-444455556666',
    no: 10,
    type: 'month',
    variant: 'full',
    period: { from: '2026-10-01', to: '2026-10-31' },
    generatedAt: '2026-10-31T20:00:00.000Z',
    stats: STATS_BASE,
    pages: PAGE_TYPES.map((t) => ({ type: t })),
    captions: {},
    wish: null,
    songSeed: 1234567890,
  };
  return Object.assign({}, c, overrides || {});
}

// ---------------------------------------------------------------------------
// fake DOM / clock / storage —— relay rv2-shell.test 的 harness 加手势所需的
// closest/matches/setProperty。
// ---------------------------------------------------------------------------
function matchesSelector(node, selector) {
  return String(selector)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((part) => {
      const m = part.match(/^([a-z]+|[A-Z][a-zA-Z]*)?((?:\.[A-Za-z0-9_-]+|\[[^\]]+\])*)$/);
      if (!m) return false;
      const tag = m[1];
      if (tag && node.tagName !== tag.toUpperCase()) return false;
      const tokens = (m[2] || '').match(/(\.[A-Za-z0-9_-]+|\[[^\]]+\])/g) || [];
      return tokens.every((t) => {
        if (t[0] === '.') return node.classList.contains(t.slice(1));
        const attr = t.slice(1, -1);
        const eq = attr.indexOf('=');
        if (eq < 0) return node.getAttribute(attr.split('~=')[0].trim()) != null;
        const key = attr.slice(0, eq).replace(/[~^|$*]?=$/, '').trim();
        const val = attr.slice(eq + 1).replace(/^["']|["']$/g, '');
        return node.getAttribute(key) === val;
      });
    });
}

function el(tag, attrs) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.assign({}, attrs || {}),
    listeners: {},
    children: [],
    style: {
      setProperty(k, v) { this[k] = String(v); },
      removeProperty(k) { const v = this[k]; delete this[k]; return v; },
    },
    parentNode: null,
    _innerHTML: '',
    _textContent: '',
  };
  node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
  node.removeAttribute = (k) => { delete node.attrs[k]; };
  node.addEventListener = (t, fn) => { (node.listeners[t] ||= []).push(fn); };
  node.removeEventListener = (t, fn) => {
    const a = node.listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  node.appendChild = (c) => { c.parentNode = node; node.children.push(c); return c; };
  node.remove = () => {
    if (node.parentNode) {
      const i = node.parentNode.children.indexOf(node);
      if (i >= 0) node.parentNode.children.splice(i, 1);
      node.parentNode = null;
    }
  };
  node.contains = (n) => { let p = n; while (p) { if (p === node) return true; p = p.parentNode; } return false; };
  node.querySelector = () => null;
  node.querySelectorAll = () => [];
  node.closest = (sel) => (matchesSelector(node, sel) ? node : (node.parentNode ? node.parentNode.closest(sel) : null));
  node.matches = (sel) => matchesSelector(node, sel);
  node.focus = () => {};
  node.blur = () => {};
  node.click = () => { (node.listeners.click || []).forEach((fn) => fn({ target: node })); };
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._innerHTML; },
    set(v) { node._innerHTML = String(v); node.children = []; },
  });
  Object.defineProperty(node, 'textContent', {
    get() { return node._textContent; },
    set(v) { node._textContent = String(v); },
  });
  node.classList = {
    _set: new Set(),
    add(...cs) { cs.forEach((c) => this._set.add(c)); },
    remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
    toggle(c, force) { if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (force) this._set.add(c); else this._set.delete(c); },
    contains(c) { return this._set.has(c); },
  };
  const cls = attrs && attrs.class;
  if (cls) String(cls).split(/\s+/).filter(Boolean).forEach((c) => node.classList.add(c));
  return node;
}

function fakeDoc() {
  const d = el('html');
  d.documentElement = d;
  d.body = el('body');
  d.createElement = (t, a) => el(t, a);
  return d;
}

function fakeWin(opts) {
  const w = opts || {};
  return {
    innerWidth: w.innerWidth || 390,
    localStorage: w.storage,
    matchMedia: w.matchMedia,
    addEventListener() {},
    removeEventListener() {},
  };
}

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

function fakeClock() {
  let t = 1000;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => t,
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      while (t < end) {
        t += 1;
        for (const [id, timer] of timers) {
          if (t % timer.ms === 0) timer.fn();
        }
      }
    },
    _timers: timers,
  };
}

function fakeAudio() {
  const calls = { start: [], setSegment: [], setMuted: [], stop: 0 };
  return {
    calls,
    started() { return calls.start.length > 0; },
    start(input, opts) { calls.start.push({ input, opts }); },
    setSegment(i) { calls.setSegment.push(i); },
    setMuted(b) { calls.setMuted.push(b); },
    stop() { calls.stop += 1; },
  };
}

function pointerEvent(type, target, opts) {
  const o = opts || {};
  return {
    type,
    target,
    clientX: o.clientX == null ? 300 : o.clientX,
    clientY: o.clientY == null ? 40 : o.clientY,
    pointerId: 1,
    preventDefault() {},
    stopPropagation() {},
  };
}

function mountPlayer(overrides) {
  const o = Object.assign({
    doc: fakeDoc(),
    win: fakeWin({ storage: memoryStorage() }),
    clock: fakeClock(),
    storage: memoryStorage(),
    audio: fakeAudio(),
    chapter: fixtureChapter(),
    renderPage: (page, index) => '<div class="pg-test" data-page-index="' + index + '">' + page.type + '</div>',
    getDefinition: (key) => (key === 'totals.events'
      ? { label: '事项总数', source: '旧账本 entries', method: '期间内 done 事项计数', sample: 86 }
      : null),
  }, overrides || {});
  o.mount = o.mount || el('div');
  const api = createStoryPlayer(o);
  return { api, o };
}

function fire(elNode, type, event) {
  (elNode.listeners[type] || []).forEach((fn) => fn(event || { target: elNode, preventDefault() {}, stopPropagation() {} }));
}

// 手势：在 stage 根上压下并抬起（target=stage 本体 → 不命中交互元素）。
function gestureTap(api, o, x) {
  const stage = api._stage;
  fire(stage, 'pointerdown', pointerEvent('pointerdown', stage, { clientX: x }));
  o.clock.advance(60);
  fire(stage, 'pointerup', pointerEvent('pointerup', stage, { clientX: x }));
}

function gestureLongPress(api, o, target) {
  const stage = api._stage;
  const node = target || stage;
  fire(stage, 'pointerdown', pointerEvent('pointerdown', node));
  o.clock.advance(LONG_PRESS_MS + 120);
  fire(stage, 'pointerup', pointerEvent('pointerup', node));
}

function openCover(api, o) {
  const btn = el('button', { 'data-st-open': '' });
  fire(api._root, 'click', { target: btn, preventDefault() {}, stopPropagation() {} });
}

// ---------------------------------------------------------------------------
// 1) 纯常量与阈值 —— SPEC §3/§4 的数字钉死
// ---------------------------------------------------------------------------
test('constants: dwell 6–8s, long-press 500ms, tap slop, ui store key', () => {
  assert.equal(STORY_UI_KEY, 'tango-donego.story-ui.v1');
  assert.deepEqual(DWELL_RANGE, [6000, 8000]);
  assert.ok(AUTO_DWELL_MS >= DWELL_RANGE[0] && AUTO_DWELL_MS <= DWELL_RANGE[1], '默认停留落在 6–8s');
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(typeof TAP_SLOP_PX, 'number');
});

test('resolveDwellMs: 注入值钳制到 6–8s，非法值回默认', () => {
  assert.equal(resolveDwellMs(null), AUTO_DWELL_MS);
  assert.equal(resolveDwellMs(5000), 6000);
  assert.equal(resolveDwellMs(12000), 8000);
  assert.equal(resolveDwellMs(6500), 6500);
  assert.equal(resolveDwellMs('x'), AUTO_DWELL_MS);
});

// ---------------------------------------------------------------------------
// 2) 手势分类与进度模型（纯函数）
// ---------------------------------------------------------------------------
test('classifyTap: 左半上一页、右半下一页，边界与非法输入', () => {
  assert.equal(classifyTap(0, 390), 'prev');
  assert.equal(classifyTap(194, 390), 'prev');
  assert.equal(classifyTap(195, 390), 'next');
  assert.equal(classifyTap(389, 390), 'next');
  assert.equal(classifyTap(null, 390), null);
  assert.equal(classifyTap(100, 0), null);
});

test('segmentState: done/current/todo 三态', () => {
  assert.equal(segmentState(0, 2), 'done');
  assert.equal(segmentState(2, 2), 'current');
  assert.equal(segmentState(5, 2), 'todo');
});

test('fillPercent: 线性填充并钳制到 [0,1]', () => {
  assert.equal(fillPercent(0, 7000), 0);
  assert.ok(Math.abs(fillPercent(3500, 7000) - 0.5) < 1e-9);
  assert.equal(fillPercent(99999, 7000), 1);
  assert.equal(fillPercent(-5, 7000), 0);
});

test('shouldAutoAdvance: 封面未翻开/暂停/末页/关闭/输入聚焦均不前进', () => {
  const base = { opened: true, paused: false, autoAdvance: true, pageIndex: 1, pageCount: 10, interactive: false };
  assert.equal(shouldAutoAdvance(base), true);
  assert.equal(shouldAutoAdvance(Object.assign({}, base, { opened: false })), false);
  assert.equal(shouldAutoAdvance(Object.assign({}, base, { paused: true })), false);
  assert.equal(shouldAutoAdvance(Object.assign({}, base, { pageIndex: 9, pageCount: 10 })), false);
  assert.equal(shouldAutoAdvance(Object.assign({}, base, { autoAdvance: false })), false);
  assert.equal(shouldAutoAdvance(Object.assign({}, base, { interactive: true })), false);
});

// ---------------------------------------------------------------------------
// 3) 键盘与无障碍文案（读屏）
// ---------------------------------------------------------------------------
test('keyboardAction: ← → 空格', () => {
  assert.equal(keyboardAction('ArrowLeft'), 'prev');
  assert.equal(keyboardAction('ArrowRight'), 'next');
  assert.equal(keyboardAction(' '), 'toggle-pause');
  assert.equal(keyboardAction('Enter'), null);
  assert.equal(keyboardAction('Spacebar'), null, '只认规范键名');
});

test('PAGE_TYPE_LABELS: 月章 10 页 + 年度 6 页全有中文名，且不出现「留白」', () => {
  for (const t of PAGE_TYPES) assert.ok(PAGE_TYPE_LABELS[t], t + ' 有读屏名');
  for (const t of YEAR_PAGE_TYPES) assert.ok(PAGE_TYPE_LABELS[t], t + ' 有读屏名');
  const all = Object.values(PAGE_TYPE_LABELS).join('');
  assert.ok(!all.includes('留白'), '叙事红线：不出现「留白」');
  assert.equal(PAGE_TYPE_LABELS.timeColors, '时间的颜色');
  assert.equal(PAGE_TYPE_LABELS.poster, '海报');
});

test('pageStatusText: 第 N 页/共 M 页/页型名', () => {
  const chapter = fixtureChapter();
  assert.equal(pageStatusText(chapter, 1), '第 2 页，共 10 页：开篇数字');
  assert.equal(pageStatusText(chapter, 0), '第 1 页，共 10 页：封面');
  assert.equal(pageStatusText(null, 0), '');
});

test('mute/autoAdvance 按钮读屏标签随状态切换', () => {
  assert.equal(muteButtonLabel(false), '静音');
  assert.equal(muteButtonLabel(true), '开启音乐');
  assert.equal(autoAdvanceButtonLabel(true), '关闭自动前进');
  assert.equal(autoAdvanceButtonLabel(false), '开启自动前进');
});

test('LIGHT_PAGES: 原型两个浅色页 + 年度关键词页（#F4EFE4 浅底）', () => {
  assert.deepEqual([...LIGHT_PAGES].sort(), ['panels', 'specialDay', 'yearKeywords']);
  const known = PAGE_TYPES.concat(YEAR_PAGE_TYPES);
  for (const p of LIGHT_PAGES) assert.ok(known.includes(p), p + ' 是合法页型');
});

// ---------------------------------------------------------------------------
// 4) 偏好记忆（静音记忆 = SPEC §4 硬要求）
// ---------------------------------------------------------------------------
test('loadUiPrefs: 无存储/坏 JSON 回默认，不抛错', () => {
  assert.deepEqual(loadUiPrefs(null), { muted: false, autoAdvance: true });
  const bad = memoryStorage({ [STORY_UI_KEY]: '{oops' });
  assert.deepEqual(loadUiPrefs(bad), { muted: false, autoAdvance: true });
  const weird = memoryStorage({ [STORY_UI_KEY]: JSON.stringify({ v: 1, muted: 'yes', autoAdvance: 7, extra: 1 }) });
  const p = loadUiPrefs(weird);
  assert.equal(p.muted, false);
  assert.equal(p.autoAdvance, true, '非布尔字段回默认');
  assert.ok(!('extra' in p), '未知字段丢弃');
});

test('saveUiPrefs → loadUiPrefs 往返一致', () => {
  const s = memoryStorage();
  saveUiPrefs(s, { muted: true, autoAdvance: false });
  assert.deepEqual(loadUiPrefs(s), { muted: true, autoAdvance: false });
});

test('prefersReducedMotion: matchMedia 注入，缺 API 回 false', () => {
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({}), false);
  assert.equal(prefersReducedMotion(null), false);
});

// ---------------------------------------------------------------------------
// 5) 纯渲染：进度条 / 顶栏 chrome / 口径卡
// ---------------------------------------------------------------------------
test('esc: HTML 转义', () => {
  assert.equal(esc('<img src=x>&"\''), '&lt;img src=x&gt;&amp;&quot;&#39;');
});

test('renderProgress: 10 段、done/current/todo、--fill 内联', () => {
  const html = renderProgress(1, 10, 0.45);
  const segs = html.match(/<i[ >]/g) || [];
  assert.equal(segs.length, 10, '10 段');
  assert.ok(/class="d"/.test(html), '已读段');
  assert.ok(/class="c"/.test(html), '当前段');
  assert.ok(html.includes('--fill:45%'), '当前段填充百分比');
  const coverless = renderProgress(0, 10, 0);
  assert.ok(/class="c"/.test(coverless) && !/class="d"/.test(coverless), '第 1 页无已读段');
});

test('renderChrome: 静音/自动前进按钮带 aria-pressed 与读屏名，有 aria-live 区', () => {
  const html = renderChrome({ pageIndex: 1, pageCount: 10, showBars: true, muted: true, autoAdvance: false, label: '十月 · 第 2 页' });
  assert.ok(html.includes('aria-live="polite"'), '读屏实时区');
  assert.ok(/class="mute"[^>]*aria-pressed="true"/.test(html), '静音 pressed 态');
  assert.ok(html.includes('>静音<') === false && html.includes('开启音乐'), '静音中 → 按钮名「开启音乐」');
  assert.ok(html.includes('开启自动前进'), '自动前进关 → 按钮名「开启自动前进」');
  assert.ok(/aria-pressed="false"/.test(html), '自动前进按钮 pressed=false');
  const unmuted = renderChrome({ pageIndex: 1, pageCount: 10, showBars: true, muted: false, autoAdvance: true, label: 'x' });
  assert.ok(unmuted.includes('关闭自动前进'));
});

test('renderMetricCard: 数据源/计算方式/样本数三行 + dialog 语义 + 关闭钮', () => {
  const def = { label: '事项总数', source: '旧账本 entries', method: '期间内 done 事项计数', sample: 86 };
  const html = renderMetricCard(def);
  assert.ok(html.includes('role="dialog"'), 'dialog 语义');
  assert.ok(html.includes('aria-label="口径说明"'));
  assert.ok(html.includes('数据源') && html.includes('旧账本 entries'));
  assert.ok(html.includes('计算方式') && html.includes('done 事项计数'));
  assert.ok(html.includes('样本数') && html.includes('86'));
  assert.ok(html.includes('关闭'));
});

test('metricCardModel: 缺口径 → available:false，不编数字（求真红线）', () => {
  assert.deepEqual(metricCardModel(null), { available: false, rows: [] });
  const model = metricCardModel({ label: 'x', source: 's', method: 'm', sample: 3 });
  assert.equal(model.available, true);
  assert.equal(model.rows.length, 4);
  assert.deepEqual(model.rows.map((r) => r.k), ['指标', '数据源', '计算方式', '样本数']);
});

// ---------------------------------------------------------------------------
// 6) 挂载器：封面仪式 → 翻开（音频手势启动）→ 自动前进 → 翻页音乐连续
// ---------------------------------------------------------------------------
test('createStoryPlayer: 非法 chapter 返回 null', () => {
  const bad = mountPlayer({ chapter: { id: 'x' } });
  assert.equal(bad.api, null);
});

test('封面：不渲染进度条、音频未启动、自动前进不动', () => {
  const { api, o } = mountPlayer();
  const st = api.state();
  assert.equal(st.pageIndex, 0);
  assert.equal(st.opened, false);
  assert.ok(!o.audio.started());
  assert.ok(!api._root.innerHTML.includes('class="bars"'), '封面无进度条（原型 p0）');
  o.clock.advance(30000);
  assert.equal(api.state().pageIndex, 0, '未翻开不前进');
  assert.equal(o.audio.calls.start.length, 0);
});

test('「翻开」（data-st-open）后：音频在同一手势启动、开始计时', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  const st = api.state();
  assert.equal(st.opened, true);
  assert.equal(o.audio.calls.start.length, 1, '音频随翻开手势启动（自动播放限制）');
  const input = o.audio.calls.start[0].input;
  const expected = songInputFor(validateChapter(fixtureChapter()));
  assert.deepEqual(input, expected, 'start 输入 = contracts.songInputFor(chapter)');
  assert.equal(o.audio.calls.setSegment.length, 0, '起点即第 0 段，无需 setSegment');
});

test('自动前进：dwell 到点翻页、进度段点亮、音频 setSegment 跟随、不重启', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  o.clock.advance(AUTO_DWELL_MS);
  assert.equal(api.state().pageIndex, 1, '7000ms 后翻到第 2 页');
  assert.deepEqual(o.audio.calls.setSegment, [1], '翻页只 setSegment（音乐连续，SPEC §4）');
  assert.equal(o.audio.calls.start.length, 1, '不重启音频');
  o.clock.advance(AUTO_DWELL_MS);
  assert.equal(api.state().pageIndex, 2);
  assert.deepEqual(o.audio.calls.setSegment, [1, 2]);
  const fill = api._fillSeg.style['--fill'];
  assert.ok(fill === '0%' || fill === undefined || parseFloat(fill) < 5, '新页填充从 0 重新开始');
});

test('末页（海报）不再前进，setSegment 停在最后一段（outro）', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  for (let i = 0; i < 12; i += 1) o.clock.advance(AUTO_DWELL_MS);
  assert.equal(api.state().pageIndex, 9, '停在第 10 页（海报）');
  o.clock.advance(AUTO_DWELL_MS * 2);
  assert.equal(api.state().pageIndex, 9);
  assert.equal(o.audio.calls.setSegment[o.audio.calls.setSegment.length - 1], 9);
});

test('轻点：右半下一页、左半上一页、首页不回退；交互元素不触发翻页', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  gestureTap(api, o, 330);
  assert.equal(api.state().pageIndex, 1);
  gestureTap(api, o, 30);
  assert.equal(api.state().pageIndex, 0, '左半上一页');
  gestureTap(api, o, 30);
  assert.equal(api.state().pageIndex, 0, '封面之上不再回退');
  gestureTap(api, o, 330);
  const btn = el('button', { class: 'open' });
  fire(api._stage, 'click', { target: btn, clientX: 330, preventDefault() {}, stopPropagation() {} });
  assert.equal(api.state().pageIndex, 1, '点按钮不翻页');
});

test('长按：切换暂停；暂停时不前进；读屏播报已暂停/已继续', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  o.clock.advance(AUTO_DWELL_MS); // → 第 2 页
  gestureLongPress(api, o);
  assert.equal(api.state().paused, true);
  assert.ok(api._live.textContent.includes('已暂停'), '读屏播报已暂停');
  o.clock.advance(AUTO_DWELL_MS * 2);
  assert.equal(api.state().pageIndex, 1, '暂停期间不自动前进');
  assert.equal(o.audio.calls.start.length, 1, '长按暂停不碰音频（SPEC §4 音乐连续）');
  gestureLongPress(api, o);
  assert.equal(api.state().paused, false);
  assert.ok(api._live.textContent.includes('已继续'));
});

test('轻点（短按）不算长按：60ms 点按直接翻页', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  gestureTap(api, o, 330);
  assert.equal(api.state().pageIndex, 1);
  assert.equal(api.state().paused, false, '短按不触发暂停');
});

test('移动超过 slop 的滑动不算点按（滚动页内容不翻页）', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  const stage = api._stage;
  fire(stage, 'pointerdown', pointerEvent('pointerdown', stage, { clientX: 300 }));
  o.clock.advance(30);
  fire(stage, 'pointermove', pointerEvent('pointermove', stage, { clientX: 300 - TAP_SLOP_PX - 5 }));
  o.clock.advance(100);
  fire(stage, 'pointerup', pointerEvent('pointerup', stage, { clientX: 300 - TAP_SLOP_PX - 5 }));
  assert.equal(api.state().pageIndex, 0, '滑动取消点按');
});

test('键盘：← → 空格；输入框聚焦时不劫持按键', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  const keydown = (target, key) => fire(o.doc, 'keydown', { key, target: target || o.doc.body });
  keydown(null, 'ArrowRight');
  assert.equal(api.state().pageIndex, 1);
  keydown(null, 'ArrowLeft');
  assert.equal(api.state().pageIndex, 0);
  keydown(null, 'ArrowRight');
  keydown(null, ' ');
  assert.equal(api.state().paused, true, '空格 = 暂停/继续');
  keydown(null, ' ');
  assert.equal(api.state().paused, false);
  const input = el('input');
  const before = api.state().paused;
  keydown(input, ' ');
  assert.equal(api.state().paused, before, 'input 聚焦元素的按键不处理');
  assert.equal(api.state().pageIndex, 1, 'input 上的方向键不翻页');
});

test('口径卡：长按 [data-metric] 弹卡（不触发暂停），Esc/点空白关闭', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  o.clock.advance(AUTO_DWELL_MS); // 第 2 页（numbers）
  const metricEl = el('span', { 'data-metric': 'totals.events' });
  gestureLongPress(api, o, metricEl);
  assert.equal(api.state().paused, false, '口径卡优先于长按暂停');
  const card = api._metricCard;
  assert.ok(card.innerHTML.includes('事项总数'), '弹出指标名');
  assert.ok(card.innerHTML.includes('数据源') && card.innerHTML.includes('86'), '口径三要素');
  fire(o.doc, 'keydown', { key: 'Escape', target: o.doc.body });
  assert.equal(api.state().metricKey, null, 'Esc 关闭口径卡');
  // 无口径的指标：卡片不编数字
  const unknown = el('span', { 'data-metric': 'nope' });
  gestureLongPress(api, o, unknown);
  assert.ok(api._metricCard.innerHTML.includes('暂无口径说明'), '缺口径降级文案，不伪造');
});

test('静音记忆：切换写存储并同步音频；重挂载读回并应用', () => {
  const storage = memoryStorage();
  const a = mountPlayer({ storage });
  openCover(a.api, a.o);
  a.api.setMuted(true);
  assert.deepEqual(a.o.audio.calls.setMuted.slice(-1), [true]);
  assert.equal(loadUiPrefs(storage).muted, true, '静音写入存储');
  assert.equal(a.api.state().muted, true);
  const b = mountPlayer({ storage });
  openCover(b.api, b.o);
  assert.equal(b.api.state().muted, true, '重挂载读回静音偏好');
  assert.ok(b.o.audio.calls.setMuted.includes(true), '偏好应用到音频');
});

test('自动前进开关：关闭后不前进且写存储', () => {
  const storage = memoryStorage();
  const { api, o } = mountPlayer({ storage });
  openCover(api, o);
  api.setAutoAdvance(false);
  assert.equal(loadUiPrefs(storage).autoAdvance, false);
  o.clock.advance(AUTO_DWELL_MS * 3);
  assert.equal(api.state().pageIndex, 0, '关闭自动前进后不动');
  api.setAutoAdvance(true);
  o.clock.advance(AUTO_DWELL_MS);
  assert.equal(api.state().pageIndex, 1, '重新开启后恢复');
});

test('输入聚焦（心愿页输入框）：暂停自动前进，失焦恢复', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  const input = el('input');
  fire(api._stage, 'focusin', { target: input });
  assert.equal(api.state().interactive, true);
  o.clock.advance(AUTO_DWELL_MS * 2);
  assert.equal(api.state().pageIndex, 0, '输入期间不前进');
  fire(api._stage, 'focusout', { target: input });
  o.clock.advance(AUTO_DWELL_MS);
  assert.equal(api.state().pageIndex, 1, '失焦后恢复前进');
});

test('prefers-reduced-motion: 根节点标记 data-reduced-motion，音频不受影响', () => {
  const { api, o } = mountPlayer({ win: fakeWin({ matchMedia: (q) => ({ matches: q.includes('reduce') }) }) });
  assert.equal(api.state().reducedMotion, true);
  assert.equal(api._root.getAttribute('data-reduced-motion'), '1');
  openCover(api, o);
  assert.equal(o.audio.calls.start.length, 1, 'reduced-motion 不影响音乐（SPEC §4）');
});

test('goTo/destroy：跳页 setSegment、destroy 清计时器并停音频', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  api.goTo(4);
  assert.equal(api.state().pageIndex, 4);
  assert.deepEqual(o.audio.calls.setSegment.slice(-1), [4]);
  api.destroy();
  assert.equal(o.audio.calls.stop, 1, 'destroy 停音频');
  assert.equal(o.clock._timers.size, 0, '计时器清空');
  const before = api.state().pageIndex;
  fire(o.doc, 'keydown', { key: 'ArrowRight', target: o.doc.body });
  assert.equal(api.state().pageIndex, before, 'destroy 后键盘解绑');
});

test('renderPage 缺省：无渲染器时回退占位（页型名），不崩', () => {
  const { api } = mountPlayer({ renderPage: undefined });
  assert.ok(api._stage.innerHTML.includes('封面'), '回退占位含页型读屏名');
});

test('页根 data-page-type/data-page-theme 随翻页更新（浅色页标记）', () => {
  const { api, o } = mountPlayer();
  assert.equal(api._root.getAttribute('data-page-type'), 'cover');
  openCover(api, o);
  api.goTo(3);
  assert.equal(api._root.getAttribute('data-page-type'), 'specialDay');
  assert.equal(api._root.getAttribute('data-page-theme'), 'light', 'specialDay 浅色页');
  api.goTo(7);
  assert.equal(api._root.getAttribute('data-page-theme'), 'light', 'panels 浅色页');
  api.goTo(2);
  assert.notEqual(api._root.getAttribute('data-page-theme'), 'light');
});

test('回到封面重新盖上进度条（原型 p0 无 .bars）', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  api.goTo(2);
  assert.notEqual(api._root.querySelector, undefined);
  assert.equal(api._bars.getAttribute('hidden'), null, '内容页进度条可见');
  api.goTo(0);
  assert.equal(api._bars.getAttribute('hidden'), '', '回到封面隐藏进度条');
});

test('口径卡打开时：翻页/点按/方向键先关卡，不穿透导航', () => {
  const { api, o } = mountPlayer();
  openCover(api, o);
  o.clock.advance(AUTO_DWELL_MS); // 第 2 页
  const metricEl = el('span', { 'data-metric': 'totals.events' });
  gestureLongPress(api, o, metricEl);
  assert.ok(api.state().metricKey, '卡已开');
  // 点按空白：只关卡，不翻页
  gestureTap(api, o, 330);
  assert.equal(api.state().metricKey, null, '点按关闭口径卡');
  assert.equal(api.state().pageIndex, 1, '关卡的点按不翻页');
  // 再开一次：翻页也把关掉的卡带走
  gestureLongPress(api, o, metricEl);
  assert.ok(api.state().metricKey);
  api.goTo(2);
  assert.equal(api.state().metricKey, null, '翻页关闭口径卡（不跨页存留）');
  // 键盘同理：卡开时方向键只关卡
  gestureLongPress(api, o, metricEl);
  fire(o.doc, 'keydown', { key: 'ArrowRight', target: o.doc.body });
  assert.equal(api.state().metricKey, null, '方向键关闭口径卡');
  assert.equal(api.state().pageIndex, 2, '该次方向键不翻页');
});

// ---------------------------------------------------------------------------
// 7) story.css — token 对齐 relay-v2 §3 + 进度条/桌面卡片/降级
// ---------------------------------------------------------------------------
const cssPath = fileURLToPath(new URL('../../web/story/story.css', import.meta.url));
const cssText = readFileSync(cssPath, 'utf8');

function cssBlock(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}');
  const m = re.exec(cssText);
  return m ? m[1] : null;
}

function cssHas(needle) { return cssText.includes(needle); }

test('story.css: .st-play 基础块对齐 relay-v2 §3 同名 token 同值', () => {
  const base = cssBlock('.st-play');
  assert.ok(base, '.st-play 基础 token 块存在');
  const expects = [
    '--brand:#E95432', '--gold:#E8B04B', '--r-lg:20px', '--r-md:14px', '--r-sm:10px',
    '--tap:48px', '--t-hero:28px', '--t-h2:20px', '--t-body:16px', '--t-sm:14px', '--t-xs:12px',
    '--shadow:0 1px 2px rgba(37,39,34,.05),0 8px 24px rgba(37,39,34,.06)',
    '--k-nec:#7C8A99', '--k-create:#E8B04B', '--k-connect:#E9826A', '--k-explore:#6E8FD6',
    '--k-restore:#5FA67F', '--k-still:#B9A8D8',
  ];
  for (const e of expects) assert.ok(base.includes(e), 'token ' + e);
});

test('story.css: 作用域 —— 非 @media/@keyframes 规则选择器都在 .st-play 之下', () => {
  const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  let cleaned = '';
  let i = 0;
  while (i < noComments.length) {
    const k = noComments.indexOf('@keyframes', i);
    if (k === -1) { cleaned += noComments.slice(i); break; }
    cleaned += noComments.slice(i, k);
    let depth = 0;
    let j = noComments.indexOf('{', k);
    for (; j < noComments.length; j += 1) {
      if (noComments[j] === '{') depth += 1;
      else if (noComments[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    i = j + 1;
  }
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(cleaned))) {
    for (const raw of m[1].split(',')) {
      const sel = raw.trim();
      if (!sel || sel.startsWith('@')) continue;
      assert.ok(sel.startsWith('.st-play') || sel === 'to' || sel === 'from' || /^[0-9.]+%$/.test(sel),
        '选择器在 .st-play 作用域内: ' + sel);
    }
  }
});

test('story.css: 进度条 = 原型 .bars（10 段、3px、4px 间隙、--fill 驱动当前段）', () => {
  assert.ok(cssHas('.st-play .bars'));
  assert.ok(cssHas('.st-play .bars i.c::after'), '当前段填充伪元素');
  assert.ok(cssHas('var(--fill'), '填充由 --fill 变量驱动');
  const barBody = cssBlock('.st-play .bars');
  assert.ok(barBody.includes('gap:4px'));
  assert.ok(/height:3px/.test(cssText), '段高 3px');
  assert.ok(cssHas('.st-play[data-page-theme=light] .bars i'), '浅色页进度条配色切换');
});

test('story.css: 桌面 ≥900px 居中 390 卡片 + 背景模糊（SPEC §8）', () => {
  const at = cssText.indexOf('@media (min-width:900px)');
  assert.ok(at >= 0, '桌面断点存在');
  const desk = cssText.slice(at, cssText.indexOf('}', cssText.indexOf('}', cssText.indexOf('}', at) + 1) + 1));
  assert.ok(/width:390px/.test(cssText), '卡片宽 390');
  assert.ok(/filter:blur/.test(cssText), '背景模糊');
  assert.ok(cssHas('.st-backdrop'), '背景层存在');
  assert.ok(/border-radius:36px/.test(cssText), '卡片圆角 36（原型 .pg）');
});

test('story.css: prefers-reduced-motion 降级（动效停、页面直达）', () => {
  assert.ok(cssText.includes('@media (prefers-reduced-motion: reduce)'), '系统降级查询');
  assert.ok(cssHas('[data-reduced-motion]'), 'JS 标记降级选择器');
  assert.ok(/animation:none/.test(cssText) || /animation-duration:0/.test(cssText), '动画关闭');
});

test('story.css: 每页背景 = 原型 p0–p9 渐变逐页落 data-page-type', () => {
  const bgs = [
    ['cover', '#2C3E35'], ['numbers', '#3A5A8C'], ['timeColors', '#18171D'],
    ['specialDay', '#F6C9A0'], ['lessons', '#5A3E1E'], ['savedTime', '#14303A'],
    ['rhythm', '#0F1424'], ['panels', '#F4EFE4'], ['wish', '#22313A'], ['poster', '#E9826A'],
  ];
  for (const [type, color] of bgs) {
    const block = cssBlock('.st-play[data-page-type=' + type + ']');
    assert.ok(block, type + ' 背景块');
    assert.ok(block.includes(color), type + ' 原型色 ' + color);
  }
  assert.ok(cssHas('.st-play[data-page-theme=light]'), '浅色页文字/部件主题块');
});

test('story.css: 最小点击区 —— 30px 视觉圆钮外扩到 48px 命中区（relay --tap）', () => {
  assert.ok(/inset:-9px/.test(cssText), '命中区外扩 9px（30+9×2=48）');
});

test('红线: player.js 与 story.css 不出现「留白」字样', () => {
  const js = readFileSync(fileURLToPath(new URL('../../web/story/player.js', import.meta.url)), 'utf8');
  assert.ok(!js.includes('留白'));
  assert.ok(!cssText.includes('留白'));
});
