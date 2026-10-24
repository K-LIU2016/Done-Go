import assert from 'node:assert/strict';
import { test } from 'node:test';

// RV2 i18n line (L10多语言): web/relay/i18n.js owns every relay v2 UI string
// (SPEC design/relay-v2/SPEC.md §6 多语言 + §4①–⑧ copy inventory).
//
// Pinned decisions (documented in web/relay/i18n.js):
// - Language set mirrors the app shell (web/index.html LANGS): zh default,
//   en complete, ru/th/ar/ko resolve to the en dictionary (SPEC §6 回退 en).
// - zh wording is the prototype's verbatim (design/relay-v2/prototype.html +
//   shots/m-*.png); en is the first complete translation.
// - Enum-keyed copy groups align 1:1 with web/relay/contracts.js enums:
//   RATINGS → ratings, FAIL_TYPES → fail.reasons, PERSONAS → personas,
//   CATEGORIES → discover.categories. Never redefined locally.
// - home group keys match HOME_COPY (web/relay/home.js) and baton group keys
//   match BATON_STRINGS_ZH (web/relay/baton.js) so the integration line can
//   wire createHome({copy}) / baton strings overrides without remapping.
// - ar is the only RTL language; direction attributes are handled by
//   dirForLang/applyLangToDocument (SPEC §6 阿拉伯语 RTL 不乱).
// - D3: no copy anywhere shows model-estimated minutes.

import {
  RELAY_LANGS, RELAY_DEFAULT_LANG, RELAY_LANG_STORAGE_KEY, RTL_LANGS,
  RELAY_COPY, normalizeLang, copyForLang, copyGroup, tr,
  dirForLang, htmlLangForLang, applyLangToDocument, speechLangFor,
} from '../../web/relay/i18n.js';
import { RATINGS, FAIL_TYPES, PERSONAS, CATEGORIES } from '../../web/relay/contracts.js';

// Optional alignment with sibling lines: home.js is the L2 line's deliverable
// and may not be committed yet — its key set is asserted whenever importable.
let HOME_COPY = null;
try { ({ HOME_COPY } = await import('../../web/relay/home.js')); } catch (e) { /* absent */ }

const SET = (xs) => new Set(xs);
const KEYS = (o) => Object.keys(o).sort();

// Recursive zh/en parity walk: same key sets at every level; every leaf is a
// non-empty string. Nested plain objects are walked; anything else is a leaf.
function assertSameShape(path, zh, en) {
  const zhObj = zh !== null && typeof zh === 'object' && !Array.isArray(zh);
  const enObj = en !== null && typeof en === 'object' && !Array.isArray(en);
  assert.equal(zhObj, enObj, 'shape mismatch at ' + path);
  if (!zhObj) {
    assert.equal(typeof zh, 'string', path + ' zh leaf must be a string');
    assert.ok(zh.length > 0, path + ' zh leaf must be non-empty');
    assert.equal(typeof en, 'string', path + ' en leaf must be a string');
    assert.ok(en.length > 0, path + ' en leaf must be non-empty');
    return;
  }
  assert.deepEqual(KEYS(zh), KEYS(en), 'key sets differ under ' + path);
  for (const key of Object.keys(zh)) assertSameShape(path + '.' + key, zh[key], en[key]);
}

function leafStrings(dict) {
  const out = [];
  (function walk(node) {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      Object.values(node).forEach(walk);
    } else if (typeof node === 'string') {
      out.push(node);
    }
  })(dict);
  return out;
}

test('language set mirrors the app shell (index.html LANGS)', () => {
  assert.deepEqual(RELAY_LANGS, ['zh', 'en', 'ru', 'th', 'ar', 'ko']);
  assert.equal(RELAY_DEFAULT_LANG, 'zh');
  // Same storage key as web/index.html:3381 so relay and shell share one pick.
  assert.equal(RELAY_LANG_STORAGE_KEY, 'tango-donego.lang');
});

test('normalizeLang: exact, case-insensitive, primary subtag; junk → null', () => {
  assert.equal(normalizeLang('zh'), 'zh');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('EN'), 'en');
  assert.equal(normalizeLang(' ar '), 'ar');
  assert.equal(normalizeLang('zh-CN'), 'zh');
  assert.equal(normalizeLang('en_US'), 'en');
  assert.equal(normalizeLang('th-TH'), 'th');
  assert.equal(normalizeLang('ko-KR'), 'ko');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('fr'), null);
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(null), null);
  assert.equal(normalizeLang(undefined), null);
  assert.equal(normalizeLang(42), null);
});

test('zh and en dictionaries have identical shape, all leaves non-empty', () => {
  assert.ok(RELAY_COPY.zh, 'zh dictionary exists');
  assert.ok(RELAY_COPY.en, 'en dictionary exists');
  assertSameShape('copy', RELAY_COPY.zh, RELAY_COPY.en);
});

test('copy key lists align with contracts enums (both languages)', () => {
  assert.deepEqual(SET(KEYS(RELAY_COPY.zh.ratings)), SET(RATINGS));
  assert.deepEqual(SET(KEYS(RELAY_COPY.en.ratings)), SET(RATINGS));
  assert.deepEqual(SET(KEYS(RELAY_COPY.zh.fail.reasons)), SET(FAIL_TYPES));
  assert.deepEqual(SET(KEYS(RELAY_COPY.en.fail.reasons)), SET(FAIL_TYPES));
  assert.deepEqual(SET(KEYS(RELAY_COPY.zh.personas)), SET(PERSONAS));
  assert.deepEqual(SET(KEYS(RELAY_COPY.en.personas)), SET(PERSONAS));
  assert.deepEqual(SET(KEYS(RELAY_COPY.zh.discover.categories)), SET(CATEGORIES));
  assert.deepEqual(SET(KEYS(RELAY_COPY.en.discover.categories)), SET(CATEGORIES));
});

test('enum copy covers every contracts value with distinct text', () => {
  for (const lang of ['zh', 'en']) {
    const copy = RELAY_COPY[lang];
    for (const group of [copy.ratings, copy.fail.reasons, copy.personas, copy.discover.categories]) {
      const values = Object.values(group);
      assert.equal(new Set(values).size, values.length, lang + ' enum copy has duplicate labels');
      values.forEach((v) => assert.equal(typeof v, 'string'));
    }
  }
});

test('copyForLang: zh exact; en and ru/th/ar/ko fall back to en; junk → zh default', () => {
  assert.equal(copyForLang('zh'), RELAY_COPY.zh);
  assert.equal(copyForLang('en'), RELAY_COPY.en);
  assert.equal(copyForLang('ru'), RELAY_COPY.en);
  assert.equal(copyForLang('th'), RELAY_COPY.en);
  assert.equal(copyForLang('ar'), RELAY_COPY.en);
  assert.equal(copyForLang('ko'), RELAY_COPY.en);
  assert.equal(copyForLang('ar-SA'), RELAY_COPY.en);
  assert.equal(copyForLang('fr'), RELAY_COPY.zh);
  assert.equal(copyForLang(null), RELAY_COPY.zh);
});

test('tr: dot-path lookup, en fallback for other langs, default zh', () => {
  assert.equal(tr('zh', 'match.send'), '让 AI 先做一版');
  assert.equal(tr('en', 'match.send'), 'Let AI make a first draft');
  assert.equal(tr('ru', 'match.send'), 'Let AI make a first draft');
  assert.equal(tr('ko', 'match.send'), 'Let AI make a first draft');
  assert.equal(tr(null, 'match.send'), tr('zh', 'match.send'));
});

test('tr: {placeholder} interpolation', () => {
  assert.equal(tr('zh', 'running.timer', { n: 4 }), '已用 4 秒');
  assert.equal(tr('en', 'running.timer', { n: 12 }), '12 s so far');
  assert.equal(
    tr('zh', 'passport.relayTimes', { relay: 4, graduated: 2 }),
    '接力 4 次 · 自己做到 2 次'
  );
  assert.equal(
    tr('en', 'result.guestNudge', { login: 'Log in' }),
    'Saved on this device. Log in to see it on your other phone.'
  );
  // Unknown placeholder names are left visible, never silently dropped.
  assert.equal(tr('zh', 'running.timer', {}), '已用 {n} 秒');
});

test('tr: unknown key returns the key itself (visible gap, never a crash)', () => {
  assert.equal(tr('zh', 'nope.missing'), 'nope.missing');
  assert.equal(tr('en', 'nope'), 'nope');
  assert.equal(tr('zh', ''), '');
});

test('tr: cross-dictionary fallback when one language lacks a key', () => {
  const savedEn = RELAY_COPY.en.match.send;
  try {
    delete RELAY_COPY.en.match.send;
    assert.equal(tr('en', 'match.send'), RELAY_COPY.zh.match.send); // falls back to zh
  } finally {
    RELAY_COPY.en.match.send = savedEn;
  }
  assert.equal(tr('en', 'match.send'), savedEn);
});

test('copyGroup returns a detached shallow copy of one group', () => {
  const home = copyGroup('en', 'home');
  assert.equal(home.hero, 'What do you need to do today?');
  assert.notEqual(home, RELAY_COPY.en.home);
  home.hero = 'MUTATED';
  assert.equal(RELAY_COPY.en.home.hero, 'What do you need to do today?');
  assert.equal(copyGroup('zh', 'baton').copy, '复制');
  assert.equal(copyGroup('ru', 'baton').copy, 'Copy');
  assert.equal(copyGroup('zh', 'not-a-group'), null);
});

test('zh wording is the prototype/spec verbatim (spot checks)', () => {
  const zh = RELAY_COPY.zh;
  // §4① start — shots/m-home.png
  assert.equal(zh.home.hero, '今天要做什么？');
  assert.equal(zh.home.lead, '说一件手头的事，探戈帮你交给合适的 AI。');
  assert.equal(zh.home.placeholder, '说一件今天要做的事');
  assert.equal(zh.home.emptyText, '完成第一次接力，这里会出现你学会的第一个用法');
  // §4② match — prototype S2
  assert.equal(zh.match.back, '换一件事');
  assert.equal(zh.match.kicker, '这件事适合交给 AI');
  assert.equal(zh.match.youSaid, '你说的是：');
  assert.equal(zh.match.doesLabel, 'AI 会先做');
  assert.equal(zh.match.materialNote, '粘贴文字，或直接说');
  assert.equal(zh.match.toolsSpeak, '说给我听');
  assert.equal(zh.match.toolsPaste, '从剪贴板粘贴');
  assert.equal(
    zh.match.privacy,
    '点下面的按钮后，这段内容会发给 AI 处理。不包含你的账号信息，不会给任何人看。'
  );
  assert.equal(zh.match.send, '让 AI 先做一版');
  assert.equal(zh.match.altPrefix, '不太对？换成');
  assert.equal(zh.match.altJoin, '或');
  assert.equal(zh.match.lowConfidenceTitle, '你想让 AI 帮哪一种？');
  assert.equal(zh.match.tooLong, '太长了，先贴最重要的一段');
  // §4③ running — prototype S3 + SPEC slow-hint wording
  assert.equal(zh.running.title, 'AI 正在整理…');
  assert.equal(zh.running.timer, '已用 {n} 秒');
  assert.equal(zh.running.stop, '先停一下');
  assert.equal(zh.running.note, '一般 5–15 秒。你的内容都留着，随时可以停。');
  assert.ok(zh.running.slowHint.indexOf('自己接力') !== -1);
  // §4④ result — prototype S4 / shots/m-result.png
  assert.equal(zh.result.title, 'AI 先做好的一版');
  assert.equal(zh.result.aiTag, 'AI 生成 · 请你核对');
  assert.equal(zh.result.copy, '复制');
  assert.equal(zh.result.edit, '直接改');
  assert.equal(zh.result.redo, '再来一版');
  assert.equal(zh.result.tweakShorter, '更短一点');
  assert.equal(zh.result.tweakFormal, '更正式');
  assert.equal(zh.result.tweakTime, '加上时间');
  assert.equal(zh.result.rateTitle, '这次帮上忙了吗？');
  assert.equal(zh.result.learnedKicker, '你学会了一个新用法');
  assert.equal(zh.result.guestNudge, '已存到这台设备。{login}后换手机也能看到。');
  assert.equal(zh.shell.login, '登录');
  assert.equal(zh.ratings.much, '省了不少');
  assert.equal(zh.ratings.little, '省了一点');
  assert.equal(zh.ratings.none, '没省时间');
  // §4⑤ passport — prototype S5
  assert.equal(zh.passport.title, '我的用法');
  assert.equal(zh.passport.lead, '你和 AI 一起做过的事，都在这里。');
  assert.equal(zh.passport.statLearned, '学会的用法');
  assert.equal(zh.passport.statRelay, '次 AI 接力');
  assert.equal(zh.passport.statGraduated, '次自己做到');
  assert.equal(zh.passport.relayTimes, '接力 {relay} 次 · 自己做到 {graduated} 次');
  assert.equal(zh.passport.notYetGraduated, '还没自己试');
  assert.equal(zh.passport.doAgain, '再做一次 →');
  assert.equal(zh.passport.tryOnce, '去试一次 →');
  assert.equal(zh.passport.recentTitle, '最近');
  assert.equal(zh.passport.gradBadge, '自己做到');
  assert.equal(zh.passport.exportJson, '导出我的记录（JSON）');
  // §4⑥ discover — prototype S6
  assert.equal(zh.discover.title, '发现');
  assert.equal(zh.discover.lead, '挑一件跟你有关的事，点一下就开始。');
  assert.equal(zh.discover.categories['写'], '写');
  // §4⑦ more — prototype S7
  assert.equal(zh.more.title, '更多');
  assert.equal(zh.more.accountGuest, '访客 · 去登录');
  assert.equal(zh.more.labTitle, '实验室（早期功能，不影响主流程）');
  assert.equal(zh.more.labTime, '时间记录与回顾');
  assert.equal(zh.more.labAgreements, '约定与小组');
  assert.equal(zh.more.labOldTag, '旧版');
  assert.equal(zh.more.deleteData, '删除本机记录');
  // §4⑧ fail — SPEC enum wording / shots/m-fail.png
  assert.equal(zh.fail.title, 'AI 这次没接上');
  assert.equal(zh.fail.reasons.unconfigured, 'AI 暂时没开，先自己接力试试');
  assert.equal(zh.fail.reasons.timeout, '它想得太久了（超过 60 秒）');
  assert.equal(zh.fail.reasons.ratelimit, '今天的体验次数用完了，明天再来');
  assert.equal(zh.fail.reasons.upstream, 'AI 服务这会儿忙');
  assert.equal(zh.fail.reasons.format, 'AI 回答乱了，再试一次');
  assert.equal(zh.fail.notYourFault, '不是你的问题。');
  assert.equal(zh.fail.kept, '你填的内容都还在。');
  assert.equal(zh.fail.retry, '再试一次');
  // personas — prototype seg
  assert.equal(zh.personas.student, '学生');
  assert.equal(zh.personas.teacher, '老师');
  assert.equal(zh.personas.worker, '上班族');
  assert.equal(zh.personas.elder, '长辈');
  // steps bar — prototype S2
  assert.equal(zh.steps.s1, '说清楚');
  assert.equal(zh.steps.s2, 'AI 先做');
  assert.equal(zh.steps.s3, '你来接棒');
});

test('language names are self-names (do not translate between dictionaries)', () => {
  assert.equal(RELAY_COPY.zh.more.languageNames.ar, 'العربية');
  assert.equal(RELAY_COPY.en.more.languageNames.ar, 'العربية');
  assert.equal(RELAY_COPY.zh.more.languageNames.zh, '中文');
  assert.equal(RELAY_COPY.en.more.languageNames.zh, '中文');
  assert.deepEqual(KEYS(RELAY_COPY.zh.more.languageNames), [...RELAY_LANGS].sort());
});

test('home group keys cover HOME_COPY exactly (integration wiring surface)', { skip: !HOME_COPY && 'web/relay/home.js not committed yet' }, () => {
  assert.deepEqual(KEYS(RELAY_COPY.zh.home), KEYS(HOME_COPY));
  // Every zh value the view ships as default must equal the i18n zh value —
  // one source of truth for the prototype wording.
  for (const key of Object.keys(HOME_COPY)) {
    assert.equal(RELAY_COPY.zh.home[key], HOME_COPY[key], 'home.' + key);
  }
});

test('RTL: ar is the only rtl language; every supported lang gets a definite dir', () => {
  assert.deepEqual(RTL_LANGS, ['ar']);
  for (const lang of RELAY_LANGS) {
    assert.equal(dirForLang(lang), lang === 'ar' ? 'rtl' : 'ltr');
  }
  assert.equal(dirForLang('fr'), 'ltr');
  assert.equal(dirForLang(null), 'ltr');
  // ar falls back to en copy but keeps rtl direction (SPEC §6).
  assert.equal(copyForLang('ar'), RELAY_COPY.en);
  assert.equal(dirForLang('ar'), 'rtl');
});

test('htmlLangForLang mirrors the app shell applyLang mapping (index.html:3599)', () => {
  assert.equal(htmlLangForLang('zh'), 'zh-CN');
  assert.equal(htmlLangForLang('en'), 'en');
  assert.equal(htmlLangForLang('ru'), 'ru');
  assert.equal(htmlLangForLang('th'), 'th');
  assert.equal(htmlLangForLang('ar'), 'ar');
  assert.equal(htmlLangForLang('ko'), 'ko');
  assert.equal(htmlLangForLang('zh-CN'), 'zh-CN');
  assert.equal(htmlLangForLang('fr'), null);
  assert.equal(htmlLangForLang(null), null);
});

test('applyLangToDocument sets lang + dir on documentElement (RTL included)', () => {
  const arDoc = { documentElement: {} };
  const ar = applyLangToDocument(arDoc, 'ar');
  assert.equal(arDoc.documentElement.lang, 'ar');
  assert.equal(arDoc.documentElement.dir, 'rtl');
  assert.deepEqual(ar, { lang: 'ar', htmlLang: 'ar', dir: 'rtl' });

  const zhDoc = { documentElement: {} };
  const zh = applyLangToDocument(zhDoc, 'zh');
  assert.equal(zhDoc.documentElement.lang, 'zh-CN');
  assert.equal(zhDoc.documentElement.dir, 'ltr');
  assert.deepEqual(zh, { lang: 'zh', htmlLang: 'zh-CN', dir: 'ltr' });

  // Subtag input normalizes; junk input degrades to the zh default, not a crash.
  const enDoc = { documentElement: {} };
  assert.equal(applyLangToDocument(enDoc, 'en-US').htmlLang, 'en');
  const junkDoc = { documentElement: {} };
  assert.equal(applyLangToDocument(junkDoc, 'fr').htmlLang, 'zh-CN');
  assert.equal(junkDoc.documentElement.dir, 'ltr');

  // Defensive: no documentElement → no throw, returns null.
  assert.equal(applyLangToDocument({}, 'ar'), null);
  assert.equal(applyLangToDocument(null, 'ar'), null);
});

test('speechLangFor mirrors the app shell SPEECH_LANG mapping (index.html:3379)', () => {
  assert.equal(speechLangFor('zh'), 'zh-CN');
  assert.equal(speechLangFor('en'), 'en-US');
  assert.equal(speechLangFor('ru'), 'ru-RU');
  assert.equal(speechLangFor('th'), 'th-TH');
  assert.equal(speechLangFor('ar'), 'ar-SA');
  assert.equal(speechLangFor('ko'), 'ko-KR');
  assert.equal(speechLangFor('ar-EG'), 'ar-SA');
  assert.equal(speechLangFor('fr'), 'zh-CN');
  assert.equal(speechLangFor(null), 'zh-CN');
});

test('D3: no copy shows model-estimated minutes (zh or en)', () => {
  for (const lang of ['zh', 'en']) {
    leafStrings(RELAY_COPY[lang]).forEach((text) => {
      assert.ok(text.indexOf('分钟') === -1, lang + ' copy mentions 分钟: ' + text);
      assert.ok(!/estimated.{0,12}min/i.test(text), lang + ' copy mentions estimated minutes: ' + text);
    });
  }
});
