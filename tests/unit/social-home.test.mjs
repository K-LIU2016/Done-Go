import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// S5同频页 line: web/social/home.js + web/social/social.css render PRD §4.1/§4.2
// 同频首页（流派卡 + 同频推荐 3 人 + 加油 + 结为搭档）. Visual contract source:
// design/social-sync/prototype.html ① 同频首页 — markup uses the prototype class
// names verbatim (top/me/sub/arch/bot/share/sec/match/mh/av/sim/why/uses/acts/
// b cheer/b pair). Data shapes come exclusively from web/social/contracts.js
// (STYLES, MATCHES_PER_WEEK, MAX_PAIRS, validateStyleCard, validateMatch …) —
// never redefined here. The render layer re-validates every record and enforces
// the D4「略多一点」boundary (isSlightlyAhead via validateMatch context), so an
// out-of-boundary recommendation can never be painted.

import {
  STYLES, STYLE_IDS, STYLE_EVIDENCE_MAX, MATCHES_PER_WEEK, MATCH_REASON_MAX,
  MATCH_RECENT_USAGES_MAX, MAX_PAIRS,
  validateStyleCard, validateMatch, isSlightlyAhead,
} from '../../web/social/contracts.js';
import {
  SOCIAL_HOME_COPY, STYLE_CHARS,
  styleById, weekNumber, weekLabel, aliasBadge, similarityLabel,
  mixWhite, mascotColor, styleGradient, buildStyleCard, usageChips, aheadNote,
  matchView, kudosState, pairState, inviteNeeded, kudosNote, pairNote,
  socialHomeView, createSocialHome,
} from '../../web/social/home.js';

// ---------------------------------------------------------------------------
// Fixtures — every record passes the contracts validators so the fixtures prove
// home.js consumes real contract output, not a private shape.
// ---------------------------------------------------------------------------
const RAW_CARD = {
  style: 'night-creator', week: '2026-W43',
  evidence: ['58% 的事在晚上 9 点后开始', '创作类的事占了 41%', '学会 2 个新用法，自己做到 1 次'],
};
assert.ok(validateStyleCard(RAW_CARD), 'fixture style card must satisfy contracts');
assert.equal(RAW_CARD.evidence.length, STYLE_EVIDENCE_MAX);

const MY_GRADUATIONS = 2; // 对方 3/4 都满足「略多一点」：≥2 且 ≤ 2*2+2

function mkMatch(over = {}) {
  const base = {
    alias: '安静的湖', avatarColor: '#4C7A93', style: 'night-creator',
    similarity: 0.86, theirGraduations: 3,
    reasons: ['你们都在晚上 10 点后写东西', '都把空出来的时间给了运动'],
    recentUsages: ['paper-5points', 'abstract-en'],
    ...over,
  };
  assert.ok(validateMatch(base, { myGraduations: MY_GRADUATIONS }), 'fixture match must satisfy contracts validateMatch');
  return base;
}

const MATCH2 = mkMatch({
  alias: '远山的松', avatarColor: '#615CED', style: 'academic-climber',
  similarity: 0.79, theirGraduations: 4,
  reasons: ['你们都常用「读懂论文」', '都在组会前一晚最忙'],
  recentUsages: [], // 原型①第二张卡没有用法行
});

const TITLES = { 'paper-5points': '长文 → 5 个要点', 'abstract-en': '摘要翻成英文', 'paper-read': '读懂一篇论文' };

function viewState(over = {}) {
  return {
    me: { alias: '山间的风' },
    styleCard: RAW_CARD,
    matches: [mkMatch(), MATCH2],
    myGraduations: MY_GRADUATIONS,
    usageTitles: TITLES,
    kudosGiven: {},
    pairedAliases: {},
    pairsCount: 0,
    note: '',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — 流派 meta / 周 / 化名 / 相似度.
// ---------------------------------------------------------------------------
test('styleById returns the contracts STYLES entry verbatim, unknown id → null', () => {
  const night = styleById('night-creator');
  assert.deepEqual(night, STYLES.find((s) => s.id === 'night-creator'));
  assert.equal(night.label, '深夜创作派');
  assert.equal(night.motto, '灯熄了，你的想法才刚开始。');
  assert.equal(night.color, '#4C7A93');
  assert.equal(styleById('nope'), null);
  assert.equal(styleById(null), null);
});

test('STYLE_CHARS covers every contracts style (avatar 字：原型①用夜、原型②链上用晨)', () => {
  assert.deepEqual(Object.keys(STYLE_CHARS).sort(), [...STYLE_IDS].sort());
  assert.equal(STYLE_CHARS['night-creator'], '夜');
  assert.equal(STYLE_CHARS['morning-sorter'], '晨');
});

test('weekNumber/weekLabel parse ISO weeks the prototype way（第 43 周）', () => {
  assert.equal(weekNumber('2026-W43'), 43);
  assert.equal(weekLabel('2026-W43'), '第 43 周');
  assert.equal(weekLabel('2026-W01'), '第 1 周');
  assert.equal(weekNumber('2026-W00'), null); // 契约周正则本就不放行，双保险
  assert.equal(weekNumber('2026-W54'), null);
  assert.equal(weekLabel('nope'), '');
  assert.equal(weekLabel(42), '');
});

test('aliasBadge takes the LAST character（自然物：原型①湖、原型③组/妈，PRD §5 形容词+自然物）', () => {
  assert.equal(aliasBadge('安静的湖'), '湖');
  assert.equal(aliasBadge('远山的松'), '松');
  assert.equal(aliasBadge('  妈妈'), '妈');
  assert.equal(aliasBadge('课题组'), '组');
  assert.equal(aliasBadge('𝕏file'), 'e'); // 代理对安全：取最后一个码点
  assert.equal(aliasBadge(''), '');
  assert.equal(aliasBadge(null), '');
});

test('similarityLabel formats 同频 N% with rounding and clamping', () => {
  assert.equal(similarityLabel(0.86), '同频 86%');
  assert.equal(similarityLabel(0.79), '同频 79%');
  assert.equal(similarityLabel(0.869), '同频 87%');
  assert.equal(similarityLabel(1), '同频 100%');
  assert.equal(similarityLabel(1.2), '同频 100%'); // 契约上限 1，渲染层再夹一次
  assert.equal(similarityLabel(0), '同频 0%');
  assert.equal(similarityLabel(-0.5), '同频 0%');
  assert.equal(similarityLabel(Number.NaN), '同频 0%');
});

// ---------------------------------------------------------------------------
// 流派卡视觉推导 — 原型①深夜创作派的渐变/吉祥物色逐字对齐，其余流派按
// 同公式推导并保证白字对比度（浅色流派自动加深）。
// ---------------------------------------------------------------------------
test('mixWhite/darken math pins the tint formulas', () => {
  assert.equal(mixWhite('#4C7A93', 0.55), '#AEC3CE');
  assert.equal(mixWhite('#000000', 0), '#000000');
  assert.equal(mixWhite('#000000', 1), '#FFFFFF');
  assert.equal(mixWhite('bad', 0.5), '');
});

test('styleGradient/mascotColor copy the prototype ① 深夜创作派 values verbatim', () => {
  assert.equal(styleGradient('night-creator'), 'linear-gradient(135deg,#3B6A82,#24475A)');
  assert.equal(mascotColor('night-creator'), '#9FC6DA');
});

test('styleGradient derives dark 135° gradients for the other styles with WCAG-safe white text', () => {
  const stopsOf = (id) => {
    const m = /^linear-gradient\(135deg,(#[0-9A-F]{6}),(#[0-9A-F]{6})\)$/.exec(styleGradient(id));
    assert.ok(m, id + ' gradient must be linear-gradient(135deg,#RRGGBB,#RRGGBB), got ' + styleGradient(id));
    return [m[1], m[2]];
  };
  for (const style of STYLES) {
    if (style.id === 'night-creator') continue; // 原型逐字档
    const [light, dark] = stopsOf(style.id);
    for (let c = 0; c < 3; c += 1) {
      assert.ok(parseInt(dark.slice(1 + c * 2, 3 + c * 2), 16) <= parseInt(light.slice(1 + c * 2, 3 + c * 2), 16), style.id + ' 深色档必须更深');
    }
    assert.ok(contrast('#FFFFFF', light) >= 3, style.id + ' 浅档白字 ≥3:1（流派名 26px 大字）, got ' + contrast('#FFFFFF', light).toFixed(2));
    assert.ok(contrast('#FFFFFF', dark) >= 4.5, style.id + ' 深档白字 ≥4.5:1（证据小字区）, got ' + contrast('#FFFFFF', dark).toFixed(2));
  }
  assert.equal(styleGradient('nope'), '');
  assert.equal(mascotColor('nope'), '');
});

test('buildStyleCard validates via contracts and merges STYLES meta (label/motto/color)', () => {
  const card = buildStyleCard(RAW_CARD);
  assert.deepEqual(card, {
    week: '2026-W43', styleId: 'night-creator', label: '深夜创作派',
    motto: '灯熄了，你的想法才刚开始。', color: '#4C7A93',
    evidence: RAW_CARD.evidence,
  });
  assert.equal(buildStyleCard({ ...RAW_CARD, evidence: RAW_CARD.evidence.concat(['第 4 条']) }), null); // > STYLE_EVIDENCE_MAX
  assert.equal(buildStyleCard({ ...RAW_CARD, style: 'nope' }), null);
  assert.equal(buildStyleCard({ ...RAW_CARD, week: '2026-43' }), null);
  assert.equal(buildStyleCard(null), null);
});

// ---------------------------------------------------------------------------
// 同频推荐 — D4「略多一点」在渲染层再次强制；理由粗粒度；用法片条走标题映射。
// ---------------------------------------------------------------------------
test('usageChips maps known usage ids to titles, skips unknown, caps at MATCH_RECENT_USAGES_MAX', () => {
  assert.deepEqual(usageChips(['paper-5points', 'abstract-en'], TITLES), [
    { usageId: 'paper-5points', title: '长文 → 5 个要点' },
    { usageId: 'abstract-en', title: '摘要翻成英文' },
  ]);
  assert.deepEqual(usageChips(['ghost-id', 'paper-read'], TITLES), [{ usageId: 'paper-read', title: '读懂一篇论文' }]);
  assert.deepEqual(usageChips(['paper-5points', 'abstract-en', 'paper-read'], TITLES).length, MATCH_RECENT_USAGES_MAX);
  assert.deepEqual(usageChips(['paper-5points'], {}), []); // 无标题映射 → 整行不渲染的依据
  assert.deepEqual(usageChips(null, TITLES), []);
});

test('aheadNote explains「略多一点」in coarse language only', () => {
  assert.equal(aheadNote(2, 3), 'TA 比你多做到 1 次，刚好够一够');
  assert.equal(aheadNote(2, 4), 'TA 比你多做到 2 次，刚好够一够');
  assert.equal(aheadNote(3, 3), 'TA 和你做到的一样多'); // 契约下限 = 与你相同
  assert.equal(aheadNote(null, 3), '');
  assert.equal(aheadNote(2, null), '');
});

test('matchView validates through contracts (D4 略多一点) and builds the card view model', () => {
  const view = matchView(mkMatch(), { myGraduations: MY_GRADUATIONS }, TITLES);
  assert.deepEqual(
    {
      alias: view.alias, initial: view.initial, avatarColor: view.avatarColor,
      styleId: view.styleId, styleLabel: view.styleLabel, graduationsNote: view.graduationsNote,
      similarityLabel: view.similarityLabel, theirGraduations: view.theirGraduations,
      reasons: view.reasons, chips: view.chips, ahead: view.ahead,
    },
    {
      alias: '安静的湖', initial: '湖', avatarColor: '#4C7A93',
      styleId: 'night-creator', styleLabel: '深夜创作派',
      graduationsNote: '深夜创作派 · 自己做到 3 次',
      similarityLabel: '同频 86%', theirGraduations: 3,
      reasons: ['你们都在晚上 10 点后写东西', '都把空出来的时间给了运动'],
      chips: [{ usageId: 'paper-5points', title: '长文 → 5 个要点' }, { usageId: 'abstract-en', title: '摘要翻成英文' }],
      ahead: 'TA 比你多做到 1 次，刚好够一够',
    },
  );
  // 无 myGraduations 上下文时仍可渲染，只是没有 ahead 行
  assert.equal(matchView(mkMatch(), {}, TITLES).ahead, '');
  // 越界：比你少 / 超过你的 2 倍加 2 → 渲染层直接拒绝（D4）
  // （越界记录在合法 fixture 上覆盖而来，不走 mkMatch 的合法性断言）
  assert.equal(matchView({ ...mkMatch(), theirGraduations: 1 }, { myGraduations: MY_GRADUATIONS }, TITLES), null);
  assert.equal(matchView({ ...mkMatch(), theirGraduations: 50 }, { myGraduations: MY_GRADUATIONS }, TITLES), null);
  assert.equal(isSlightlyAhead(MY_GRADUATIONS, 50), false); // 契约判定与本视图一致
  // 坏记录 → null
  assert.equal(matchView({ alias: '', avatarColor: '#4C7A93', style: 'night-creator', similarity: 0.5, theirGraduations: 3, reasons: ['x'], recentUsages: [] }, {}, TITLES), null);
  assert.equal(matchView({ ...mkMatch(), reasons: ['a', 'b', 'c'] }, {}, TITLES), null); // > MATCH_REASON_MAX
});

test('kudosState/pairState drive the two match-card buttons, MAX_PAIRS from contracts', () => {
  assert.deepEqual(kudosState(false), { done: false, label: '♥ 加油', disabled: false });
  assert.deepEqual(kudosState(true), { done: true, label: '已加油 ♥', disabled: true });
  assert.equal(MAX_PAIRS, 5); // PRD §4.5 最多 5 位搭档
  assert.deepEqual(pairState({ paired: false, pairsCount: 0 }), { done: false, label: '结为搭档', disabled: false });
  assert.deepEqual(pairState({ paired: true, pairsCount: 1 }), { done: true, label: '已是搭档', disabled: true });
  assert.deepEqual(pairState({ paired: false, pairsCount: MAX_PAIRS }), { done: false, label: '搭档已满 5 位', disabled: true });
  assert.deepEqual(pairState({}), { done: false, label: '结为搭档', disabled: false });
  assert.equal(kudosNote('安静的湖'), '已给 安静的湖 加油');
  assert.equal(pairNote('安静的湖'), '和 安静的湖 结为搭档啦');
});

test('inviteNeeded follows PRD 冷启动：不足 MATCHES_PER_WEEK 人就引导邀请，不造假人', () => {
  assert.equal(MATCHES_PER_WEEK, 3);
  assert.equal(inviteNeeded([]), true);
  assert.equal(inviteNeeded([mkMatch(), MATCH2]), true);
  assert.equal(inviteNeeded([mkMatch(), MATCH2, mkMatch({ alias: '晨跑的鹿', avatarColor: '#E8B04B', style: 'morning-sorter', similarity: 0.71, theirGraduations: 2 })]), false);
  assert.equal(inviteNeeded(null), true);
});

// ---------------------------------------------------------------------------
// socialHomeView — pure render must match prototype ① markup and copy.
// ---------------------------------------------------------------------------
test('socialHomeView renders the prototype ① top/sub/流派卡 with exact copy and 3 evidence lines', () => {
  const view = socialHomeView(viewState());
  assert.match(view, /<h1>同频<\/h1>/);
  assert.match(view, /<p class="sub">第 43 周 · 根据你怎么用 AI、怎么分配空出来的时间<\/p>/);
  assert.match(view, /<small>本周你的时间流派<\/small><h2>深夜创作派<\/h2><p>灯熄了，你的想法才刚开始。<\/p>/);
  assert.match(view, /class="arch" style="background:linear-gradient\(135deg,#3B6A82,#24475A\)"/);
  assert.match(view, /<svg class="bot" style="color:#9FC6DA" aria-hidden="true"><use href="#soc-bot"\/><\/svg>/);
  assert.equal((view.match(/<li>/g) || []).length, STYLE_EVIDENCE_MAX); // 流派卡三条证据
  assert.match(view, /<li>58% 的事在晚上 9 点后开始<\/li>/);
  assert.match(view, /<li>学会 2 个新用法，自己做到 1 次<\/li>/);
  assert.match(view, /class="share" data-share aria-label="生成本周流派分享图">生成分享图<\/button>/);
  // me 头像 = 本人流派色 + 流派字（原型①：夜）
  assert.match(view, /<span class="me" style="background:#4C7A93" aria-hidden="true">夜<\/span>/);
  // 吉祥物 sprite 恰好注入一次
  assert.equal((view.match(/<symbol id="soc-bot"/g) || []).length, 1);
});

test('socialHomeView renders the two prototype match cards: alias/流派·次数/同频%/理由/用法/按钮', () => {
  const view = socialHomeView(viewState());
  assert.match(view, /<div class="sec"><h3>本周和你同频<\/h3><span>每周一更新<\/span><\/div>/);
  assert.match(view, /<span class="av" style="background:#4C7A93" aria-hidden="true">湖<\/span>/);
  assert.match(view, /<b>安静的湖<\/b><small>深夜创作派 · 自己做到 3 次<\/small>/);
  assert.match(view, /<span class="sim">同频 86%<\/span>/);
  assert.match(view, /<p class="why"><b>你们都在晚上 10 点后写东西<\/b>，<b>都把空出来的时间给了运动<\/b>。<\/p>/);
  assert.equal((view.match(/<div class="uses">/g) || []).length, 1); // 原型第二张卡没有用法行
  assert.match(view, /<div class="uses"><span>长文 → 5 个要点<\/span><span>摘要翻成英文<\/span><\/div>/);
  assert.match(view, /<button type="button" class="b cheer" data-kudos="安静的湖" aria-label="给 安静的湖 加油">♥ 加油<\/button>/);
  assert.match(view, /<button type="button" class="b pair" data-pair="安静的湖" aria-label="和 安静的湖 结为搭档">结为搭档<\/button>/);
  assert.match(view, /<b>远山的松<\/b><small>学术攀登派 · 自己做到 4 次<\/small>/);
  assert.match(view, /<span class="sim">同频 79%<\/span>/);
});

test('socialHomeView carries the「略多一点」reason line on every match card (D4)', () => {
  const view = socialHomeView(viewState());
  assert.match(view, /<p class="ahead">TA 比你多做到 1 次，刚好够一够<\/p>/);
  assert.match(view, /<p class="ahead">TA 比你多做到 2 次，刚好够一够<\/p>/);
  const noCtx = socialHomeView(viewState({ myGraduations: null }));
  assert.equal(noCtx.includes('class="ahead"'), false); // 没有本人次数就不编理由
});

test('socialHomeView drops out-of-boundary matches instead of painting them (D4 渲染层)', () => {
  const cheater = { ...mkMatch(), alias: '超远的星', theirGraduations: 50 };
  assert.equal(validateMatch(cheater, { myGraduations: MY_GRADUATIONS }), null); // 契约先拒绝
  const view = socialHomeView(viewState({ matches: [cheater, mkMatch()] }));
  assert.equal(view.includes('超远的星'), false);
  assert.match(view, /安静的湖/);
});

test('socialHomeView shows the PRD invite line when fewer than 3 matches, hides it at 3', () => {
  const two = socialHomeView(viewState());
  assert.match(two, /class="invite" data-invite>邀请同学加入，一起找同频<\/button>/);
  const three = socialHomeView(viewState({ matches: [mkMatch(), MATCH2, mkMatch({ alias: '晨跑的鹿', avatarColor: '#E8B04B', style: 'morning-sorter', similarity: 0.71, theirGraduations: 2 })] }));
  assert.equal(three.includes('data-invite'), false);
});

test('socialHomeView button states: 已加油 / 已是搭档 / 搭档已满', () => {
  const cheered = socialHomeView(viewState({ kudosGiven: { 安静的湖: true } }));
  assert.match(cheered, /class="b cheer did" data-kudos="安静的湖"[^>]*disabled>已加油 ♥<\/button>/);
  assert.match(cheered, /data-pair="安静的湖" aria-label="和 安静的湖 结为搭档">结为搭档/); // 加油不影响搭档按钮
  const paired = socialHomeView(viewState({ pairedAliases: { 安静的湖: true } }));
  assert.match(paired, /class="b pair did" data-pair="安静的湖"[^>]*disabled>已是搭档<\/button>/);
  const full = socialHomeView(viewState({ pairsCount: MAX_PAIRS }));
  assert.match(full, /class="b pair full"[^>]*disabled>搭档已满 5 位<\/button>/);
  assert.equal(full.includes('>结为搭档</button>'), false);
});

test('socialHomeView pending 流派卡（原型未覆盖态）与 status note', () => {
  const pending = socialHomeView(viewState({ styleCard: null }));
  assert.equal(pending.includes('class="arch"'), false);
  assert.match(pending, /class="pending">本周流派还没算好，完成几次接力就有了<\/p>/);
  assert.match(pending, /<p class="sub">根据你怎么用 AI、怎么分配空出来的时间<\/p>/); // 无周号前缀
  assert.equal(pending.includes('#soc-bot'), false); // 没有流派卡就不注入 sprite
  const noted = socialHomeView(viewState({ note: '已给 安静的湖 加油' }));
  assert.match(noted, /<p class="soc-note" role="status">已给 安静的湖 加油<\/p>/);
});

test('socialHomeView escapes every dynamic string (XSS never re-enters as markup)', () => {
  const evil = viewState({
    me: { alias: '<b>我' },
    matches: [mkMatch({
      alias: '<b>攻&击',
      reasons: ['<img src=x onerror=alert(1)>'],
      recentUsages: [],
    })],
    note: '<script>bad()</script>',
  });
  assert.ok(validateMatch(evil.matches[0], { myGraduations: MY_GRADUATIONS }), '契约本不限制化名字符，转义责任在渲染层');
  const view = socialHomeView(evil);
  assert.equal(view.includes('<b>攻&击'), false);
  assert.match(view, /&lt;b&gt;攻&amp;击/);
  assert.equal(view.includes('<img src=x'), false);
  assert.match(view, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(view.includes('<script>'), false);
});

// ---------------------------------------------------------------------------
// Controller — mount wiring on a minimal element stub (click delegation only).
// ---------------------------------------------------------------------------
function makeEl() {
  const el = {
    handlers: {}, html: '',
    addEventListener(type, handler) { (el.handlers[type] ||= []).push(handler); },
    set innerHTML(v) { el.html = v; },
    get innerHTML() { return el.html; },
    contains() { return true; },
  };
  return el;
}
function fire(el, type, target, extra = {}) {
  const event = { type, target, ...extra };
  for (const handler of el.handlers[type] || []) handler(event);
  return event;
}
function node(attrs) {
  const self = { getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null), closest: () => self };
  return self;
}

test('controller: mount renders ① and 加油 is one-click with optimistic state + note', () => {
  const el = makeEl();
  const calls = { metric: [], kudos: [] };
  const home = createSocialHome({
    styleCard: RAW_CARD, matches: [mkMatch(), MATCH2], myGraduations: MY_GRADUATIONS,
    usageTitles: TITLES,
    onMetric: (n) => calls.metric.push(n),
    onKudos: (m) => calls.kudos.push(m),
  });
  home.mount(el);
  assert.match(el.html, /安静的湖/);
  assert.deepEqual(home.kudosGiven(), {});
  assert.equal(home.pairsCount(), 0);

  fire(el, 'click', node({ 'data-kudos': '安静的湖' }));
  assert.equal(calls.kudos.length, 1);
  assert.equal(calls.kudos[0].alias, '安静的湖');
  assert.equal(calls.kudos[0].styleLabel, '深夜创作派'); // 回调拿到完整视图模型
  assert.deepEqual(calls.metric, ['social_kudos']);
  assert.match(el.html, /已加油 ♥/); // 乐观更新
  assert.match(el.html, /<p class="soc-note" role="status">已给 安静的湖 加油<\/p>/);
  assert.deepEqual(home.kudosGiven(), { 安静的湖: true });

  fire(el, 'click', node({ 'data-kudos': '安静的湖' })); // 重复点击不重复发
  assert.equal(calls.kudos.length, 1);
  home.unmount();
});

test('controller: 结为搭档 records the pair, respects MAX_PAIRS and re-点击', () => {
  const el = makeEl();
  const pairs = [];
  const home = createSocialHome({
    styleCard: RAW_CARD, matches: [mkMatch()], myGraduations: MY_GRADUATIONS,
    onPair: (m) => pairs.push(m.alias),
  });
  home.mount(el);
  fire(el, 'click', node({ 'data-pair': '安静的湖' }));
  assert.deepEqual(pairs, ['安静的湖']);
  assert.equal(home.pairsCount(), 1);
  assert.match(el.html, /已是搭档/);
  fire(el, 'click', node({ 'data-pair': '安静的湖' }));
  assert.deepEqual(pairs, ['安静的湖']); // 已是搭档不再发

  const fullEl = makeEl();
  const full = createSocialHome({
    styleCard: RAW_CARD, matches: [mkMatch()], myGraduations: MY_GRADUATIONS, pairsCount: MAX_PAIRS,
    onPair: () => assert.fail('搭档已满不得再发'),
  });
  full.mount(fullEl);
  assert.match(fullEl.html, /搭档已满 5 位/);
  fire(fullEl, 'click', node({ 'data-pair': '安静的湖' }));
});

test('controller: 生成分享图/邀请 emit with payload; update() re-renders; unmount freezes', () => {
  const el = makeEl();
  const calls = { share: [], invite: [], metric: [] };
  const home = createSocialHome({
    styleCard: RAW_CARD, matches: [mkMatch()], myGraduations: MY_GRADUATIONS,
    onMetric: (n) => calls.metric.push(n),
    onShare: (card) => calls.share.push(card),
    onInvite: () => calls.invite.push(1),
  });
  home.mount(el);
  fire(el, 'click', node({ 'data-share': '' }));
  assert.equal(calls.share.length, 1);
  assert.equal(calls.share[0].label, '深夜创作派'); // 分享图线拿到 buildStyleCard 输出
  assert.equal(calls.share[0].evidence.length, 3);
  fire(el, 'click', node({ 'data-invite': '' }));
  assert.deepEqual(calls.invite, [1]);
  assert.deepEqual(calls.metric, ['social_share', 'social_invite']);

  home.update({ matches: [MATCH2] });
  assert.match(el.html, /远山的松/);
  assert.equal(el.html.includes('安静的湖'), false);

  home.unmount();
  fire(el, 'click', node({ 'data-share': '' }));
  assert.equal(calls.share.length, 1); // unmount 后不再响应
});

test('controller: 越界推荐进不了快照，也无从加油（D4）', () => {
  const el = makeEl();
  const home = createSocialHome({
    styleCard: RAW_CARD,
    matches: [{ ...mkMatch(), alias: '超远的星', theirGraduations: 50 }, mkMatch()],
    myGraduations: MY_GRADUATIONS,
    onKudos: () => assert.fail('越界用户不可交互'),
  });
  home.mount(el);
  assert.equal(el.html.includes('超远的星'), false);
  fire(el, 'click', node({ 'data-kudos': '超远的星' })); // 无此视图 → 忽略
});

// ---------------------------------------------------------------------------
// social.css — token 化 + 五种外观映射 + 作用域隔离（照 rv2-shell 先例）。
// ---------------------------------------------------------------------------
const cssPath = fileURLToPath(new URL('../../web/social/social.css', import.meta.url));
const cssText = readFileSync(cssPath, 'utf8');

function cssWithoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
const cssFlat = cssWithoutComments(cssText);

function cssSelectors() {
  const out = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(cssFlat))) {
    const sel = m[1].trim();
    if (sel) out.push(sel);
  }
  return out;
}

function ruleBody(selectorPiece) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssFlat))) {
    const parts = m[1].split(',').map((p) => p.trim());
    const hit = parts.some((p) => p === selectorPiece || p.endsWith(' ' + selectorPiece));
    if (hit) return m[2];
  }
  return null;
}

function tokenMap(blockText) {
  const map = {};
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(blockText))) map[m[1].trim()] = m[2].trim();
  return map;
}

function scopeBlock(prefix) {
  const at = cssFlat.indexOf(prefix);
  assert.notEqual(at, -1, 'social.css must contain ' + prefix + ' token block');
  const open = cssFlat.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < cssFlat.length; i += 1) {
    if (cssFlat[i] === '{') depth += 1;
    else if (cssFlat[i] === '}') {
      depth -= 1;
      if (depth === 0) return tokenMap(cssFlat.slice(open + 1, i));
    }
  }
  throw new Error('unbalanced block for ' + prefix);
}

const SPEC_TOKENS = { // relay-v2 SPEC §3 定稿值（与 web/relay/relay.css .rv2 相同）
  '--bg': '#FAF8F3', '--surface': '#FFFFFF', '--sunk': '#F3F0E8', '--ink': '#252722', '--ink2': '#64665D', '--ink3': '#8E9086', '--line': '#E4E2D8',
  '--brand': '#E95432', '--brand-ink': '#FFFFFF', '--brand-soft': '#FDECE6',
  '--forest': '#335D4B', '--forest-soft': '#E7F0EA', '--gold': '#E8B04B', '--gold-soft': '#FBF1DC',
  '--ok': '#2F7D57', '--warn': '#B7791F', '--err': '#B4432F',
  '--r-lg': '20px', '--r-md': '14px', '--r-sm': '10px',
  '--shadow': '0 1px 2px rgba(37,39,34,.05),0 8px 24px rgba(37,39,34,.06)',
  '--t-hero': '28px', '--t-h2': '20px', '--t-body': '16px', '--t-sm': '14px', '--t-xs': '12px', '--tap': '48px',
};
const ARCHETYPE_TOKENS = { // PRD §3.2 六流派色 = 原型 :root --a-*
  '--a-dawn': '#E8B04B', '--a-night': '#4C7A93', '--a-relay': '#E95432',
  '--a-slow': '#3E7B5B', '--a-scholar': '#615CED', '--a-multi': '#C7701F',
};
const APPEARANCES = ['standard', 'swiss', 'archive', 'designer', 'workbench'];
const THEME_REQUIRED_TOKENS = [
  '--bg', '--surface', '--sunk', '--ink', '--ink2', '--ink3', '--line',
  '--brand', '--brand-ink', '--brand-soft', '--forest', '--forest-soft', '--gold', '--gold-soft',
  '--ok', '--warn', '--err', '--r-lg', '--r-md', '--r-sm', '--shadow',
];

function relLuminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, 'not a #rrggbb color: ' + hex);
  const rgb = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)]
    .map((pair) => parseInt(pair, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(fg, bg) {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('social.css: .soc base block defines every SPEC §3 token + archetype colors exactly', () => {
  const base = scopeBlock('.soc{');
  for (const [name, value] of Object.entries(SPEC_TOKENS)) {
    assert.equal(base[name], value, name + ' must equal relay-v2 SPEC §3 value ' + value);
  }
  for (const [name, value] of Object.entries(ARCHETYPE_TOKENS)) {
    assert.equal(base[name], value, name + ' must equal PRD §3.2 archetype color');
  }
});

test('social.css: all five appearances redefine the full token set under .soc', () => {
  for (const theme of APPEARANCES) {
    const tokens = scopeBlock('html[data-appearance=' + theme + '] .soc');
    for (const name of THEME_REQUIRED_TOKENS) {
      assert.ok(tokens[name], theme + ' redefines ' + name);
    }
  }
});

test('social.css: designer keeps ≥4.5:1 text pairs (SPEC §3 深色主题)', () => {
  const designer = scopeBlock('html[data-appearance=designer] .soc');
  for (const [fg, bg] of [['--ink', '--bg'], ['--ink', '--surface'], ['--ink2', '--surface'], ['--ink3', '--surface'], ['--brand-ink', '--brand'], ['--forest', '--forest-soft']]) {
    const ratio = contrast(designer[fg], designer[bg]);
    assert.ok(ratio >= 4.5, fg + ' on ' + bg + ' = ' + ratio.toFixed(2) + ' (needs ≥4.5)');
  }
});

test('social.css: every selector is scoped under .soc (绝不渗入旧页/relay 页)', () => {
  const selectors = cssSelectors();
  assert.ok(selectors.length > 20, 'stylesheet actually parsed (' + selectors.length + ' selectors)');
  for (const selector of selectors) {
    if (selector.startsWith('@')) continue;
    for (const part of selector.split(',')) {
      const sel = part.trim();
      if (!sel) continue;
      assert.ok(sel.includes('.soc'), 'selector escapes the social scope: "' + sel + '"');
    }
  }
});

test('social.css: prototype ① component geometry — arch/match/sim/uses/acts 按钮', () => {
  const arch = ruleBody('.arch');
  assert.ok(arch, '.arch rule exists');
  assert.match(arch, /border-radius:\s*24px/);
  assert.match(arch, /color:\s*#fff/);
  assert.match(arch, /padding:\s*18px/);
  const share = ruleBody('.arch .share') || ruleBody('.share');
  assert.ok(share, '.share rule exists');
  assert.match(share, /background:\s*var\(--surface\)/); // 原型 #fff = standard 主题 --surface，token 化以适配深色主题
  const match = ruleBody('.match');
  assert.ok(match, '.match rule exists');
  assert.match(match, /border-radius:\s*var\(--r-md\)/);
  assert.match(match, /box-shadow:\s*var\(--shadow\)/);
  const sim = ruleBody('.sim');
  assert.ok(sim, '.sim rule exists');
  assert.match(sim, /color:\s*var\(--forest\)/);
  assert.match(sim, /background:\s*var\(--forest-soft\)/);
  assert.match(sim, /border-radius:\s*99px/);
  const uses = ruleBody('.uses span');
  assert.ok(uses, '.uses span rule exists');
  assert.match(uses, /background:\s*var\(--sunk\)/);
  const cheer = ruleBody('.b.cheer');
  assert.ok(cheer, '.b.cheer rule exists');
  assert.match(cheer, /background:\s*var\(--brand-soft\)/);
  assert.match(cheer, /color:\s*var\(--brand\)/);
  const pairBtn = ruleBody('.b.pair');
  assert.ok(pairBtn, '.b.pair rule exists');
  assert.match(pairBtn, /background:\s*var\(--ink\)/);
  const actsBtn = ruleBody('.acts .b');
  assert.ok(actsBtn, '.acts .b rule exists');
  assert.match(actsBtn, /height:\s*34px/);
  const invite = ruleBody('.invite');
  assert.ok(invite, '.invite rule exists');
  assert.match(invite, /dashed/);
  const why = ruleBody('.why b');
  assert.ok(why, '.why b rule exists');
  assert.match(why, /color:\s*var\(--ink\)/);
});
