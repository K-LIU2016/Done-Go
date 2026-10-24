import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO线 S6传棒：web/social/baton.js（唯一名下文件）。
// 依据 PRD design/social-sync/PRD.md §4.4（传棒）、§4.8（访客打开即试用）、
// 红线 D6（用法卡只含 usageId+场景标题+提示词模板；baton_events
// sent/opened/relay-completed/graduated；传递链最多展示 5 跳）与
// 原型 prototype.html ② 传棒 sheet（.scrim/.sheet/.usecard/.chain/.pick/.pk/.note/.big）。
// 契约一律来自 web/social/contracts.js（绝不在此重定义）；relay 只读 import。
//
// RED first：实现前本文件因 web/social/baton.js 不存在而 ERR_MODULE_NOT_FOUND。

import {
  BATON_CARD_FIELDS, BATON_EVENTS, BATON_CHAIN_MAX_HOPS, BATON_TARGET_KINDS,
  STYLES, FORBIDDEN_UPLOAD_FIELDS,
  validateBatonCard, validateBatonShare, validateBatonEvent, validateAlias,
} from '../../web/social/contracts.js';
import { validateUsage } from '../../web/relay/contracts.js';
import {
  BATON_UI_STRINGS_ZH, buildBatonCard, buildBatonShare, newBatonId,
  batonEvent, chainViewModel, batonLinkHref,
  initialSendState, selectSendTarget, selectSendLink, sendButtonLabel,
  sendSheetView, buildTryPrompt, receiverCardView,
  mountSendSheet, mountReceiver,
} from '../../web/social/baton.js';

// 场景库真实用法（web/relay/scenes.zh.json paper-read）。
const USAGE = {
  id: 'paper-read', title: '读懂一篇论文', category: '读',
  does: ['先给 5 个要点', '列出 3 个可以追问的问题', '标出看不懂的段落'],
  materialLabel: '把论文给我', materialHint: '粘贴摘要或你想读的那几段，英文也可以。',
  learned: '读长文先要「要点＋问题」，再自己核对原文。',
  externalPrompt: '请读下面的论文内容，给我 5 个核心要点、3 个值得追问的问题，并指出可能需要背景知识才能看懂的段落。只根据内容回答，不要编造论文里没有的信息。\n论文内容：{{material}}',
  keywords: ['论文', '读论文', '英文论文'],
  personas: { student: { featured: true, hint: '先给你 5 个要点和 3 个问题' } },
};

// 红线 D2/D6 的泄漏探针：私人事项标题、材料、时间、地点、AI 结果 ——
// 这些字段名与值都绝不允许出现在任何传棒卡/链接/视图里。
const LEAKS = {
  itemTitle: '给妈妈买药并陪她散步',
  note: '我的私人笔记：今晚 8 点开组会',
  materials: ['11月3日 周二 晚八点 3 号楼会议室的纪要原文'],
  startTime: '2026-10-25T20:00:00+08:00',
  aiResult: 'AI 生成：一、买药 二、散步 三、…',
  location: '3 号楼会议室',
};
const LEAKY_USAGE = Object.assign({}, USAGE, LEAKS, { id: 'leak-guard', title: '整理会议纪要' });

const TARGETS = [
  { id: 'pair-1', kind: 'pair', alias: '安静的湖', avatarColor: '#4C7A93' },
  { id: 'pair-2', kind: 'pair', alias: '妈妈', avatarColor: '#3E7B5B' },
  { id: 'circle-1', kind: 'circle', alias: '课题组', avatarColor: '#615CED' },
];

const CHAIN_8 = ['晨风的信', '安静的湖', '远山的松', '晨跑的鹿', '溪边的石', '林间的鸟', '谷雨的竹', '雪原的狐'];

function el(attrs) {
  return { hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k), getAttribute: (k) => attrs[k] };
}
function makeRoot(log) {
  return { navigator: { clipboard: { writeText: async (t) => { log.push(String(t)); } } } };
}

// ---- D6 用法卡字段白名单 -----------------------------------------------------

test('D6 白名单：buildBatonCard 只产出 usageId/scenarioTitle/promptTemplate 三字段并通过契约校验', () => {
  const card = buildBatonCard(USAGE);
  assert.ok(validateUsage(USAGE), 'fixture 必须是合法场景库用法');
  assert.ok(card, '合法用法必须能建卡');
  assert.deepEqual(Object.keys(card).sort(), BATON_CARD_FIELDS.slice().sort());
  assert.equal(card.usageId, 'paper-read');
  assert.equal(card.scenarioTitle, '读懂一篇论文');
  assert.equal(card.promptTemplate, USAGE.externalPrompt);
  assert.ok(card.promptTemplate.includes('{{material}}'), '提示词模板保留材料槽');
  const round = validateBatonCard(card);
  assert.ok(round, '产出必须过 social contracts.validateBatonCard');
  assert.deepEqual(round, card);
  // 场景库的其余字段（does/keywords/personas/learned/…）一个都不上卡
  ['does', 'keywords', 'personas', 'learned', 'materialLabel', 'materialHint', 'category'].forEach((k) => {
    assert.ok(!(k in card), '卡上不得有 ' + k);
  });
});

test('D6 泄漏证明：私人标题/材料/时间/地点/AI结果 绝不出现在卡上（注入也不行）', () => {
  const card = buildBatonCard(LEAKY_USAGE);
  assert.ok(card, 'relay validateUsage 会剥离未知字段，泄漏字段进不了卡');
  const json = JSON.stringify(card);
  Object.keys(LEAKS).forEach((k) => {
    const value = LEAKS[k];
    const probes = Array.isArray(value) ? value : [value];
    probes.forEach((p) => assert.ok(!json.includes(String(p)), '泄漏字段 ' + k + ' 的值出现在卡上'));
    assert.ok(!json.includes('"' + k + '"'), '泄漏字段名 ' + k + ' 出现在卡上');
  });
  // FORBIDDEN_UPLOAD_FIELDS（D2 清单）与卡字段零交集
  FORBIDDEN_UPLOAD_FIELDS.forEach((f) => assert.ok(!(f in card)));
});

test('D6 泄漏证明：用户做完的事项记录（含真实材料）建不了卡 → null', () => {
  const doneRecord = {
    event: '给妈妈买药', material: '处方单：二甲双胍 0.5g',
    usageId: 'paper-read', doneAt: '2026-10-25T20:00:00Z', result: 'AI 生成的清单',
  };
  assert.equal(buildBatonCard(doneRecord), null, '记录不是场景库用法，必须拒绝而不是裁剪');
  assert.equal(buildBatonCard(null), null);
  assert.equal(buildBatonCard({}), null);
  assert.equal(buildBatonCard(Object.assign({}, USAGE, { externalPrompt: '没有材料槽' })), null);
  assert.equal(buildBatonCard(Object.assign({}, USAGE, { title: '' })), null);
});

test('D6 buildBatonShare：pair/circle/link 三途都过 validateBatonShare，非法目标拒绝', () => {
  const pair = buildBatonShare({ id: 'baton-1', fromAccount: 'acc-a', usage: USAGE, targetKind: 'pair', targetId: 'pair-1' });
  assert.ok(pair && validateBatonShare(pair));
  assert.equal(pair.targetKind, 'pair');
  assert.equal(pair.targetId, 'pair-1');
  assert.ok(validateBatonCard(pair.card));

  const circle = buildBatonShare({ id: 'baton-2', fromAccount: 'acc-a', card: buildBatonCard(USAGE), targetKind: 'circle', targetId: 'circle-1' });
  assert.ok(circle && validateBatonShare(circle));
  assert.equal(circle.targetKind, 'circle');

  const link = buildBatonShare({ id: 'baton-3', fromAccount: 'acc-a', usage: USAGE, targetKind: 'link' });
  assert.ok(link && validateBatonShare(link));
  assert.equal(link.targetId, null, 'link 无直接接收者');

  assert.equal(buildBatonShare({ id: 'baton-4', fromAccount: 'acc-a', usage: USAGE, targetKind: 'dm', targetId: 'x' }), null, '私信不是传棒目标（D5/PRD §9 不做私信）');
  assert.equal(buildBatonShare({ id: 'baton-5', fromAccount: 'acc-a', usage: USAGE, targetKind: 'pair' }), null, 'pair 必须有 targetId');
  assert.equal(buildBatonShare({ id: 'baton-6', fromAccount: '', usage: USAGE, targetKind: 'link' }), null);
  assert.equal(buildBatonShare({ id: 'baton-7', fromAccount: 'acc-a', usage: { junk: true }, targetKind: 'link' }), null);
  assert.equal(buildBatonShare({ id: 'baton-8', fromAccount: 'acc-a', card: { usageId: 'x' }, targetKind: 'link' }), null);
  assert.deepEqual(BATON_TARGET_KINDS, ['pair', 'circle', 'link'], '三途：搭档/圈/链接');
});

test('newBatonId：契约 accountId 形状（非空 ≤64），多次生成不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = newBatonId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length >= 6 && id.length <= 64);
    assert.ok(!/\s/.test(id));
    seen.add(id);
  }
  assert.equal(seen.size, 200);
});

// ---- D6 传递链（最多展示 5 跳）----------------------------------------------

test('D6 链裁剪：8 跳只展示最后 5 跳（contracts.clipBatonChain 同规），统计与文案随总数', () => {
  const vm = chainViewModel(CHAIN_8);
  assert.equal(BATON_CHAIN_MAX_HOPS, 5);
  assert.equal(vm.total, 8);
  assert.equal(vm.hops.length, 5, '最多展示 5 跳');
  assert.deepEqual(vm.hops.map((h) => h.alias), ['晨跑的鹿', '溪边的石', '林间的鸟', '谷雨的竹', '雪原的狐'], '保留最后 5 跳');
  assert.equal(vm.overLimit, true);
  assert.equal(vm.droppedFromStart, 3);
  assert.equal(vm.summaryText, '这个用法经过了 8 个人');
  assert.equal(vm.questionText, '已经过 8 个人，下一棒交给谁？');
  vm.hops.forEach((h) => {
    assert.ok(validateAlias(h.alias));
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(h.avatarColor));
    // 徽章字 = 尾字（自然物，contracts.aliasBadgeChar；与 home.js ① 屏同规则）
    assert.equal(h.initial, Array.from(h.alias)[Array.from(h.alias).length - 1]);
  });
  // 「·」标记后缀不参与取字：今晚的风·示例 → 风（lab 示例徽章不再全变「例」）
  const marked = chainViewModel(['今晚的风·示例', '安静的湖']);
  assert.equal(marked.hops[0].initial, '风');
});

test('链边界：≤5 跳不裁剪；垃圾项被丢弃；5/6 跳分界正确', () => {
  const three = chainViewModel(['甲山的松', '乙谷的风', '丙湖的月']);
  assert.equal(three.hops.length, 3);
  assert.equal(three.overLimit, false);
  assert.equal(three.droppedFromStart, 0);
  assert.equal(three.summaryText, '这个用法经过了 3 个人');

  const five = chainViewModel(CHAIN_8.slice(0, 5));
  assert.equal(five.hops.length, 5);
  assert.equal(five.overLimit, false, '恰好 5 跳不算超限');

  const six = chainViewModel(CHAIN_8.slice(0, 6));
  assert.equal(six.hops.length, 5);
  assert.equal(six.overLimit, true);
  assert.deepEqual(six.hops.map((h) => h.alias), CHAIN_8.slice(1, 6));

  const junky = chainViewModel(['甲山的松', '', '   ', 123, null, { nope: 1 }, '乙谷的风']);
  assert.deepEqual(junky.hops.map((h) => h.alias), ['甲山的松', '乙谷的风']);
  assert.equal(junky.total, 2);

  assert.equal(chainViewModel(null).hops.length, 0);
  assert.equal(chainViewModel('不是数组').total, 0);
});

test('链对象条目：{alias,avatarColor} 带色；纯字符串用确定性流派色，稳定可测', () => {
  const vm = chainViewModel([{ alias: '远山的松', avatarColor: '#615CED' }, '安静的湖']);
  assert.equal(vm.hops[0].avatarColor, '#615CED');
  const palette = STYLES.map((s) => s.color.toUpperCase());
  assert.ok(palette.includes(vm.hops[1].avatarColor.toUpperCase()), '无色条目落到 6 流派色板');
  const again = chainViewModel(['安静的湖']);
  assert.equal(again.hops[0].avatarColor, vm.hops[1].avatarColor, '同别名同色（确定性）');
  assert.notEqual(chainViewModel(['远山的松']).hops[0].avatarColor, '#999999', '非法色不被采用');
});

test('空链文案：第一棒语义（PRD §4.4 首次传棒）', () => {
  const vm = chainViewModel([]);
  assert.equal(vm.total, 0);
  assert.equal(vm.hops.length, 0);
  assert.equal(vm.questionText, '第一棒交给谁？');
  assert.ok(vm.summaryText.length > 0);
});

// ---- 链接（§4.8 访客打开）----------------------------------------------------

test('batonLinkHref：只含路由和 id，绝不含标题/模板/任何个人内容', () => {
  assert.equal(batonLinkHref('baton-abc'), '#/social/baton/baton-abc');
  assert.equal(batonLinkHref('baton-abc', { base: 'https://donego.udify.fun/' }), 'https://donego.udify.fun/#/social/baton/baton-abc');
  assert.equal(batonLinkHref('baton-abc', { base: 'https://donego.udify.fun' }), 'https://donego.udify.fun/#/social/baton/baton-abc');
  const href = batonLinkHref('baton-abc');
  assert.ok(!href.includes('论文') && !href.includes('材料') && !href.includes(USAGE.title), '链接只带 batonId');
  assert.equal(batonLinkHref(''), null);
  assert.equal(batonLinkHref('has space'), null);
  assert.equal(batonLinkHref('a/b'), null);
});

// ---- baton_events（D6：发出/打开/完成接力/毕业）------------------------------

test('batonEvent：四种事件都过 validateBatonEvent；id/at 可注入；非法拒绝', () => {
  assert.deepEqual(BATON_EVENTS, ['sent', 'opened', 'relay-completed', 'graduated']);
  BATON_EVENTS.forEach((kind) => {
    const ev = batonEvent(kind, 'baton-1', 'acc-b', { id: 'ev-' + kind, at: '2026-10-25T08:00:00.000Z' });
    assert.ok(ev, kind);
    assert.deepEqual(ev, validateBatonEvent(ev));
    assert.equal(ev.kind, kind);
    assert.equal(ev.batonId, 'baton-1');
    assert.equal(ev.byAccount, 'acc-b');
  });
  assert.equal(batonEvent('deleted', 'baton-1', 'acc-b'), null, '事件枚举外一律拒绝');
  assert.equal(batonEvent('sent', '', 'acc-b'), null);
  assert.equal(batonEvent('sent', 'baton-1', ''), null);
  const auto = batonEvent('opened', 'baton-1', 'acc-b');
  assert.ok(!Number.isNaN(Date.parse(auto.at)), '缺省 at 用当前时间');
});

// ---- 发送弹层状态机（发搭档 / 发圈 / 复制链接 三途）--------------------------

test('发送状态机：默认选第一个目标；无目标默认链接；选择互斥且只认已知目标', () => {
  assert.deepEqual(initialSendState(TARGETS), { targetId: 'pair-1', linkMode: false });
  assert.deepEqual(initialSendState([]), { targetId: null, linkMode: true }, '没有搭档/圈时链接是唯一途');

  const picked = selectSendTarget(initialSendState(TARGETS), 'circle-1', TARGETS);
  assert.deepEqual(picked, { targetId: 'circle-1', linkMode: false });

  const linked = selectSendLink(picked);
  assert.deepEqual(linked, { targetId: null, linkMode: true }, '生成链接与选人互斥');

  assert.deepEqual(selectSendTarget(linked, 'pair-2', TARGETS), { targetId: 'pair-2', linkMode: false });
  assert.equal(selectSendTarget(initialSendState(TARGETS), '不存在的目标', TARGETS), null, '只认传入的目标清单');
  assert.equal(selectSendTarget(initialSendState(TARGETS), '', TARGETS), null);
});

test('大按钮文案：传给 {TA} / 复制链接；可被 strings 覆盖', () => {
  assert.equal(sendButtonLabel(initialSendState(TARGETS), TARGETS), '传给 安静的湖');
  assert.equal(sendButtonLabel({ targetId: 'circle-1', linkMode: false }, TARGETS), '传给 课题组');
  assert.equal(sendButtonLabel({ targetId: null, linkMode: true }, TARGETS), BATON_UI_STRINGS_ZH.copyLinkButton);
  assert.equal(
    sendButtonLabel({ targetId: null, linkMode: true }, TARGETS, { copyLinkButton: 'Copy link' }),
    'Copy link',
  );
});

// ---- 发送弹层视图（原型 ② 文案钉死）------------------------------------------

test('sendSheetView：原型②文案与结构（标题/接力棒卡/传给/生成链接/隐私注/大按钮）', () => {
  const state = initialSendState(TARGETS);
  const html = sendSheetView(state, { card: buildBatonCard(USAGE), chain: CHAIN_8, targets: TARGETS });
  assert.ok(html.includes('把这个用法传下去'), 'sheet 标题');
  assert.ok(html.includes('AI 用法 · 接力棒'), '卡 kicker');
  assert.ok(html.includes('读懂一篇论文'), '场景标题上卡');
  assert.ok(html.includes(USAGE.externalPrompt.slice(0, 20)), '提示词模板上卡（白名单字段）');
  assert.ok(html.includes('已经过 8 个人，下一棒交给谁？'), '链文案');
  assert.ok(html.includes('传给'), '传给 label');
  assert.ok(html.includes('生成链接'), '链接 picker');
  assert.ok(html.includes('安静的湖') && html.includes('妈妈') && html.includes('课题组'), '三个候选都在');
  assert.ok(html.includes('🔒 对方只看到用法和提示词。TA 学会后'), '隐私注（原型钉死）');
  assert.ok(html.includes('你的传棒 +1'), '隐私注后半句');
  assert.ok(html.includes('传给 安静的湖'), '大按钮跟随选择');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1, '只有选中项 aria-pressed=true');
  assert.ok(html.includes('data-send="1"'), '发送按钮');
  assert.ok(html.includes('data-target="pair-2"') && html.includes('data-link="1"'));
  // 链上最多 5 跳：被裁掉的头 3 个别名不得出现。
  // （安静的湖被裁掉但它同时是候选目标，不参与此断言。）
  assert.ok(!html.includes('晨风的信'), '第 1 跳被裁掉');
  assert.ok(!html.includes('远山的松'), '第 3 跳被裁掉');
});

test('sendSheetView：链接模式大按钮切换；非法卡 → 空串', () => {
  const html = sendSheetView({ targetId: null, linkMode: true }, { card: buildBatonCard(USAGE), chain: [], targets: TARGETS });
  assert.ok(html.includes(BATON_UI_STRINGS_ZH.copyLinkButton));
  assert.ok(html.includes('第一棒交给谁？'), '空链文案');
  assert.equal(sendSheetView(initialSendState(TARGETS), { card: null, chain: [], targets: TARGETS }), '');
  assert.equal(sendSheetView(initialSendState(TARGETS), { card: { usageId: 'x' }, chain: [], targets: TARGETS }), '');
});

test('sendSheetView：XSS —— 化名/标题/模板里的 HTML 一律转义', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const targets = [{ id: 'pair-9', kind: 'pair', alias: evil, avatarColor: '#4C7A93' }];
  const html = sendSheetView(initialSendState(targets), { card: buildBatonCard(USAGE), chain: [evil], targets });
  assert.ok(!html.includes('<img src=x'), '未转义的标签不得出现');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const evilCard = validateBatonCard({ usageId: 'evil-title', scenarioTitle: evil, promptTemplate: USAGE.externalPrompt });
  const html2 = sendSheetView(initialSendState([]), { card: evilCard, chain: [], targets: [] });
  assert.ok(!html2.includes('<img src=x'));
  assert.ok(html2.includes('&lt;img'));
});

// ---- 接收方（§4.8 打开即试用，访客可用）--------------------------------------

test('buildTryPrompt：接收方材料注入材料槽，前 200 字封顶（relay 同规）', () => {
  const card = buildBatonCard(USAGE);
  const prompt = buildTryPrompt(card, '这是一段论文摘要……');
  assert.ok(prompt.includes('这是一段论文摘要……'));
  assert.ok(!prompt.includes('{{material}}'), '槽已被填充');
  const long = '字'.repeat(500);
  const capped = buildTryPrompt(card, long);
  assert.ok(capped.includes('字'.repeat(200)), '材料最多带 200 字');
  assert.ok(!capped.includes('字'.repeat(201)));
  assert.ok(buildTryPrompt(card, '').endsWith('……'), '空材料用占位符');
  assert.equal(buildTryPrompt(null, 'x'), null);
  assert.equal(buildTryPrompt({ junk: 1 }, 'x'), null);
  const slotless = { usageId: 'slotless', scenarioTitle: '无槽用法', promptTemplate: '固定提示词' };
  assert.ok(buildTryPrompt(slotless, '材料').includes('材料'), '无槽模板把材料附在后面');
});

test('receiverCardView：访客可用 —— 试用法区 + 材料只在本机 + 试完才引导注册', () => {
  const card = buildBatonCard(USAGE);
  const html = receiverCardView(card, { chain: CHAIN_8.slice(0, 3) });
  assert.ok(html.includes('读懂一篇论文'));
  assert.ok(html.includes(USAGE.externalPrompt.slice(0, 20)));
  assert.ok(html.includes('这个用法经过了 3 个人'));
  assert.ok(html.includes('现在就试这个用法'), '§4.8 打开即试用');
  assert.ok(html.includes('data-material'), '材料输入');
  assert.ok(html.includes('data-try-copy'), '复制提示词按钮');
  assert.ok(!html.includes('登录') || html.indexOf('登录') > html.indexOf('data-try-copy'), '注册引导在试用之后（试完再引导）');
  assert.ok(receiverCardView(card, { chain: [], copied: true }).includes('✓'), '复制后出现完成态');
  assert.equal(receiverCardView(null, {}), '');
});

test('receiverCardView：XSS —— 卡内容与化名转义；无账号字段', () => {
  const evil = '<svg onload=alert(1)>';
  const html = receiverCardView(buildBatonCard(USAGE), { chain: [evil] });
  assert.ok(!html.includes('<svg onload'));
  assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'));
  assert.ok(!html.includes('fromAccount'), '接收方视图不含发送者账号');
  assert.ok(!html.includes('apiKey') && !html.toLowerCase().includes('password'));
});

// ---- mount：发送弹层（v1 view()/onclick 委托模式）---------------------------

test('mountSendSheet：选人/选链接切换重渲，发送产出合法 share + sent 事件', async () => {
  const target = { innerHTML: '', onclick: null };
  const sends = [];
  const events = [];
  const clipboard = [];
  const ctrl = mountSendSheet(target, {
    usage: USAGE, fromAccount: 'acc-a', chain: CHAIN_8, targets: TARGETS,
    batonId: 'baton-mount-1', root: makeRoot(clipboard),
    onSend: (out) => sends.push(out),
    onEvent: (ev) => events.push(ev),
  });
  assert.ok(target.innerHTML.includes('传给 安静的湖'));
  target.onclick({ target: el({ 'data-target': 'circle-1' }) });
  assert.ok(target.innerHTML.includes('传给 课题组'));
  assert.equal((target.innerHTML.match(/aria-pressed="true"/g) || []).length, 1);

  await target.onclick({ target: el({ 'data-send': '1' }) });
  assert.equal(sends.length, 1);
  assert.ok(validateBatonShare(sends[0].share), 'onSend 交出的 share 必须过契约');
  assert.equal(sends[0].share.targetKind, 'circle');
  assert.equal(sends[0].share.targetId, 'circle-1');
  assert.equal(sends[0].share.fromAccount, 'acc-a');
  assert.ok(validateBatonEvent(sends[0].event) && sends[0].event.kind === 'sent');
  assert.deepEqual(events, [sends[0].event], 'onEvent 收到同一 sent 事件');

  target.onclick({ target: el({ 'data-link': '1' }) });
  assert.ok(target.innerHTML.includes(BATON_UI_STRINGS_ZH.copyLinkButton));
  await target.onclick({ target: el({ 'data-send': '1' }) });
  assert.equal(sends.length, 2);
  assert.equal(sends[1].share.targetKind, 'link');
  assert.equal(sends[1].share.targetId, null);
  assert.equal(sends[1].link.href, '#/social/baton/baton-mount-1', '链接只含路由+id');
  assert.equal(sends[1].link.copied, true, '复制走了注入的 clipboard');
  assert.deepEqual(clipboard, ['#/social/baton/baton-mount-1'], '剪贴板里只有链接，没有任何卡内容');
  assert.ok(validateBatonEvent(sends[1].event) && sends[1].event.kind === 'sent');
  assert.deepEqual(ctrl.state(), { targetId: null, linkMode: true });

  ctrl.unmount();
  assert.equal(target.onclick, null);
});

test('mountSendSheet：scrim/关闭回调；缺卡渲染空但仍可控', () => {
  const target = { innerHTML: '', onclick: null };
  let closed = 0;
  mountSendSheet(target, { usage: null, fromAccount: 'acc-a', targets: TARGETS, onClose: () => { closed += 1; } });
  assert.equal(target.innerHTML, '');
  target.onclick({ target: el({ 'data-close': '1' }) });
  assert.equal(closed, 1);
});

// ---- mount：接收方（opened 一次、复制、完成接力、引导注册）-------------------

test('mountReceiver：挂载即 opened 一次；复制带材料；完成接力与注册回调只在试后出现', async () => {
  const target = {
    innerHTML: '', onclick: null,
    querySelector: (sel) => (sel === '[data-material]' ? { value: '我的论文摘要' } : null),
  };
  const copied = [];
  const opened = [];
  const dones = [];
  const registers = [];
  const ctrl = mountReceiver(target, {
    card: buildBatonCard(USAGE), chain: ['远山的松'],
    batonId: 'baton-r-1', viewerAccount: 'guest-1',
    root: makeRoot(copied),
    onOpened: (ev) => opened.push(ev),
    onRelayComplete: (ev) => dones.push(ev),
    onRegister: () => registers.push(1),
  });
  assert.equal(opened.length, 1, 'opened 恰好一次');
  assert.ok(validateBatonEvent(opened[0]) && opened[0].kind === 'opened');
  assert.ok(target.innerHTML.includes('现在就试这个用法'));

  await target.onclick({ target: el({ 'data-try-copy': '1' }) });
  assert.equal(copied.length, 1);
  assert.ok(copied[0].includes('我的论文摘要'), '复制内容带上接收方自己的材料');
  assert.ok(copied[0].includes(USAGE.externalPrompt.slice(0, 12)));
  assert.ok(!copied[0].includes('{{material}}'));
  assert.equal(opened.length, 1, '重渲不再触发 opened');
  assert.equal(registers.length, 0, '试之前不引导注册');

  assert.ok(target.innerHTML.includes('✓'), '复制后出现完成接力入口');
  target.onclick({ target: el({ 'data-relay-done': '1' }) });
  assert.equal(dones.length, 1);
  assert.ok(validateBatonEvent(dones[0]) && dones[0].kind === 'relay-completed');

  target.onclick({ target: el({ 'data-register': '1' }) });
  assert.equal(registers.length, 1);
  assert.deepEqual(ctrl.state(), { copied: true, opened: true });
  ctrl.unmount();
  assert.equal(target.onclick, null);
});

test('mountReceiver：无 root/无回调也安全（访客无账号可用，零异常）', async () => {
  const target = { innerHTML: '', onclick: null, querySelector: () => ({ value: '' }) };
  mountReceiver(target, { card: buildBatonCard(USAGE) });
  assert.ok(target.innerHTML.includes('读懂一篇论文'));
  await target.onclick({ target: el({ 'data-try-copy': '1' }) }); // 复制失败也不抛
  assert.ok(target.innerHTML.length > 0);
});
