import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// RV2 L2开始页 line: web/relay/home.js renders SPEC §4① `#/start`.
// Visual contract source: design/relay-v2/prototype.html section #s-home
// (markup classes hello/h1/lead/ask/mic/btn pri/seg/grid/scene c1-c3/sec/
// badges/badge/empty must be emitted with these exact names) and shots
// m-home.png / d-home.png. Data shapes come from web/relay/contracts.js
// (PERSONAS, EVENT_MAX) — never redefined here.

import { PERSONAS, EVENT_MAX, validateUsage } from '../../web/relay/contracts.js';
import {
  RELAY_PERSONA_KEY, DEFAULT_PERSONA, PERSONA_LABELS,
  greetingFor, normalizePersona, loadPersona, savePersona,
  featuredScenes, sceneIcon, sceneClass, learnedBadges,
  speechAvailable, homeView, createHome,
} from '../../web/relay/home.js';

// ---------------------------------------------------------------------------
// Fixtures — every usage passes the contracts schema (validateUsage) so the
// fixtures prove home.js consumes real contract output, not a private shape.
// ---------------------------------------------------------------------------
function mkUsage(over = {}) {
  const base = {
    id: 'meeting-notes', title: '整理会议纪要', category: '整理',
    does: ['列出重点', '拆出待办和负责人', '标出没说清的地方'],
    materialLabel: '把会议内容给我', materialHint: '把聊天记录、笔记或转写文字粘贴到这里……',
    learned: '把会议材料交给 AI，先要「重点、待办、没说清的地方」。',
    externalPrompt: '请把下面的会议内容整理成三部分。会议内容：{{material}}',
    keywords: ['会议'],
    personas: { student: { featured: true } },
    ...over,
  };
  const validated = validateUsage(base);
  assert.ok(validated, 'fixture usage must satisfy contracts validateUsage');
  return validated;
}

const SCENES = [
  mkUsage({ id: 'meeting-notes', personas: { student: { featured: true, title: '整理组会纪要', hint: '重点、待办、待补充' }, worker: { featured: true } } }),
  mkUsage({ id: 'paper-read', title: '读懂一篇论文', category: '读', does: ['先给要点', '标出疑问'], personas: { student: { featured: true } } }),
  mkUsage({ id: 'advisor-mail', title: '给导师写邮件', category: '写', personas: { student: { featured: true } } }),
  mkUsage({ id: 'abstract-en', title: '摘要翻成英文', category: '翻译', personas: { student: { featured: true } } }),
  mkUsage({ id: 'homework-plan', title: '拆解作业计划', category: '计划', personas: { student: { featured: true } } }),
  mkUsage({ id: 'resume-edit', title: '改一版简历', category: '写', personas: { student: { featured: true } } }),
  mkUsage({ id: 'weekend-trip', title: '周末出行安排', category: '生活', personas: { student: { featured: true } } }),
  mkUsage({ id: 'report-comments', title: '写期末评语', category: '写', personas: { teacher: { featured: true } } }),
  mkUsage({ id: 'elder-wechat', title: '微信语音转文字', category: '生活', personas: { elder: { featured: true } } }),
];

function rec(usageId, at) {
  return { id: '00000000-0000-4000-8000-00000000000' + (REC_SEQ += 1), at, event: 'e' + REC_SEQ, usageId, result: '', rating: null, graduated: false, graduatedApp: null, failed: null };
}
let REC_SEQ = 0;

const RECORDS = [
  rec('meeting-notes', '2026-10-20T08:00:00.000Z'),
  rec('paper-read', '2026-10-22T08:00:00.000Z'),
  rec('advisor-mail', '2026-10-23T08:00:00.000Z'),
  rec('meeting-notes', '2026-10-24T08:00:00.000Z'),
  rec(null, '2026-10-24T09:00:00.000Z'),
  rec('ghost-id', '2026-10-24T10:00:00.000Z'),
];

function mapStorage(initial = new Map()) {
  return {
    map: initial,
    getItem: (k) => (initial.has(k) ? initial.get(k) : null),
    setItem: (k, v) => { initial.set(k, String(v)); },
  };
}

function viewState(over = {}) {
  return {
    greeting: '周六下午好', event: '', persona: 'student',
    scenes: featuredScenes(SCENES, 'student'), badges: learnedBadges(RECORDS, SCENES),
    mic: true, micBusy: false, micNote: '',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------
test('greeting follows the prototype format 周X时段好 across the day and week', () => {
  assert.equal(greetingFor(new Date(2026, 9, 24, 15)), '周六下午好'); // prototype shot wording
  assert.equal(greetingFor(new Date(2026, 9, 24, 3)), '周六凌晨好');
  assert.equal(greetingFor(new Date(2026, 9, 24, 7)), '周六早上好');
  assert.equal(greetingFor(new Date(2026, 9, 24, 10)), '周六上午好');
  assert.equal(greetingFor(new Date(2026, 9, 24, 12)), '周六中午好');
  assert.equal(greetingFor(new Date(2026, 9, 24, 20)), '周六晚上好');
  assert.equal(greetingFor(new Date(2026, 9, 25, 15)), '周日下午好');
});

test('persona enum, labels and default come from the contracts PERSONAS order', () => {
  assert.equal(DEFAULT_PERSONA, 'student'); // SPEC §4① 首次默认"学生"
  assert.deepEqual(Object.keys(PERSONA_LABELS), PERSONAS);
  assert.equal(PERSONA_LABELS.worker, '上班族');
  assert.equal(PERSONA_LABELS.elder, '长辈');
});

test('normalizePersona accepts only contracts personas', () => {
  assert.equal(normalizePersona('teacher'), 'teacher');
  assert.equal(normalizePersona(' Teacher '), 'teacher');
  assert.equal(normalizePersona('hacker'), null);
  assert.equal(normalizePersona(null), null);
  assert.equal(normalizePersona(42), null);
});

test('persona is remembered per device and garbage falls back to 学生', () => {
  const storage = mapStorage();
  assert.equal(loadPersona(storage), 'student'); // first visit default
  assert.equal(savePersona(storage, 'elder'), true);
  assert.equal(storage.map.get(RELAY_PERSONA_KEY), 'elder');
  assert.equal(loadPersona(storage), 'elder'); // 记住选择
  const dirty = mapStorage(new Map([[RELAY_PERSONA_KEY, 'nope']]));
  assert.equal(loadPersona(dirty), 'student');
  assert.equal(savePersona(storage, 'bad'), false); // never persist junk
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadPersona(broken), 'student');
  assert.equal(savePersona(broken, 'teacher'), false);
});

test('featuredScenes returns the current persona featured usages, capped at 6, with persona title/hint override', () => {
  const student = featuredScenes(SCENES, 'student');
  assert.equal(student.length, 6); // 7 featured → SPEC §4① 场景卡 6 张
  assert.deepEqual(student.map((s) => s.usageId), ['meeting-notes', 'paper-read', 'advisor-mail', 'abstract-en', 'homework-plan', 'resume-edit']);
  assert.equal(student[0].title, '整理组会纪要'); // persona.title wins
  assert.equal(student[0].hint, '重点、待办、待补充'); // persona.hint wins
  assert.equal(student[1].title, '读懂一篇论文'); // falls back to usage.title
  assert.equal(student[1].hint, '先给要点、标出疑问'); // falls back to does joined
  const teacher = featuredScenes(SCENES, 'teacher');
  assert.deepEqual(teacher.map((s) => s.usageId), ['report-comments']);
  assert.equal(teacher[0].title, '写期末评语');
  const worker = featuredScenes(SCENES, 'worker');
  assert.deepEqual(worker.map((s) => s.usageId), ['meeting-notes']);
  assert.equal(worker[0].title, '整理会议纪要'); // featured without persona overrides
  const elder = featuredScenes(SCENES, 'elder');
  assert.deepEqual(elder.map((s) => s.usageId), ['elder-wechat']);
  assert.deepEqual(featuredScenes([], 'student'), []);
});

test('scene card icon follows category plus the 邮件 refinement, color class cycles c1-c3', () => {
  assert.equal(sceneIcon('读'), '#i-doc');
  assert.equal(sceneIcon('整理'), '#i-notes');
  assert.equal(sceneIcon('计划'), '#i-list');
  assert.equal(sceneIcon('翻译'), '#i-globe');
  assert.equal(sceneIcon('生活'), '#i-cal');
  assert.equal(sceneIcon('写', '改一版简历'), '#i-pen');
  assert.equal(sceneIcon('写', '给导师写邮件'), '#i-mail'); // prototype home uses the envelope
  assert.equal(sceneClass(0), 'c1');
  assert.equal(sceneClass(2), 'c3');
  assert.equal(sceneClass(3), 'c1');
  assert.equal(sceneClass(5), 'c3');
});

test('learnedBadges keeps at most 3 distinct usages by latest record, skipping null and unknown usageIds', () => {
  const badges = learnedBadges(RECORDS, SCENES);
  assert.deepEqual(badges, [
    { usageId: 'meeting-notes', title: '整理会议纪要' },
    { usageId: 'advisor-mail', title: '给导师写邮件' },
    { usageId: 'paper-read', title: '读懂一篇论文' },
  ]);
  assert.deepEqual(learnedBadges([], SCENES), []);
  assert.deepEqual(learnedBadges(RECORDS, []), []); // nothing nameable without the library
});

test('speechAvailable requires TangoSpeech plus getUserMedia and AudioContext', () => {
  const mic = { getUserMedia() {} };
  const AC = function AudioContext() {};
  assert.equal(speechAvailable({ TangoSpeech: { createRecorder() {} }, navigator: { mediaDevices: mic }, AudioContext: AC }), true);
  assert.equal(speechAvailable({ navigator: { mediaDevices: mic }, AudioContext: AC }), false); // no speech-capture
  assert.equal(speechAvailable({ TangoSpeech: { createRecorder() {} }, AudioContext: AC }), false); // no mediaDevices
  assert.equal(speechAvailable({ TangoSpeech: { createRecorder() {} }, navigator: { mediaDevices: mic } }), false); // no AudioContext
  assert.equal(speechAvailable(undefined), false);
});

// ---------------------------------------------------------------------------
// homeView — the pure render must match prototype #s-home markup and copy.
// ---------------------------------------------------------------------------
test('homeView renders the exact prototype copy, placeholder and caps', () => {
  const view = homeView(viewState());
  assert.match(view, /<p class="hello">周六下午好<\/p>/);
  assert.match(view, /<h1>今天要做什么？<\/h1>/);
  assert.match(view, /<p class="lead">说一件手头的事，探戈帮你交给合适的 AI。<\/p>/);
  assert.match(view, /placeholder="说一件今天要做的事"/);
  assert.equal(view.includes(`maxlength="${EVENT_MAX}"`), true); // 事件原话 cap from contracts
  assert.match(view, /role="tablist" aria-label="我是"/);
  assert.match(view, /aria-selected="true" class="on" data-persona="student"/);
  assert.match(view, /data-persona="teacher">老师</);
  assert.match(view, /data-persona="elder">长辈</);
  assert.match(view, /<h3>我学会的用法<\/h3>/);
  assert.match(view, /href="#\/me" data-relay-all>全部</);
  assert.match(view, /aria-label="语音输入"/);
  assert.match(view, /id="relay-home-go" disabled/); // 空输入置灰
});

test('homeView enables 开始 and echoes the typed event once text exists', () => {
  const view = homeView(viewState({ event: '整理今天的组会记录' }));
  assert.doesNotMatch(view, /id="relay-home-go" disabled/);
  assert.match(view, /整理今天的组会记录/);
});

test('homeView renders exactly 6 scene cards with prototype classes, icons and escaping', () => {
  const view = homeView(viewState());
  assert.equal((view.match(/class="scene c[123]"/g) || []).length, 6);
  assert.match(view, /data-scene="meeting-notes" data-event="整理组会纪要"/);
  assert.match(view, /<b>整理组会纪要<\/b><span>重点、待办、待补充<\/span>/);
  assert.match(view, /<use href="#i-notes"\/>/); // 整理 → notes (prototype 组会纪要 card)
  assert.match(view, /<use href="#i-doc"\/>/);   // 读 → doc (prototype 论文 card)
  assert.match(view, /<use href="#i-mail"\/>/);  // 写+邮件 → mail (prototype 导师邮件 card)
  assert.match(view, /<use href="#i-globe"\/>/); // 翻译 → globe
  assert.match(view, /<use href="#i-list"\/>/);  // 计划 → list
  assert.match(view, /<use href="#i-pen"\/>/);   // 写(简历) → pen
});

test('homeView escapes dynamic titles and events (XSS never re-enters as markup)', () => {
  const evil = mkUsage({ id: 'evil-card', title: 'A<b>"&\'z', category: '读', personas: { student: { featured: true } } });
  const view = homeView(viewState({ event: '<img src=x onerror=alert(1)>', scenes: featuredScenes([evil], 'student'), badges: [{ usageId: 'evil-card', title: 'A<b>"&\'z' }] }));
  assert.equal(view.includes('<b>A<b>'), false);
  assert.match(view, /A&lt;b&gt;&quot;&amp;&#39;z/);
  assert.equal(view.includes('<img src=x'), false);
  assert.match(view, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('homeView shows badge pills for learned usages and the exact empty copy otherwise', () => {
  const withBadges = homeView(viewState({ badges: [{ usageId: 'meeting-notes', title: '整理会议纪要' }] }));
  assert.match(withBadges, /<span class="badge"><i><svg><use href="#i-check"\/><\/svg><\/i>整理会议纪要<\/span>/);
  const empty = homeView(viewState({ badges: [] }));
  assert.match(empty, /<p class="empty">完成第一次接力，这里会出现你学会的第一个用法<\/p>/);
});

test('homeView hides the mic when speech-capture is unavailable and lets copy be overridden', () => {
  const noMic = homeView(viewState({ mic: false }));
  assert.equal(noMic.includes('id="relay-home-mic"'), false);
  const en = homeView(viewState({ mic: false, badges: [] }), { hero: 'What needs doing today?', emptyText: 'first' });
  assert.match(en, /<h1>What needs doing today\?<\/h1>/);
  assert.match(en, /<p class="empty">first<\/p>/);
});

// ---------------------------------------------------------------------------
// Controller — mount wiring on a minimal element stub (event delegation only).
// ---------------------------------------------------------------------------
function makeEl() {
  const el = {
    handlers: {}, html: '', nodes: {},
    addEventListener(type, handler) { (el.handlers[type] ||= []).push(handler); },
    set innerHTML(v) { el.html = v; },
    get innerHTML() { return el.html; },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      if (!m) return null;
      if (!el.nodes[m[1]]) el.nodes[m[1]] = { id: m[1], value: '', disabled: false, style: {}, focus() {} };
      return el.nodes[m[1]];
    },
    contains() { return true; },
  };
  return el;
}
function fire(el, type, target, extra = {}) {
  const event = { type, target, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...extra };
  for (const handler of el.handlers[type] || []) handler(event);
  return event;
}
function node(attrs, id) {
  const self = { id: id || '', getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null), closest: () => self };
  return self;
}

function fakeRoot(over = {}) {
  return {
    location: { hash: '' },
    matchMedia: () => ({ matches: false }),
    fetch: async () => { throw new Error('unexpected fetch'); },
    ...over,
  };
}

test('controller: typing then submitting emits start_submit and onSubmit with the trimmed event', () => {
  const el = makeEl();
  const calls = { metric: [], submit: [] };
  const home = createHome({ root: fakeRoot(), storage: mapStorage(), usages: SCENES, records: RECORDS, onMetric: (n) => calls.metric.push(n), onSubmit: (v) => calls.submit.push(v), greeting: '周六下午好' });
  home.mount(el);
  assert.match(el.html, /周六下午好/);

  fire(el, 'submit', el.querySelector('#relay-home-ask')); // empty submit → nothing sent
  assert.deepEqual(calls, { metric: [], submit: [] });

  el.querySelector('#relay-home-input').value = '  整理今天的组会记录 ';
  fire(el, 'input', { id: 'relay-home-input', value: '  整理今天的组会记录 ', style: {} });
  assert.equal(el.querySelector('#relay-home-go').disabled, false);
  fire(el, 'submit', el.querySelector('#relay-home-ask'));
  assert.deepEqual(calls.metric, ['start_submit']);
  assert.deepEqual(calls.submit, ['整理今天的组会记录']);

  home.unmount();
});

test('controller: Enter submits from the textarea, other keys do not', () => {
  const el = makeEl();
  const submit = [];
  createHome({ root: fakeRoot(), storage: mapStorage(), usages: [], records: [], onSubmit: (v) => submit.push(v) }).mount(el);
  el.querySelector('#relay-home-input').value = '写周报';
  const enter = fire(el, 'keydown', { id: 'relay-home-input', style: {} }, { key: 'Enter', shiftKey: false });
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(submit, ['写周报']);
  fire(el, 'keydown', { id: 'relay-home-input', style: {} }, { key: 'a' });
  fire(el, 'keydown', { id: 'relay-home-input', style: {} }, { key: 'Enter', shiftKey: true }); // shift-enter is not submit
  assert.deepEqual(submit, ['写周报']);
});

test('controller: persona switch persists, re-renders that persona cards and keeps the typed event', () => {
  const storage = mapStorage();
  const el = makeEl();
  const home = createHome({ root: fakeRoot(), storage, usages: SCENES, records: [], greeting: '周六下午好' });
  home.mount(el);
  assert.match(el.html, /整理组会纪要/); // student cards

  el.querySelector('#relay-home-input').value = '给全班写评语';
  fire(el, 'input', { id: 'relay-home-input', value: '给全班写评语', style: {} });
  fire(el, 'click', node({ 'data-persona': 'teacher' }));
  assert.equal(storage.map.get(RELAY_PERSONA_KEY), 'teacher'); // 记住选择
  assert.match(el.html, /写期末评语/); // teacher featured card now present
  assert.doesNotMatch(el.html, /整理组会纪要/);
  assert.match(el.html, /给全班写评语/); // typed event survives the re-render
  assert.equal(home.persona(), 'teacher');
  fire(el, 'click', node({ 'data-persona': 'teacher' })); // same persona is a no-op

  const reloaded = createHome({ root: fakeRoot(), storage, usages: SCENES, records: [] });
  const el2 = makeEl();
  reloaded.mount(el2);
  assert.match(el2.html, /aria-selected="true" class="on" data-persona="teacher"/); // remembered
});

test('controller: scene click emits scene_click and the prefill handoff {usageId, event}', () => {
  const el = makeEl();
  const calls = { metric: [], scene: [] };
  createHome({ root: fakeRoot(), storage: mapStorage(), usages: SCENES, records: [], onMetric: (n) => calls.metric.push(n), onScene: (h) => calls.scene.push(h) }).mount(el);
  fire(el, 'click', node({ 'data-scene': 'meeting-notes', 'data-event': '整理组会纪要' }));
  assert.deepEqual(calls.metric, ['scene_click']);
  assert.deepEqual(calls.scene, [{ usageId: 'meeting-notes', event: '整理组会纪要' }]);
});

test('controller: without onScene/onSubmit/onOpenMe the defaults navigate the #/relay and #/me hashes', () => {
  const root = fakeRoot();
  const el = makeEl();
  createHome({ root, storage: mapStorage(), usages: SCENES, records: [] }).mount(el);
  fire(el, 'click', node({ 'data-scene': 'paper-read', 'data-event': '读懂一篇论文' }));
  assert.equal(root.location.hash, '#/relay?usage=paper-read&event=' + encodeURIComponent('读懂一篇论文'));
  el.querySelector('#relay-home-input').value = '整理会议记录';
  fire(el, 'submit', el.querySelector('#relay-home-ask'));
  assert.equal(root.location.hash, '#/relay?event=' + encodeURIComponent('整理会议记录'));
  const all = fire(el, 'click', node({ 'data-relay-all': '' }));
  assert.equal(all.defaultPrevented, true);
  assert.equal(root.location.hash, '#/me');
});

test('controller: update() refreshes records/usages and flips badges ↔ empty state', async () => {
  const el = makeEl();
  const home = createHome({ root: fakeRoot(), storage: mapStorage(), usages: [], records: [], greeting: '周六下午好' });
  home.mount(el);
  assert.match(el.html, /完成第一次接力，这里会出现你学会的第一个用法/);
  assert.doesNotMatch(el.html, /class="scene c/); // no library yet → no cards
  home.update({ usages: SCENES, records: RECORDS });
  assert.equal((el.html.match(/class="scene c[123]"/g) || []).length, 6);
  assert.match(el.html, /<span class="badge">/);
  assert.match(el.html, /整理会议纪要<\/span>/);
});

test('controller: mic records via speech-capture, transcribes through /api/speech and appends to the event', async () => {
  const el = makeEl();
  let onFinish = null; let onReady = null;
  const recorder = {
    start() { if (onReady) onReady(); if (onFinish) onFinish(new Uint8Array(120)); return Promise.resolve(); },
    stop() {}, cancel() {},
  };
  const root = fakeRoot({
    TangoSpeech: {
      createRecorder(f, r) { onFinish = f; onReady = r; return recorder; },
      normalizeTranscript: (t) => String(t).trim(),
    },
    navigator: { mediaDevices: { getUserMedia() {} } },
    AudioContext: function AudioContext() {},
    fetch: async (url) => {
      if (url === '/api/speech') return { ok: true, json: async () => ({ available: true, languages: ['zh-CN'] }) };
      if (url.startsWith('/api/speech/transcribe')) return { ok: true, json: async () => ({ text: ' 帮我整理会议记录 ' }) };
      throw new Error('unexpected ' + url);
    },
  });
  createHome({ root, storage: mapStorage(), usages: [], records: [] }).mount(el);
  el.querySelector('#relay-home-input').value = '今天开组会';
  fire(el, 'input', { id: 'relay-home-input', value: '今天开组会', style: {} });
  fire(el, 'click', node({}, 'relay-home-mic'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(el.querySelector('#relay-home-input').value, '今天开组会，帮我整理会议记录'); // appended, joined with ，
  assert.equal(el.querySelector('#relay-home-go').disabled, false);
});

test('controller: mic tap without speech support is inert and renders no mic button', () => {
  const el = makeEl();
  const root = fakeRoot(); // no TangoSpeech
  createHome({ root, storage: mapStorage(), usages: [], records: [] }).mount(el);
  assert.equal(el.html.includes('id="relay-home-mic"'), false);
  fire(el, 'click', node({}, 'relay-home-mic')); // must not throw
});

test('controller: unavailable server speech reports and never starts the recorder', async () => {
  const el = makeEl();
  let recorderStarted = false;
  const root = fakeRoot({
    TangoSpeech: {
      createRecorder() { return { start() { recorderStarted = true; return Promise.resolve(); }, stop() {}, cancel() {} }; },
      normalizeTranscript: (t) => t,
    },
    navigator: { mediaDevices: { getUserMedia() {} } },
    AudioContext: function AudioContext() {},
    fetch: async () => ({ ok: true, json: async () => ({ available: false, languages: [] }) }),
  });
  createHome({ root, storage: mapStorage(), usages: [], records: [] }).mount(el);
  fire(el, 'click', node({}, 'relay-home-mic'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(recorderStarted, false);
  assert.match(el.html, /语音转写暂不可用/); // honest fallback, keyboard still works
});

// D3 guard: the home line can never resurrect the banned minute estimate.
test('home.js source never mentions estimatedSavedMinutes (D3)', () => {
  const source = readFileSync(new URL('../../web/relay/home.js', import.meta.url), 'utf8');
  assert.equal(source.includes('estimatedSavedMinutes'), false);
  assert.equal(source.includes('预计省'), false);
});
