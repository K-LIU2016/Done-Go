import assert from 'node:assert/strict';
import { test } from 'node:test';

// RV2 L4接力棒 line: web/relay/baton.js + web/relay/external-apps.js
// (SPEC design/relay-v2/SPEC.md §4④ 结果页接力棒, §4⑧ 失败页接力棒,
// §5.2 外部应用清单+verifiedAt, §5.5 baton_copy/graduated 漏斗事件;
// D4: 接力棒在结果页与失败页都必须有).
//
// RED first: before implementation this file failed with ERR_MODULE_NOT_FOUND
// for web/relay/baton.js and web/relay/external-apps.js (evidence
// rv2-L4接力棒.md). Prototype copy pins: design/relay-v2/prototype.html
// sections S4 (.baton) and S8 (fail .baton).

import {
  batonMaterialPreview, createRecord, sanitizeRecord, metricPayload,
} from '../../web/relay/contracts.js';
import {
  EXTERNAL_APPS, findExternalApp, externalAppIds, unverifiedApps,
  CN_REGION, GLOBAL_REGION, DEFAULT_APP_ID,
} from '../../web/relay/external-apps.js';
import {
  buildBatonPrompt, BATON_EMPTY_MATERIAL, BATON_STRINGS_ZH,
  initialBatonState, selectApp, toggleExpanded, partitionApps,
  copyText, openExternal, copyAndOpen,
  markGraduated, batonCopyMetric, graduationMetric,
  batonCardView, batonFailCardView, mountBaton,
} from '../../web/relay/baton.js';

const SPEC_USAGE = {
  id: 'meeting-notes', title: '整理会议纪要', category: '整理',
  does: ['列出重点', '拆出待办和负责人', '标出没说清的地方'],
  materialLabel: '把会议内容给我', materialHint: '把聊天记录、笔记或转写文字粘贴到这里……',
  learned: '把会议材料交给 AI，先要「重点、待办、没说清的地方」。',
  externalPrompt: '请把下面的会议内容整理成三部分：1. 会议重点；2. 待办（写清负责人）；3. 没说清、需要追问的地方。只根据内容整理，不要补充没提到的信息。\n会议内容：{{material}}',
  keywords: ['会议', '开会', '纪要', '组会', '周会', '例会', '录音'],
  personas: { student: { featured: true, title: '整理组会纪要', hint: '重点、待办、待补充' }, worker: { featured: true } },
};
const fill = (text) => SPEC_USAGE.externalPrompt.split('{{material}}').join(text);

// ---- §5.2 external app data -------------------------------------------------

test('external app list pins SPEC §5.2: exactly 5 cn + 3 global in SPEC order with exact urls', () => {
  assert.equal(EXTERNAL_APPS.length, 8);
  assert.deepEqual(EXTERNAL_APPS.map((a) => a.region).filter((r) => r === 'cn').length, 5);
  assert.equal(EXTERNAL_APPS.filter((a) => a.region === 'global').length, 3);
  assert.deepEqual(EXTERNAL_APPS.map((a) => a.id), ['doubao', 'deepseek', 'qianwen', 'kimi', 'yuanbao', 'chatgpt', 'claude', 'gemini']);
  assert.deepEqual(EXTERNAL_APPS.map((a) => a.url), [
    'https://www.doubao.com/chat/', 'https://chat.deepseek.com/', 'https://www.qianwen.com/',
    'https://www.kimi.com/', 'https://yuanbao.tencent.com/',
    'https://chatgpt.com/', 'https://claude.ai/', 'https://gemini.google.com/',
  ]);
  assert.equal(CN_REGION, 'cn');
  assert.equal(GLOBAL_REGION, 'global');
});

test('cn five match the prototype .apps row: names, initials, brand colors', () => {
  const pins = {
    doubao: ['豆包', '豆', '#3E6BF5'], deepseek: ['DeepSeek', 'D', '#4D6BFE'],
    qianwen: ['通义千问', '千', '#615CED'], kimi: ['Kimi', 'K', '#111111'],
    yuanbao: ['元宝', '元', '#1BB46B'],
  };
  Object.keys(pins).forEach((id) => {
    const app = findExternalApp(id);
    assert.ok(app, id);
    assert.equal(app.name, pins[id][0], id + ' name');
    assert.equal(app.initial, pins[id][1], id + ' initial');
    assert.equal(app.color.toLowerCase(), pins[id][2].toLowerCase(), id + ' color');
  });
  assert.equal(DEFAULT_APP_ID, 'doubao');
});

test('every app id is unique and metric-safe (contracts APP_ID_RE shape)', () => {
  const ids = externalAppIds();
  assert.equal(new Set(ids).size, 8);
  ids.forEach((id) => {
    assert.match(id, /^[a-z0-9][a-z0-9_-]{0,31}$/);
    assert.deepEqual(metricPayload('baton_copy', id, { apps: ids }), { event: 'baton_copy:' + id });
  });
});

test('§5.2 verifiedAt: every URL carries a real verification date; unverifiedApps is empty', () => {
  EXTERNAL_APPS.forEach((app) => {
    assert.match(app.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, app.id + ' verifiedAt format');
    assert.ok(!Number.isNaN(Date.parse(app.verifiedAt)), app.id + ' verifiedAt parseable');
  });
  assert.deepEqual(unverifiedApps(EXTERNAL_APPS), []);
});

test('regions stay in the enum, notes cite the official vendor, https only', () => {
  EXTERNAL_APPS.forEach((app) => {
    assert.ok(['cn', 'global'].includes(app.region), app.id + ' region');
    assert.ok(app.note && app.note.trim(), app.id + ' note present');
    assert.ok(app.url.startsWith('https://'), app.id + ' https');
    assert.ok(!/\s/.test(app.url), app.id + ' url no whitespace');
  });
  assert.equal(findExternalApp('kimi').name, 'Kimi');
  assert.equal(findExternalApp('nope'), null);
});

// ---- §4④ prompt assembly ----------------------------------------------------

test('buildBatonPrompt fills the usage template with exactly the first 200 chars of material', () => {
  const material = '甲'.repeat(500);
  const prompt = buildBatonPrompt(SPEC_USAGE, material);
  assert.equal(prompt, fill(batonMaterialPreview(material)));
  assert.ok(!prompt.includes('{{material}}'));
  assert.ok(prompt.endsWith(batonMaterialPreview(material)));
});

test('empty material keeps the prototype placeholder …… in the slot', () => {
  assert.equal(BATON_EMPTY_MATERIAL, '……');
  assert.equal(buildBatonPrompt(SPEC_USAGE, ''), fill('……'));
  assert.equal(buildBatonPrompt(SPEC_USAGE, '   \n '), fill('……'));
});

test('invalid usage → null (contracts.validateUsage gate, incl. missing {{material}} slot)', () => {
  assert.equal(buildBatonPrompt({}, 'x'), null);
  assert.equal(buildBatonPrompt(null, 'x'), null);
  const noSlot = JSON.parse(JSON.stringify(SPEC_USAGE));
  noSlot.externalPrompt = '没有槽位的模板';
  assert.equal(buildBatonPrompt(noSlot, 'x'), null);
});

test('material that itself contains {{material}} is data, never a second substitution', () => {
  assert.equal(buildBatonPrompt(SPEC_USAGE, '{{material}}'), SPEC_USAGE.externalPrompt);
});

// ---- §4④ app selection state ------------------------------------------------

test('baton state defaults to doubao collapsed; valid selects (incl. global) stick, unknown rejected, pure', () => {
  const st0 = initialBatonState();
  assert.deepEqual(st0, { appId: 'doubao', expanded: false });
  const st1 = selectApp(st0, 'claude');
  assert.equal(st1.appId, 'claude');
  assert.equal(st0.appId, 'doubao');
  assert.equal(selectApp(st0, 'not-an-app'), null);
  const st2 = toggleExpanded(st1);
  assert.equal(st2.expanded, true);
  assert.equal(st1.expanded, false);
  assert.equal(toggleExpanded(st2).expanded, false);
});

test('partitionApps splits 5 cn + 3 global preserving list order', () => {
  const parts = partitionApps(EXTERNAL_APPS);
  assert.deepEqual(parts.cn.map((a) => a.id), ['doubao', 'deepseek', 'qianwen', 'kimi', 'yuanbao']);
  assert.deepEqual(parts.global.map((a) => a.id), ['chatgpt', 'claude', 'gemini']);
});

// ---- §4④ copy then open -----------------------------------------------------

test('copyAndOpen copies FIRST, then opens the official url as _blank noopener', async () => {
  const seq = [];
  const root = {
    navigator: { clipboard: { writeText: async (t) => { seq.push('copy:' + t.slice(0, 6)); } } },
    open: (url, name, feats) => { seq.push('open:' + url + ':' + name + ':' + feats); return { ok: 1 }; },
  };
  const res = await copyAndOpen('doubao', 'PROMPT-TEXT', { root });
  assert.deepEqual(seq, ['copy:PROMPT', 'open:https://www.doubao.com/chat/:_blank:noopener']);
  assert.equal(res.copied, true);
  assert.equal(res.opened, true);
  assert.equal(res.app.id, 'doubao');
});

test('clipboard rejection falls back to execCommand textarea copy, open still runs', async () => {
  const seq = [];
  const ta = { value: '', style: {}, setAttribute() {}, focus() {}, select() {}, parentNode: { removeChild() {} } };
  const root = {
    navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    document: {
      createElement: () => ta,
      body: { appendChild() {} },
      execCommand: (cmd) => { seq.push('exec:' + cmd); return true; },
    },
    open: (url) => { seq.push('open:' + url); return { ok: 1 }; },
  };
  const res = await copyAndOpen('kimi', 'hello', { root });
  assert.equal(res.copied, true);
  assert.equal(res.opened, true);
  assert.ok(seq.includes('exec:copy'));
  assert.equal(seq[seq.length - 1], 'open:https://www.kimi.com/');
});

test('popup blocked → opened:false but copy succeeded; unknown app → nothing happens', async () => {
  const root = { navigator: { clipboard: { writeText: async () => {} } }, open: () => null };
  const blocked = await copyAndOpen('yuanbao', 'p', { root });
  assert.deepEqual([blocked.copied, blocked.opened], [true, false]);
  assert.deepEqual(await copyAndOpen('nope', 'p', { root }), { app: null, copied: false, opened: false });
});

// ---- §4④ graduation + §5.5 metrics ------------------------------------------

test('markGraduated stamps graduated+graduatedApp and round-trips contracts.sanitizeRecord', () => {
  const rec = createRecord({ event: '整理周会', usageId: 'meeting-notes', result: 'r' },
    { uuid: '00000000-1111-4111-8111-111111111111', now: Date.parse('2026-10-25T00:00:00Z') });
  const grad = markGraduated(rec, 'kimi');
  assert.ok(grad);
  assert.equal(grad.graduated, true);
  assert.equal(grad.graduatedApp, 'kimi');
  assert.equal(grad.id, rec.id);
  assert.ok(sanitizeRecord(grad));
  assert.equal(markGraduated(rec, 'nope'), null);
  assert.equal(markGraduated(null, 'kimi'), null);
});

test('baton_copy / graduated metric payloads valid for known apps, null otherwise', () => {
  assert.deepEqual(batonCopyMetric('doubao'), { event: 'baton_copy:doubao' });
  assert.deepEqual(graduationMetric('gemini'), { event: 'graduated:gemini' });
  assert.equal(batonCopyMetric('nope'), null);
  assert.equal(graduationMetric('nope'), null);
});

// ---- §4④ result view (D4) ---------------------------------------------------

test('result baton view carries the prototype copy, doubao-only selected chip, collapsed global row', () => {
  const html = batonCardView(initialBatonState(), { usage: SPEC_USAGE, material: 'm'.repeat(300) });
  assert.ok(html.includes('data-baton="result"'));
  assert.ok(html.includes('接力棒 · 下次你自己来'));
  assert.ok(html.includes('在你常用的 AI 里，自己做一次'));
  assert.ok(html.includes('复制这段话，粘贴到下面任意一个 AI，再贴上你的会议内容。做到一次，这个用法就真正是你的了。'));
  assert.ok(html.includes('复制并打开豆包'));
  assert.ok(html.includes('✓ 我自己做到了'));
  assert.equal((html.match(/class="app-c on"/g) || []).length, 1);
  assert.ok(!html.includes('data-app="chatgpt"'), 'collapsed view must not render global chips');
  assert.ok(html.includes('更多'));
  assert.ok(html.includes('class="prompt"'));
  assert.ok(html.includes('m'.repeat(200)), 'prompt preview carries material first 200 chars');
  assert.ok(!html.includes('m'.repeat(201)), 'prompt preview must not exceed 200 chars of material');
});

test('expanded view reveals the three global apps and the button label follows selection', () => {
  const html = batonCardView({ appId: 'claude', expanded: true }, { usage: SPEC_USAGE, material: 'x' });
  assert.ok(html.includes('data-app="chatgpt"'));
  assert.ok(html.includes('data-app="claude"'));
  assert.ok(html.includes('data-app="gemini"'));
  assert.ok(html.includes('收起'));
  assert.ok(html.includes('复制并打开Claude'));
});

test('XSS: material is escaped in both baton views', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = batonCardView(initialBatonState(), { usage: SPEC_USAGE, material: evil });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const fail = batonFailCardView({ usage: SPEC_USAGE, material: evil });
  assert.ok(!fail.includes('<img src=x'));
  assert.ok(fail.includes('&lt;img'));
});

test('i18n hook: strings option overrides without touching the zh defaults', () => {
  const html = batonCardView(initialBatonState(), { usage: SPEC_USAGE, material: 'x', strings: { resultTitle: 'Do it yourself' } });
  assert.ok(html.includes('Do it yourself'));
  assert.ok(html.includes(BATON_STRINGS_ZH.resultKicker));
  assert.equal(BATON_STRINGS_ZH.failKicker, '不想等？自己接力');
});

// ---- §4⑧ fail view (D4) -----------------------------------------------------

test('fail baton view: 不想等？自己接力, fixed 豆包, no selector, no done-link', () => {
  const fail = batonFailCardView({ usage: SPEC_USAGE, material: 'x' });
  assert.ok(fail.includes('data-baton="fail"'));
  assert.ok(fail.includes('不想等？自己接力'));
  assert.ok(fail.includes('把这件事带去豆包，自己做'));
  assert.ok(fail.includes('复制下面这段话，粘贴到豆包，再贴上你的会议内容。'));
  assert.ok(fail.includes('复制并打开豆包'));
  assert.ok(fail.includes('btn dark wide'));
  assert.ok(!fail.includes('data-app='), 'fail baton pins 豆包, no app chips');
  assert.ok(!fail.includes('我自己做到了'), 'fail baton has no graduation link');
});

test('invalid usage → empty views for both variants', () => {
  assert.equal(batonCardView(initialBatonState(), { usage: {}, material: 'x' }), '');
  assert.equal(batonFailCardView({ usage: null, material: 'x' }), '');
});

// ---- mount wiring (v1 view()/onclick pattern) -------------------------------

function el(attrs) {
  return { hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k), getAttribute: (k) => attrs[k] };
}
function makeRoot() {
  return { navigator: { clipboard: { writeText: async () => {} } }, open: () => ({}) };
}

test('mountBaton: select re-renders label, 更多 expands, main button copies+opens+counts, graduate hands off', async () => {
  const target = { innerHTML: '', onclick: null };
  const events = [];
  const ctrl = mountBaton(target, {
    usage: SPEC_USAGE, material: 'mat', root: makeRoot(),
    onMetric: (p) => events.push(p.event),
    onGraduate: (appId) => events.push('grad-cb:' + appId),
  });
  assert.ok(target.innerHTML.includes('复制并打开豆包'));
  assert.ok(target.innerHTML.includes('会议内容：mat'));
  target.onclick({ target: el({ 'data-app': 'deepseek' }) });
  assert.ok(target.innerHTML.includes('复制并打开DeepSeek'));
  target.onclick({ target: el({ 'data-more': '1' }) });
  assert.ok(target.innerHTML.includes('data-app="chatgpt"'));
  await target.onclick({ target: el({ 'data-open': '1' }) });
  assert.deepEqual(events, ['baton_copy:deepseek']);
  target.onclick({ target: el({ 'data-graduate': '1' }) });
  assert.deepEqual(events, ['baton_copy:deepseek', 'grad-cb:deepseek']);
  await target.onclick({ target: el({ 'data-copy': '1' }) }); // preview copy chip: copy only, no metric
  assert.deepEqual(events, ['baton_copy:deepseek', 'grad-cb:deepseek']);
  assert.deepEqual(ctrl.state(), { appId: 'deepseek', expanded: true });
  ctrl.update({ material: 'second' });
  assert.ok(target.innerHTML.includes('会议内容：second'));
  ctrl.unmount();
  assert.equal(target.onclick, null);
});

test('mountBaton fail variant opens 豆包 and counts baton_copy:doubao', async () => {
  const target = { innerHTML: '', onclick: null };
  const events = [];
  mountBaton(target, { variant: 'fail', usage: SPEC_USAGE, material: 'm', root: makeRoot(), onMetric: (p) => events.push(p.event) });
  assert.ok(target.innerHTML.includes('data-baton="fail"'));
  await target.onclick({ target: el({ 'data-open': '1' }) });
  assert.deepEqual(events, ['baton_copy:doubao']);
});
