import assert from 'node:assert/strict';
import { test } from 'node:test';
// L3 接力流程定向单测：步骤条 / 匹配卡 / 流式渲染 / 结果页 / 自评 / 五类失败态。
// 全部纯函数与渲染函数，无 DOM：web/relay/flow.js 必须可被 node 直接 import。
import {
  RELAY_MODE, RATINGS, FAIL_TYPES, MATERIAL_MAX, PROMPT_MAX,
  checkMaterial, batonMaterialPreview, sanitizeRelayResult, validateRelayRequest, validateUsage,
} from '../../web/relay/contracts.js';
import {
  SLOW_HINT_MS, RELAY_DEADLINE_MS, TWEAKS, DEFAULT_APPS,
  formatElapsed, stepsHtml, buildRelayPrompt, buildRelayPayload, batonPrompt,
  scanPartialRelay, partialSections, sectionsToHtml, resultToPlainText,
  classifyFailure, failureCopy, matchCardHtml, runningHtml, resultHtml, failHtml,
  createRelayState, relayReducer, recordFieldsFrom,
} from '../../web/relay/flow.js';

// ---------- fixtures（经 contracts.validateUsage 保证用法形状） ----------
const rawUsage = {
  id: 'meeting-notes', title: '整理会议纪要', category: '整理',
  does: ['列出重点', '拆出待办和负责人', '标出没说清的地方'],
  materialLabel: '把会议内容给我', materialHint: '把聊天记录、笔记或转写文字粘贴到这里……',
  learned: '把会议材料交给 AI，先要「重点、待办、没说清的地方」。',
  externalPrompt: '请把下面的会议内容整理成三部分：1. 会议重点；2. 待办（写清负责人）；3. 没说清、需要追问的地方。只根据内容整理，不要补充没提到的信息。\n会议内容：{{material}}',
  keywords: ['会议', '开会'],
  personas: { student: { featured: true } },
};
const meeting = validateUsage(rawUsage);
const replyUsage = validateUsage({ ...rawUsage, id: 'write-reply', title: '写一封回复', materialLabel: '把要说的话给我', materialHint: '把对方说的话和你的意思粘贴到这里' });
const planUsage = validateUsage({ ...rawUsage, id: 'make-plan', title: '列一个计划', materialLabel: '把这件事给我', materialHint: '说说目标、时间和限制' });
const usagesById = { [meeting.id]: meeting, [replyUsage.id]: replyUsage, [planUsage.id]: planUsage };
const MATERIAL = '今天周会讨论了新版首页，决定本周五上线；张三负责测试，李四写上线公告；下周一复盘数据。';
const FULL_RESULT = JSON.stringify({
  sections: [
    { title: '会议重点', items: ['新版首页计划本周五上线', '下周一复盘上线数据'] },
    { title: '待办', items: ['张三：完成上线前测试', '李四：写好上线公告'] },
    { title: '没说清的地方', items: ['测试范围和完成时间', '复盘会的具体时间'] },
  ],
  learned: '把会议材料交给 AI，先要「重点、待办、没说清的地方」。',
  followups: ['更短一点', '更正式', '加上时间'],
});

function initState(over = {}) {
  return createRelayState({
    usage: meeting, event: '整理今天的组会记录', confidence: 0.82,
    alternatives: [replyUsage.id, planUsage.id], usagesById, guest: true,
    ...over,
  });
}

// ---------- ① 步骤条 ----------
test('stepsHtml renders the three relay steps with on/done states per prototype', () => {
  const s1 = stepsHtml(1);
  assert.ok(s1.includes('data-flow-steps'));
  assert.ok(s1.includes('class="s on"'));
  assert.ok(s1.includes('<span class="n">1</span>说清楚'));
  assert.ok(s1.includes('<span class="n">2</span>AI 先做'));
  assert.ok(s1.includes('<span class="n">3</span>你来接棒'));
  assert.ok(!s1.includes('done'));
  const s2 = stepsHtml(2);
  assert.ok(s2.includes('class="s done"'));
  assert.ok(s2.match(/class="s done"[\s\S]*?✓[\s\S]*?说清楚/), 'step1 done shows ✓');
  assert.ok(s2.match(/class="s on"[\s\S]*?<span class="n">2<\/span>AI 先做/));
  const s3 = stepsHtml(3);
  assert.equal((s3.match(/class="s done"/g) || []).length, 2);
  assert.ok(s3.match(/class="s on"[\s\S]*?<span class="n">3<\/span>你来接棒/));
});

// ---------- ② 匹配卡 ----------
test('matchCardHtml carries kicker, event, does tags, material box, tools, privacy, alternatives', () => {
  const state = initState();
  state.material = MATERIAL;
  state.materialState = checkMaterial(MATERIAL);
  const html = matchCardHtml(state);
  assert.ok(html.includes('这件事适合交给 AI'));
  assert.ok(html.includes('你说的是：<b>整理今天的组会记录</b>'));
  assert.ok(html.includes('<h2>整理会议纪要</h2>'));
  assert.ok(html.includes('① 列出重点'));
  assert.ok(html.includes('② 拆出待办和负责人'));
  assert.ok(html.includes('把会议内容给我'));
  assert.ok(html.includes('粘贴文字，或直接说'));
  assert.ok(html.includes(MATERIAL.slice(0, 10)));
  assert.ok(html.includes('placeholder="把聊天记录、笔记或转写文字粘贴到这里……"'));
  assert.ok(html.includes('说给我听'));
  assert.ok(html.includes('从剪贴板粘贴'));
  assert.ok(html.includes('点下面的按钮后，这段内容会发给 AI 处理。不包含你的账号信息，不会给任何人看。'));
  assert.ok(html.includes('让 AI 先做一版'));
  assert.ok(html.includes('不太对？换成'));
  assert.ok(html.includes('写一封回复'));
  assert.ok(html.includes('列一个计划'));
  assert.ok(html.includes('maxlength="' + MATERIAL_MAX + '"'));
});

test('matchCardHtml escapes user event and material (XSS-safe)', () => {
  const state = initState({ event: '<img src=x onerror=alert(1)>' });
  state.material = '<script>alert("x")</script>';
  state.materialState = checkMaterial(state.material);
  const html = matchCardHtml(state);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img src=x'));
});

test('empty material greys out the main button; over-cap material shows the truncation hint', () => {
  const empty = initState();
  const emptyHtml = matchCardHtml(empty);
  assert.ok(/data-flow-submit[^>]*\bdisabled\b/.test(emptyHtml), 'submit disabled when material empty');
  const long = initState();
  long.material = 'x'.repeat(MATERIAL_MAX + 1);
  long.materialState = checkMaterial(long.material);
  const longHtml = matchCardHtml(long);
  assert.ok(longHtml.includes('太长了，先贴最重要的一段'));
  assert.ok(/data-flow-submit[^>]*\bdisabled\b/.test(longHtml));
});

test('SPEC §6: the clipboard-fallback hint node always exists (hidden) so a failed paste can surface 长按粘贴', () => {
  const normal = matchCardHtml(initState());
  // 正常态：节点存在但隐藏——剪贴板读取失败时 pasteFromClipboard 才有落点可写降级提示。
  assert.ok(normal.includes('<p class="alt" data-flow-material-hint hidden>'), 'hint node present but hidden in normal state');
  assert.ok(normal.includes('太长了，先贴最重要的一段'));
  const long = initState();
  long.material = 'x'.repeat(MATERIAL_MAX + 1);
  long.materialState = checkMaterial(long.material);
  const longHtml = matchCardHtml(long);
  assert.ok(longHtml.includes('<p class="alt" data-flow-material-hint>'), 'hint node carries no hidden attr when over cap');
  assert.ok(!longHtml.includes('<p class="alt" data-flow-material-hint hidden>'));
});

test('low confidence switches the title to a three-way usage choice', () => {
  const state = initState({ confidence: 0.3 });
  const html = matchCardHtml(state);
  assert.ok(html.includes('你想让 AI 帮哪一种？'));
  const choices = html.match(/data-flow-choice="[^"]+"/g) || [];
  assert.equal(choices.length, 3, 'exactly three usage choices');
  assert.ok(html.includes('整理会议纪要'));
  assert.ok(html.includes('写一封回复'));
  assert.ok(html.includes('列一个计划'));
  assert.ok(!html.includes('让 AI 先做一版'), 'material submit hidden until a usage is chosen');
  assert.ok(!html.includes('不太对？换成'), 'alt row not shown while choosing');
});

// ---------- relay prompt 组装（§5.3 客户端按用法模板组装） ----------
test('buildRelayPrompt embeds usage template, untrusted event/material tags and the v2 output contract', () => {
  const prompt = buildRelayPrompt(meeting, '整理今天的组会记录', MATERIAL);
  assert.ok(prompt.includes('整理会议纪要'));
  assert.ok(prompt.includes('列出重点'));
  assert.ok(prompt.includes('<event>整理今天的组会记录</event>'));
  assert.ok(prompt.includes('<material>' + MATERIAL + '</material>'));
  assert.ok(prompt.includes('sections'));
  assert.ok(prompt.includes('followups'));
  assert.ok(!/estimatedSavedMinutes/i.test(prompt));
  assert.ok(!/预计省|省约|分钟/.test(prompt));
  const payload = buildRelayPayload(meeting, '整理今天的组会记录', MATERIAL, null);
  assert.equal(payload.mode, RELAY_MODE);
  assert.equal(payload.stream, true);
  assert.deepEqual(Object.keys(payload).sort(), ['mode', 'prompt', 'stream']);
  assert.notEqual(validateRelayRequest(payload), null, 'payload passes the contract validator');
});

test('buildRelayPayload stays within PROMPT_MAX at the 8000-char material cap and carries the tweak', () => {
  const material = '长'.repeat(MATERIAL_MAX);
  const payload = buildRelayPayload(meeting, '整理今天的组会记录', material, '更短一点');
  assert.ok(payload.prompt.length <= PROMPT_MAX);
  assert.ok(payload.prompt.includes('更短一点'));
  assert.notEqual(validateRelayRequest(payload), null);
});

// ---------- 接力棒提示词（§4④ 用法模板 + 材料前 200 字） ----------
test('batonPrompt fills the external template with the first 200 chars of material', () => {
  const prompt = batonPrompt(meeting, MATERIAL + '尾部多余');
  assert.ok(!prompt.includes('{{material}}'));
  assert.ok(prompt.includes(batonMaterialPreview(MATERIAL + '尾部多余')));
  assert.ok(prompt.startsWith('请把下面的会议内容整理成三部分'));
});

// ---------- ③ 流式渲染（D6 边收边渲染） ----------
test('scanPartialRelay recovers completed sections and the in-flight item from truncated JSON', () => {
  const half = '{"sections":[{"title":"会议重点","items":["新版首页计划本周五上线","下周一复盘';
  const scan = scanPartialRelay(half);
  const model = partialSections(scan);
  assert.equal(model.length, 1);
  assert.equal(model[0].title, '会议重点');
  assert.equal(model[0].items.length, 2);
  assert.equal(model[0].items[0].text, '新版首页计划本周五上线');
  assert.equal(model[0].items[0].live, false);
  assert.equal(model[0].items[1].text, '下周一复盘');
  assert.equal(model[0].items[1].live, true, 'streaming item renders as it types');
});

test('scanPartialRelay is string-aware: braces inside strings do not break scanning, prose-wrapped JSON still scans', () => {
  const tricky = '前置说明 {"sections":[{"title":"含{花括号}的标题","items":["a}b","c{d"]}]}';
  const model = partialSections(scanPartialRelay(tricky));
  assert.equal(model[0].title, '含{花括号}的标题');
  assert.deepEqual(model[0].items.map((i) => i.text), ['a}b', 'c{d']);
  const nothing = partialSections(scanPartialRelay('AI 还没开始输出 JSON'));
  assert.deepEqual(nothing, []);
  const escaped = scanPartialRelay('{"sections":[{"title":"会议重点","items":["含\\"引号\\"的内容","第二');
  const model2 = partialSections(escaped);
  assert.equal(model2[0].items[0].text, '含"引号"的内容');
  assert.equal(model2[0].items[1].text, '第二');
});

test('runningHtml shows header, timer, skeletons, caret, stop button and the 5-15s helper', () => {
  const state = initState();
  state.stage = 'running';
  state.elapsedMs = 4000;
  state.buffer = '';
  const html = runningHtml(state);
  assert.ok(html.includes('AI 正在整理…'));
  assert.ok(html.includes('已用 4 秒'));
  assert.ok(html.includes('class="skel"'), 'skeleton lines before first content');
  assert.ok(html.includes('先停一下'));
  assert.ok(html.includes('一般 5–15 秒。你的内容都留着，随时可以停。'));
  assert.ok(!html.includes('它想得有点久'), 'no slow hint before 20s');

  state.buffer = '{"sections":[{"title":"会议重点","items":["新版首页计划本周五上线","下周一复盘';
  const streaming = runningHtml(state);
  assert.ok(streaming.includes('<h4>会议重点</h4>'));
  assert.ok(streaming.includes('新版首页计划本周五上线'));
  assert.ok(streaming.includes('class="caret"'), 'blinking caret on the live item');
  assert.ok(!streaming.includes('class="skel"'), 'skeletons replaced by streamed content');
});

test('formatElapsed renders whole seconds and the 20s threshold constants are wired', () => {
  assert.equal(formatElapsed(0), '已用 0 秒');
  assert.equal(formatElapsed(4230), '已用 4 秒');
  assert.equal(SLOW_HINT_MS, 20000);
  assert.equal(RELAY_DEADLINE_MS, 60000);
  const state = initState();
  state.stage = 'running';
  state.elapsedMs = 21000;
  const slow = runningHtml(state);
  assert.ok(slow.includes('它想得有点久，再等一下或换到下面的「自己接力」'));
  assert.ok(slow.includes('不想等？自己接力'), 'baton entrance appears with the slow hint (SPEC §4③)');
});

// ---------- ④ 结果页 ----------
test('resultHtml renders sections, AI tag, actions, tweaks, rating, learned card, baton and guest nudge', () => {
  const state = initState();
  state.stage = 'result';
  state.result = sanitizeRelayResult(FULL_RESULT);
  state.rating = null;
  const html = resultHtml(state);
  assert.ok(html.includes('AI 先做好的一版'));
  assert.ok(html.includes('AI 生成 · 请你核对'));
  assert.ok(html.includes('contenteditable'));
  assert.ok(html.includes('<h4>会议重点</h4>'));
  assert.ok(html.includes('<h4>待办</h4>'));
  assert.ok(html.includes('张三：完成上线前测试'));
  assert.ok(html.includes('复制'));
  assert.ok(html.includes('直接改'));
  assert.ok(html.includes('再来一版'));
  for (const tweak of TWEAKS) assert.ok(html.includes('>' + tweak + '</span>'), 'chip ' + tweak);
  assert.ok(html.includes('这次帮上忙了吗？'));
  assert.ok(html.includes('省了不少') && html.includes('省了一点') && html.includes('没省时间'));
  assert.ok(html.includes('你学会了一个新用法'));
  assert.ok(html.includes('接力棒 · 下次你自己来'));
  assert.ok(html.includes('在你常用的 AI 里，自己做一次'));
  for (const app of ['豆包', 'DeepSeek', '通义千问', 'Kimi', '元宝']) assert.ok(html.includes(app));
  assert.ok(html.includes('更多'));
  assert.ok(html.includes('复制并打开豆包'));
  assert.ok(html.includes('✓ 我自己做到了'));
  assert.ok(html.includes('已存到这台设备。'), 'guest nudge per SPEC §4④');
  assert.ok(html.includes('登录'));
});

test('D3: no estimated minutes anywhere on the result page or in record fields', () => {
  const state = initState();
  state.stage = 'result';
  state.result = sanitizeRelayResult(FULL_RESULT);
  const html = resultHtml(state) + failHtml({ ...state, failType: 'upstream' }) + runningHtml({ ...state, stage: 'running' });
  assert.ok(!html.includes('分钟'));
  assert.ok(!html.toLowerCase().includes('estimatedsavedminutes'));
  const fields = recordFieldsFrom(state);
  assert.ok(!('estimatedSavedMinutes' in fields));
  assert.deepEqual(Object.keys(fields).sort(), ['event', 'failed', 'graduatedApp', 'rating', 'result', 'usageId']);
});

test('rating selection is exclusive and stored; sections export as copyable plain text', () => {
  const state = initState();
  state.stage = 'result';
  state.result = sanitizeRelayResult(FULL_RESULT);
  state.rating = 'much';
  const html = resultHtml(state);
  const on = html.match(/data-flow-rate="much"[^>]*class="[^"]*\bon\b[^"]*"/);
  assert.ok(on, 'chosen rating carries the on class');
  assert.ok(!/data-flow-rate="little"[^>]*class="[^"]*\bon\b/.test(html));
  const plain = resultToPlainText(state.result.sections);
  assert.ok(plain.includes('会议重点'));
  assert.ok(plain.includes('1. 新版首页计划本周五上线'));
  assert.ok(plain.includes('2. 下周一复盘上线数据'));
  assert.ok(!plain.includes('<'), 'plain text carries no markup');
});

test('sectionsToHtml escapes item text and follows the prototype h4 + ordered list shape', () => {
  const html = sectionsToHtml([{ title: '重点<b>', items: [{ text: '<i>x</i>', live: false }] }]);
  assert.ok(html.includes('<h4>重点&lt;b&gt;</h4>'));
  assert.ok(html.includes('&lt;i&gt;x&lt;/i&gt;'));
});

// ---------- ⑧ 五类失败态 ----------
test('failureCopy maps the five SPEC types to their exact reasons and retry visibility', () => {
  assert.deepEqual(failureCopy('unconfigured').reason, 'AI 暂时没开，先自己接力试试');
  assert.deepEqual(failureCopy('timeout').reason, '它想得太久了（超过 60 秒）');
  assert.deepEqual(failureCopy('ratelimit').reason, '今天的体验次数用完了，明天再来');
  assert.deepEqual(failureCopy('upstream').reason, 'AI 服务这会儿忙');
  assert.deepEqual(failureCopy('format').reason, 'AI 回答乱了，再试一次');
  for (const type of FAIL_TYPES) assert.equal(failureCopy(type).retry, type !== 'ratelimit');
});

test('classifyFailure maps wire codes, TANGO codes, statuses and client deadline to the five types', () => {
  assert.equal(classifyFailure({ error: 'ai-not-configured' }), 'unconfigured');
  assert.equal(classifyFailure({ code: 'TANGO_AI_NOT_CONFIGURED' }), 'unconfigured');
  assert.equal(classifyFailure({ error: 'ai-timeout' }), 'timeout');
  assert.equal(classifyFailure({ code: 'TANGO_AI_TIMEOUT' }), 'timeout');
  assert.equal(classifyFailure({ status: 504 }), 'timeout');
  assert.equal(classifyFailure({ kind: 'deadline' }), 'timeout');
  assert.equal(classifyFailure({ error: 'ai-daily-limit' }), 'ratelimit');
  assert.equal(classifyFailure({ error: 'ai-visitor-daily-limit' }), 'ratelimit');
  assert.equal(classifyFailure({ error: 'ai-rate-limited' }), 'ratelimit');
  assert.equal(classifyFailure({ code: 'TANGO_AI_RATE_LIMITED' }), 'ratelimit');
  assert.equal(classifyFailure({ status: 429, error: 'ai-rate-limited' }), 'ratelimit');
  assert.equal(classifyFailure({ kind: 'format' }), 'format');
  assert.equal(classifyFailure({ error: 'ai-response-invalid' }), 'format');
  assert.equal(classifyFailure({ error: 'ai-upstream-failed' }), 'upstream');
  assert.equal(classifyFailure({ error: 'ai-busy' }), 'upstream');
  assert.equal(classifyFailure({ status: 502 }), 'upstream');
  assert.equal(classifyFailure(new Error('network boom')), 'upstream');
  assert.equal(classifyFailure(null), 'upstream');
});

test('failHtml shows the fail card, reassurance, retry (hidden for ratelimit) and the baton for all five types (D4)', () => {
  for (const type of FAIL_TYPES) {
    const state = initState();
    state.stage = 'fail';
    state.failType = type;
    state.material = MATERIAL;
    const html = failHtml(state);
    assert.ok(html.includes('AI 这次没接上'), type + ' title');
    assert.ok(html.includes(failureCopy(type).reason), type + ' reason');
    assert.ok(html.includes('不是你的问题'), type + ' reassurance');
    assert.ok(html.includes('你填的内容都还在。'), type + ' keep line');
    assert.ok(html.includes('不想等？自己接力'), type + ' has baton (D4)');
    assert.ok(html.includes('把这件事带去豆包，自己做'), type + ' baton title');
    assert.ok(html.includes('复制并打开豆包'), type + ' baton action');
    if (type === 'ratelimit') assert.ok(!html.includes('再试一次'), 'ratelimit hides retry');
    else assert.ok(html.includes('再试一次'), type + ' shows retry');
  }
});

// ---------- 状态机（reducer，全流程无 DOM 可测） ----------
function reduce(state, action) { return relayReducer(state, action); }

test('happy path: SUBMIT → DELTA → STREAM_END produces relay_ok and result fields', () => {
  let s = initState();
  s.material = MATERIAL;
  s.materialState = checkMaterial(MATERIAL);
  const events = [];
  const step = (action) => { const r = reduce(s, action); events.push(...r.effects); s = r.state; return r; };
  let r = step({ type: 'SUBMIT' });
  assert.equal(s.stage, 'running');
  assert.ok(events.some((e) => e.type === 'metric' && e.name === 'relay_send'));
  const sendEffect = events.find((e) => e.type === 'send');
  assert.ok(sendEffect, 'send effect emitted');
  assert.equal(sendEffect.payload.mode, 'relay');
  assert.ok(sendEffect.payload.prompt.includes(MATERIAL));
  assert.ok(events.some((e) => e.type === 'startTimer'));
  step({ type: 'DELTA', text: FULL_RESULT.slice(0, 40) });
  assert.equal(s.buffer.length, 40);
  step({ type: 'DELTA', text: FULL_RESULT.slice(40) });
  r = step({ type: 'STREAM_END' });
  assert.equal(s.stage, 'result');
  assert.equal(s.result.sections.length, 3);
  assert.ok(events.some((e) => e.type === 'metric' && e.name === 'relay_ok'));
  assert.ok(events.some((e) => e.type === 'stopTimer'));
  const rec = events.filter((e) => e.type === 'record').pop();
  assert.equal(rec.fields.usageId, 'meeting-notes');
  assert.equal(rec.fields.failed, null);
  assert.ok(rec.fields.result.includes('会议重点'));
  step({ type: 'RATE', value: 'much' });
  assert.equal(s.rating, 'much');
  assert.ok(events.some((e) => e.type === 'metric' && e.name === 'rate' && e.arg === 'much'));
  const fields = recordFieldsFrom(s);
  assert.equal(fields.rating, 'much');
  assert.ok(fields.result.includes('会议重点'));
});

test('SUBMIT is guarded: empty material or wrong stage never sends', () => {
  let r = { state: initState() };
  r = reduce(r.state, { type: 'SUBMIT' });
  assert.equal(r.state.stage, 'match');
  assert.ok(!r.effects.some((e) => e.type === 'send'));
  let s2 = initState();
  s2.material = MATERIAL;
  s2.materialState = checkMaterial(MATERIAL);
  s2 = reduce(s2, { type: 'SUBMIT' }).state;
  const again = reduce(s2, { type: 'SUBMIT' });
  assert.equal(again.state.stage, 'running');
  assert.ok(!again.effects.some((e) => e.type === 'send'), 'no double submit while running');
});

test('STOP returns to match with material preserved, aborts the stream and counts the stop metric', () => {
  let s = initState();
  s.material = MATERIAL;
  s.materialState = checkMaterial(MATERIAL);
  s = reduce(s, { type: 'SUBMIT' }).state;
  s = reduce(s, { type: 'DELTA', text: '{"sections":' }).state;
  const r = reduce(s, { type: 'STOP' });
  assert.equal(r.state.stage, 'match');
  assert.equal(r.state.material, MATERIAL, 'material preserved');
  assert.ok(r.effects.some((e) => e.type === 'metric' && e.name === 'stop'));
  assert.ok(r.effects.some((e) => e.type === 'abort'));
  assert.ok(r.effects.some((e) => e.type === 'stopTimer'));
  // late stream error after user stop is ignored
  const late = reduce(r.state, { type: 'STREAM_ERROR', error: { code: 'TANGO_AI_ABORTED' } });
  assert.equal(late.state.stage, 'match');
  assert.equal(late.state.failType, null);
});

test('stream errors land in the matching fail bucket with relay_fail:<type> metrics and a record', () => {
  for (const [error, expected] of [
    [{ error: 'ai-timeout' }, 'timeout'],
    [{ error: 'ai-visitor-daily-limit' }, 'ratelimit'],
    [{ error: 'ai-upstream-failed' }, 'upstream'],
  ]) {
    let s = initState();
    s.material = MATERIAL;
    s.materialState = checkMaterial(MATERIAL);
    s = reduce(s, { type: 'SUBMIT' }).state;
    const r = reduce(s, { type: 'STREAM_ERROR', error });
    assert.equal(r.state.stage, 'fail');
    assert.equal(r.state.failType, expected);
    assert.ok(r.effects.some((e) => e.type === 'metric' && e.name === 'relay_fail' && e.arg === expected));
    const rec = r.effects.find((e) => e.type === 'record');
    assert.equal(rec.fields.failed, expected);
  }
});

test('unconfigured is detected before any send; RETRY works for all types except ratelimit', () => {
  let s = initState();
  s.material = MATERIAL;
  s.materialState = checkMaterial(MATERIAL);
  const r = reduce(s, { type: 'SUBMIT', unconfigured: true });
  assert.equal(r.state.stage, 'fail');
  assert.equal(r.state.failType, 'unconfigured');
  assert.ok(!r.effects.some((e) => e.type === 'send'), 'nothing sent when AI is not configured');
  assert.ok(r.effects.some((e) => e.type === 'metric' && e.name === 'relay_fail' && e.arg === 'unconfigured'));
  const retry = reduce(r.state, { type: 'RETRY' });
  assert.equal(retry.state.stage, 'running');
  assert.ok(retry.effects.some((e) => e.type === 'send'));
  let rl = r.state;
  rl = { ...rl, failType: 'ratelimit' };
  const blocked = reduce(rl, { type: 'RETRY' });
  assert.equal(blocked.state.stage, 'fail', 'ratelimit retry is blocked');
  assert.ok(!blocked.effects.some((e) => e.type === 'send'));
});

test('60s deadline: TICK at deadline emits the abort effect and lands on timeout; 20s only flags slow', () => {
  let s = initState();
  s.material = MATERIAL;
  s.materialState = checkMaterial(MATERIAL);
  s = reduce(s, { type: 'SUBMIT' }).state;
  let r = reduce(s, { type: 'TICK', ms: 20000 });
  assert.equal(r.state.elapsedMs, 20000);
  assert.equal(r.state.slow, true);
  assert.ok(!r.effects.some((e) => e.type === 'deadlineAbort'));
  r = reduce(r.state, { type: 'TICK', ms: 60000 });
  assert.ok(r.effects.some((e) => e.type === 'deadlineAbort'));
  const fail = reduce(r.state, { type: 'STREAM_ERROR', error: { kind: 'deadline' } });
  assert.equal(fail.state.failType, 'timeout');
});

test('final frame full validation (D6): unparsable final JSON fails as format even after partial render', () => {
  let s = initState();
  s.material = MATERIAL;
  s.materialState = checkMaterial(MATERIAL);
  s = reduce(s, { type: 'SUBMIT' }).state;
  s = reduce(s, { type: 'DELTA', text: '抱歉，我无法整理这段内容。' }).state;
  const r = reduce(s, { type: 'STREAM_END' });
  assert.equal(r.state.stage, 'fail');
  assert.equal(r.state.failType, 'format');
  assert.ok(r.effects.some((e) => e.type === 'metric' && e.name === 'relay_fail' && e.arg === 'format'));
  assert.ok(r.effects.some((e) => e.type === 'record'));
});

test('REGEN with a tweak re-sends and the tweak reaches the prompt; plain REGEN keeps material', () => {
  let s = initState();
  s.material = MATERIAL;
  s.materialState = checkMaterial(MATERIAL);
  s = reduce(s, { type: 'SUBMIT' }).state;
  s = reduce(s, { type: 'STREAM_END', text: FULL_RESULT }).state;
  assert.equal(s.stage, 'result');
  const r = reduce(s, { type: 'REGEN', tweak: '更正式' });
  assert.equal(r.state.stage, 'running');
  const send = r.effects.find((e) => e.type === 'send');
  assert.ok(send.payload.prompt.includes('更正式'));
  assert.ok(r.effects.some((e) => e.type === 'metric' && e.name === 'relay_send'));
  assert.equal(r.state.material, MATERIAL);
});

test('CHOICE/ALT switch usages with match_switch and keep the material', () => {
  let s = initState({ confidence: 0.3 });
  s.material = MATERIAL;
  const choice = reduce(s, { type: 'CHOOSE_CHOICE', usageId: 'write-reply' });
  assert.equal(choice.state.usage.id, 'write-reply');
  assert.equal(choice.state.material, MATERIAL);
  assert.equal(choice.state.lowConfidence, false, 'choice resolves low-confidence mode');
  assert.ok(choice.effects.some((e) => e.type === 'metric' && e.name === 'match_switch'));
  const alt = reduce(choice.state, { type: 'CHOOSE_ALT', usageId: 'make-plan' });
  assert.equal(alt.state.usage.id, 'make-plan');
  assert.ok(alt.effects.some((e) => e.type === 'metric' && e.name === 'match_switch'));
});

test('baton actions: app selection, copy-open metric, graduation and the login nudge', () => {
  let s = initState();
  s.material = MATERIAL;
  s.stage = 'result';
  s.result = sanitizeRelayResult(FULL_RESULT);
  s = reduce(s, { type: 'SELECT_APP', appId: 'deepseek' }).state;
  assert.equal(s.selectedAppId, 'deepseek');
  assert.ok(resultHtml(s).includes('复制并打开DeepSeek'));
  const copy = reduce(s, { type: 'COPY_OPEN', appId: 'deepseek' });
  assert.ok(copy.effects.some((e) => e.type === 'copy'));
  assert.ok(copy.effects.some((e) => e.type === 'open'));
  assert.ok(copy.effects.some((e) => e.type === 'metric' && e.name === 'baton_copy' && e.arg === 'deepseek'));
  const grad = reduce(copy.state, { type: 'GRADUATE', appId: 'deepseek' });
  assert.ok(grad.effects.some((e) => e.type === 'metric' && e.name === 'graduated' && e.arg === 'deepseek'));
  assert.ok(grad.effects.some((e) => e.type === 'navigate' && e.hash === '#/me'));
  assert.equal(recordFieldsFrom(grad.state).graduatedApp, 'deepseek');
  const nudge = reduce(s, { type: 'LOGIN_NUDGE' });
  assert.ok(nudge.effects.some((e) => e.type === 'metric' && e.name === 'signup_nudge_click'));
});

test('match_shown fires once on flow entry; guest completes the whole flow without login (D5)', () => {
  const s = initState({ guest: true });
  assert.equal(s.guest, true);
  assert.equal(s.stage, 'match');
  const begin = reduce(s, { type: 'BEGIN' });
  assert.ok(begin.effects.some((e) => e.type === 'metric' && e.name === 'match_shown'));
  let flow = begin.state;
  flow.material = MATERIAL;
  flow.materialState = checkMaterial(MATERIAL);
  flow = reduce(flow, { type: 'SUBMIT' }).state;
  flow = reduce(flow, { type: 'DELTA', text: FULL_RESULT }).state;
  flow = reduce(flow, { type: 'STREAM_END' }).state;
  flow = reduce(flow, { type: 'RATE', value: 'little' }).state;
  assert.equal(flow.stage, 'result');
  assert.equal(flow.rating, 'little');
  // nowhere in the whole journey is a login required
  assert.ok(!matchCardHtml(flow).includes('登录'));
  assert.ok(!runningHtml(flow).includes('登录'));
  const record = recordFieldsFrom(flow);
  assert.equal(record.rating, 'little');
  assert.equal(record.failed, null);
  assert.ok(record.result.includes('会议重点'));
});

test('edited result overrides the generated plain text in record fields', () => {
  let s = initState();
  s.stage = 'result';
  s.result = sanitizeRelayResult(FULL_RESULT);
  s = reduce(s, { type: 'SET_EDITED', text: '我改过的版本' }).state;
  assert.equal(recordFieldsFrom(s).result, '我改过的版本');
});

test('DEFAULT_APPS fallback matches the SPEC §5.2 five CN apps with verified URLs', () => {
  const ids = DEFAULT_APPS.filter((a) => a.region === 'cn').map((a) => a.id);
  assert.deepEqual(ids, ['doubao', 'deepseek', 'qianwen', 'kimi', 'yuanbao']);
  for (const app of DEFAULT_APPS) {
    assert.ok(/^https:\/\/.+/.test(app.url), app.id + ' url');
    assert.ok(app.name && app.initial && /^#[0-9a-f]{6}$/i.test(app.color), app.id + ' chrome');
  }
});
