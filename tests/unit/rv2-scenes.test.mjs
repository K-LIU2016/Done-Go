import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// RV2 L6场景库 line: web/relay/scenes.zh.json (SPEC §5.1) + web/relay/discover.js.
// Data shapes come ONLY from web/relay/contracts.js (validateSceneLib /
// validateUsage / PERSONAS / CATEGORIES) — never redefined here.
//
// Gates in this file:
//   1. contract conformance (validateSceneLib) + ≥48 usages + 4×(≥12 scenes,
//      exactly 6 featured) coverage;
//   2. D1 visual contract: student featured cards == m-home.png/d-home.png
//      prototype markup verbatim; teacher featured cards == m-discover.png;
//   3. SPEC §5.1 example usage `meeting-notes` field-for-field;
//   4. sayings (3 per usage, for the L7 matcher line): non-empty, globally
//      unique, each containing an own keyword, and each a *sole winner*
//      under the matcher's keyword scoring for every persona — enforced
//      numerically here (pure), plus via web/relay/matcher.js when present;
//   5. keyword hygiene: ≥2 chars, ≥2 library-unique keywords per usage, no
//      cross-usage keyword substring — the properties L7's generated-saying
//      coverage (tests/unit/rv2-matcher.test.mjs) relies on;
//   6. copy quality: no time-saving promises / exaggerations (SPEC §1.5,
//      §5.1 不夸大不承诺省时), elder cards shorter (§5.1 长辈文案更短),
//      no estimatedSavedMinutes anywhere (D3);
//   7. discover.js API behaviour (parse/persona cards/featured/category
//      grouping/sayings accessors).

import {
  PERSONAS, CATEGORIES, validateSceneLib,
} from '../../web/relay/contracts.js';
import {
  parseSceneLib, usageById, allUsageIds, personaCard, personaScenes,
  featuredScenes, scenesByCategory, sceneCount, featuredCount,
  checkCoverage, usageSayings,
  MIN_SCENES_PER_PERSONA, MIN_FEATURED_PER_PERSONA, SAYINGS_PER_SCENE,
} from '../../web/relay/discover.js';

const SCENES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'relay', 'scenes.zh.json');
const MATCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'relay', 'matcher.js');

const RAW_TEXT = readFileSync(SCENES_PATH, 'utf8');
const PAYLOAD = JSON.parse(RAW_TEXT);
const LIB = parseSceneLib(RAW_TEXT);
assert.equal(LIB.status, 'ok', 'scenes.zh.json must parse through discover.parseSceneLib');
const USAGES = PAYLOAD.usages; // raw entries (keep sayings) in file order

// ---------------------------------------------------------------------------
// Matcher scoring mirrored numerically (pure, no matcher import needed).
// weight(k) = 1 + 0.35×(len-1) capped 2.4; hits sorted by weight, decay 0.6^i;
// persona factor: applicable ×1.25, featured ×1.1 on top.
// ---------------------------------------------------------------------------
const NORM = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const WEIGHT = (k) => {
  const n = Array.from(k).length;
  return n <= 1 ? 1 : Math.min(2.4, 1 + 0.35 * (n - 1));
};
function hitsOf(text, usage) {
  const t = NORM(text);
  const seen = new Set();
  const hits = [];
  for (const k of usage.keywords) {
    const kk = NORM(k);
    if (!kk || seen.has(kk) || !t.includes(kk)) continue;
    seen.add(kk);
    hits.push(kk);
  }
  hits.sort((a, b) => WEIGHT(b) - WEIGHT(a));
  let score = 0;
  hits.forEach((h, i) => { score += WEIGHT(h) * Math.pow(0.6, i); });
  return score;
}
function boostOf(usage, persona) {
  const entry = usage.personas && usage.personas[persona];
  if (!entry) return 1;
  return entry.featured === true ? 1.25 * 1.1 : 1.25;
}
// Sole-winner criterion: owner strictly outscores every other usage under
// EVERY persona (worst case own boost 1.0 vs foreign best 1.375).
function soleWinner(text, owner, usages) {
  const ownBase = hitsOf(text, owner);
  if (!(ownBase > 0)) return 'owner scores 0';
  for (const persona of PERSONAS) {
    const own = ownBase * boostOf(owner, persona);
    for (const other of usages) {
      if (other.id === owner.id) continue;
      const foreign = hitsOf(text, other) * boostOf(other, persona);
      if (foreign > 0 && foreign >= own) {
        return `persona=${persona} competitor=${other.id} ${foreign.toFixed(3)} >= ${own.toFixed(3)}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Contract conformance, size, coverage.
// ---------------------------------------------------------------------------
test('contract: scenes.zh.json validates through contracts.validateSceneLib', () => {
  const lib = validateSceneLib(PAYLOAD);
  assert.ok(lib, 'validateSceneLib must accept the shipped library');
  assert.equal(lib.usages.length, PAYLOAD.usages.length, 'no usage may be silently dropped');
  assert.equal(PAYLOAD.version, 1);
});

test('size: ≥48 usages, unique ids, all six categories present', () => {
  assert.ok(USAGES.length >= 48, `usages=${USAGES.length}`);
  assert.equal(new Set(USAGES.map((u) => u.id)).size, USAGES.length, 'ids unique');
  const cats = new Set(USAGES.map((u) => u.category));
  CATEGORIES.forEach((c) => assert.ok(cats.has(c), `category ${c} missing`));
  USAGES.forEach((u) => assert.ok(CATEGORIES.includes(u.category), `${u.id} category`));
  USAGES.forEach((u) => {
    assert.ok(Array.isArray(u.does) && u.does.length === 3, `${u.id} does must have 3 items (SPEC §4② three tags)`);
    assert.ok(u.externalPrompt.includes('{{material}}'), `${u.id} externalPrompt slot`);
    assert.equal(u.externalPrompt.split('{{material}}').length - 1, 1, `${u.id} exactly one {{material}}`);
  });
});

test('coverage: every persona ≥12 scenes with exactly 6 featured', () => {
  assert.equal(MIN_SCENES_PER_PERSONA, 12);
  assert.equal(MIN_FEATURED_PER_PERSONA, 6);
  const expected = { student: 13, teacher: 12, worker: 14, elder: 12 };
  PERSONAS.forEach((persona) => {
    assert.ok(sceneCount(LIB.lib, persona) >= MIN_SCENES_PER_PERSONA,
      `${persona}: ${sceneCount(LIB.lib, persona)} scenes`);
    assert.equal(featuredCount(LIB.lib, persona), MIN_FEATURED_PER_PERSONA,
      `${persona}: exactly 6 featured`);
    assert.equal(sceneCount(LIB.lib, persona), expected[persona]);
  });
  const coverage = checkCoverage(LIB.lib);
  assert.equal(coverage.ok, true);
  PERSONAS.forEach((p) => assert.ok(coverage.personas[p].ok, `${p} coverage`));
});

// ---------------------------------------------------------------------------
// 2. D1 visual contract — screenshot-verbatim featured cards.
// ---------------------------------------------------------------------------
test('D1: student featured cards verbatim from m-home.png prototype order', () => {
  const cards = featuredScenes(LIB.lib, 'student');
  assert.deepEqual(cards.map((c) => [c.title, c.hint]), [
    ['读懂一篇论文', '先给你 5 个要点和 3 个问题'],
    ['给导师写邮件', '说清意图，AI 先起草'],
    ['整理组会纪要', '重点、待办、待补充'],
    ['摘要翻成英文', '保留术语，可校对'],
    ['拆解作业计划', '按截止日拆成小步'],
    ['改一版简历', '突出经历，不编造'],
  ]);
});

test('D1: teacher featured cards verbatim from m-discover.png', () => {
  const cards = featuredScenes(LIB.lib, 'teacher');
  assert.deepEqual(cards.map((c) => [c.title, c.hint]), [
    ['写 30 条学生评语', '给要点，AI 先起草，你来改'],
    ['家长群通知', '说清事项，语气温和'],
    ['班会发言稿', '3 分钟，有一个小故事'],
    ['一节课的教案', '目标、环节、提问'],
    ['出 10 道练习题', '分难度，附答案'],
    ['读懂一份文件', '新政策说了什么'],
  ]);
});

// ---------------------------------------------------------------------------
// 3. SPEC §5.1 example usage verbatim.
// ---------------------------------------------------------------------------
test('SPEC §5.1: meeting-notes example fields verbatim, shared student+worker', () => {
  const u = USAGES.find((x) => x.id === 'meeting-notes');
  assert.ok(u);
  assert.equal(u.title, '整理会议纪要');
  assert.equal(u.category, '整理');
  assert.deepEqual(u.does, ['列出重点', '拆出待办和负责人', '标出没说清的地方']);
  assert.equal(u.materialLabel, '把会议内容给我');
  assert.equal(u.materialHint, '把聊天记录、笔记或转写文字粘贴到这里……');
  assert.equal(u.learned, '把会议材料交给 AI，先要「重点、待办、没说清的地方」。');
  assert.equal(u.externalPrompt,
    '请把下面的会议内容整理成三部分：1. 会议重点；2. 待办（写清负责人）；3. 没说清、需要追问的地方。只根据内容整理，不要补充没提到的信息。\n会议内容：{{material}}');
  assert.deepEqual(u.keywords, ['会议', '开会', '纪要', '组会', '周会', '例会', '录音']);
  assert.deepEqual(u.personas.student, { featured: true, title: '整理组会纪要', hint: '重点、待办、待补充' });
  assert.equal(u.personas.worker.featured, true);
  assert.ok(u.personas.worker.hint, 'worker card needs a hint for the scene grid');
});

// ---------------------------------------------------------------------------
// 4. Sayings — the L7 coverage fixtures.
// ---------------------------------------------------------------------------
test('sayings: exactly 3 per usage, non-empty, globally unique, own-keyword hit', () => {
  assert.equal(SAYINGS_PER_SCENE, 3);
  const seen = new Set();
  USAGES.forEach((u) => {
    assert.ok(Array.isArray(u.sayings) && u.sayings.length === 3, `${u.id} sayings`);
    u.sayings.forEach((saying) => {
      assert.ok(String(saying).trim(), `${u.id} empty saying`);
      assert.ok(!seen.has(saying), `duplicate saying "${saying}"`);
      seen.add(saying);
      assert.ok(
        u.keywords.some((k) => NORM(saying).includes(NORM(k))),
        `${u.id} saying "${saying}" contains no own keyword`,
      );
    });
  });
  assert.equal(seen.size, USAGES.length * 3);
});

test('sayings: each saying is the sole scoring winner for its usage under every persona', () => {
  USAGES.forEach((u) => {
    u.sayings.forEach((saying) => {
      const why = soleWinner(saying, u, USAGES);
      assert.equal(why, null, `${u.id} saying "${saying}": ${why}`);
    });
  });
});

test('titles: each usage title is the sole scoring winner under every persona', () => {
  USAGES.forEach((u) => {
    const why = soleWinner(u.title, u, USAGES);
    assert.equal(why, null, `${u.id} title "${u.title}": ${why}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Keyword hygiene — the properties behind L7's generated-saying coverage.
// ---------------------------------------------------------------------------
test('keywords: ≥2 chars, no cross-usage substring', () => {
  USAGES.forEach((u) => u.keywords.forEach((k) => {
    assert.ok(Array.from(NORM(k)).length >= 2, `${u.id} keyword "${k}" too short`);
  }));
  for (const a of USAGES) {
    for (const b of USAGES) {
      if (a.id === b.id) continue;
      a.keywords.forEach((ka) => {
        b.keywords.forEach((kb) => {
          assert.ok(
            !NORM(ka).includes(NORM(kb)),
            `"${kb}" (${b.id}) is a substring of "${ka}" (${a.id}) — breaks sole-winner matching`,
          );
        });
      });
    }
  }
});

test('keywords: ≥2 library-unique keywords per usage', () => {
  const owners = new Map();
  USAGES.forEach((u) => u.keywords.forEach((k) => {
    const key = NORM(k);
    owners.set(key, owners.has(key) ? owners.get(key) + 1 : 1);
  }));
  USAGES.forEach((u) => {
    const unique = u.keywords.filter((k) => owners.get(NORM(k)) === 1);
    assert.ok(unique.length >= 2, `${u.id} has ${unique.length} unique keywords: ${unique.join('/')}`);
  });
});

test('L7 generated sayings (我要+kw / title / 帮我弄一下+kw) are sole winners', () => {
  // Mirrors typicalSayings() in tests/unit/rv2-matcher.test.mjs.
  USAGES.forEach((u) => {
    const foreign = new Set();
    USAGES.forEach((v) => {
      if (v.id !== u.id) v.keywords.forEach((k) => foreign.add(NORM(k)));
    });
    const own = u.keywords.slice().sort((a, b) => Array.from(b).length - Array.from(a).length);
    const unique = own.filter((k) => !foreign.has(NORM(k)));
    const pool = unique.length ? unique : own;
    const kw1 = pool[0] || u.title;
    const kw2 = pool[1] || kw1;
    [`我要${kw1}`, u.title, `帮我弄一下${kw2}这件事`].forEach((saying) => {
      const why = soleWinner(saying, u, USAGES);
      assert.equal(why, null, `${u.id} generated "${saying}": ${why}`);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Copy quality.
// ---------------------------------------------------------------------------
const FORBIDDEN = ['省时', '节省', '省下', '省了', '一键', '完美', '最强', '包你', '保证', '翻倍'];
function allTexts(u) {
  const texts = [u.title, u.category, u.materialLabel, u.materialHint, u.learned, u.externalPrompt]
    .concat(u.does, u.keywords, u.sayings);
  Object.values(u.personas).forEach((entry) => {
    if (entry.title) texts.push(entry.title);
    if (entry.hint) texts.push(entry.hint);
  });
  return texts;
}
test('copy: no time-saving promises or exaggerations anywhere', () => {
  USAGES.forEach((u) => allTexts(u).forEach((text) => {
    FORBIDDEN.forEach((word) => assert.ok(!String(text).includes(word), `${u.id} contains "${word}"`));
  }));
  assert.ok(!RAW_TEXT.includes('estimatedSavedMinutes'), 'D3: no estimated minutes field');
});

test('schema: raw usage keys ⊆ contract fields + sayings', () => {
  const allowed = new Set(['id', 'title', 'category', 'does', 'materialLabel', 'materialHint',
    'learned', 'externalPrompt', 'keywords', 'personas', 'sayings']);
  USAGES.forEach((u) => Object.keys(u).forEach((key) => {
    assert.ok(allowed.has(key), `${u.id} unexpected key "${key}"`);
  }));
  assert.equal(new Set(USAGES.map((u) => u.id).filter((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))).size, 0);
});

test('elder: shorter copy — card titles ≤8 chars, hints ≤12 chars (SPEC §5.1)', () => {
  personaScenes(LIB.lib, 'elder').forEach((card) => {
    assert.ok(Array.from(card.title).length <= 8, `elder title "${card.title}"`);
    assert.ok(Array.from(card.hint).length <= 12, `elder hint "${card.hint}"`);
  });
});

test('personas: every persona entry carries a card hint', () => {
  USAGES.forEach((u) => Object.keys(u.personas).forEach((persona) => {
    assert.ok(PERSONAS.includes(persona), `${u.id} unknown persona ${persona}`);
    const entry = u.personas[persona];
    assert.equal(typeof entry.hint, 'string', `${u.id}/${persona} hint`);
    assert.ok(entry.hint && entry.hint.trim().length, `${u.id}/${persona} hint empty`);
    if (entry.title != null) assert.ok(entry.title.trim(), `${u.id}/${persona} title empty`);
  }));
});

// ---------------------------------------------------------------------------
// 7. discover.js API behaviour.
// ---------------------------------------------------------------------------
test('parseSceneLib: ok / bad JSON / wrong version / missing sayings', () => {
  assert.equal(parseSceneLib(RAW_TEXT).status, 'ok');
  assert.equal(parseSceneLib('{nope').status, 'invalid');
  assert.equal(parseSceneLib(JSON.stringify({ version: 2, usages: USAGES })).status, 'invalid');
  const noSayings = JSON.parse(RAW_TEXT);
  delete noSayings.usages[0].sayings;
  assert.equal(parseSceneLib(JSON.stringify(noSayings)).status, 'invalid');
  const badSayings = JSON.parse(RAW_TEXT);
  badSayings.usages[0].sayings = ['only one', ''];
  assert.equal(parseSceneLib(JSON.stringify(badSayings)).status, 'invalid');
});

test('usageById / allUsageIds / usageSayings', () => {
  assert.equal(usageById(LIB.lib, 'meeting-notes').title, '整理会议纪要');
  assert.ok(usageById(LIB.lib, 'meeting-notes').sayings.length === 3);
  assert.equal(usageById(LIB.lib, 'nope'), null);
  assert.equal(usageById(null, 'x'), null);
  assert.equal(allUsageIds(LIB.lib).length, USAGES.length);
  assert.deepEqual(usageSayings(LIB.lib, 'paper-read'), usageById(LIB.lib, 'paper-read').sayings);
  assert.deepEqual(usageSayings(LIB.lib, 'nope'), []);
});

test('personaCard: persona title/hint override, fallback to usage title, rejects unknown', () => {
  const meeting = usageById(LIB.lib, 'meeting-notes');
  assert.deepEqual(personaCard(meeting, 'student'), {
    id: 'meeting-notes', title: '整理组会纪要', hint: '重点、待办、待补充', featured: true, category: '整理',
  });
  assert.equal(personaCard(meeting, 'worker').title, '整理会议纪要');
  assert.equal(personaCard(meeting, 'teacher'), null);
  assert.equal(personaCard(meeting, 'nope'), null);
  assert.equal(personaCard(null, 'student'), null);
});

test('scenesByCategory: CATEGORIES order, no empty groups, every scene exactly once', () => {
  PERSONAS.forEach((persona) => {
    const groups = scenesByCategory(LIB.lib, persona);
    const order = groups.map((g) => g.category);
    const sorted = CATEGORIES.filter((c) => order.includes(c));
    assert.deepEqual(order, sorted, `${persona} groups follow CATEGORIES order`);
    const seen = [];
    groups.forEach((g) => {
      assert.ok(g.scenes.length, `${persona}/${g.category} empty group`);
      g.scenes.forEach((card) => seen.push(card.id));
    });
    assert.equal(seen.length, sceneCount(LIB.lib, persona));
    assert.equal(new Set(seen).size, seen.length, `${persona} scene appears twice`);
    assert.deepEqual([...seen].sort(), personaScenes(LIB.lib, persona).map((c) => c.id).sort(),
      `${persona} every scene grouped exactly once`);
  });
  // personaScenes keeps library file order (home grid + discover source order).
  assert.deepEqual(personaScenes(LIB.lib, 'student').map((c) => c.id)[0], 'paper-read');
});

test('parseSceneLib accepts a plain usages array too (home.js shape)', () => {
  const cards = featuredScenes(LIB.lib.usages, 'student');
  assert.equal(cards.length, 6);
  assert.equal(cards[0].title, '读懂一篇论文');
});

// ---------------------------------------------------------------------------
// Belt and braces: run the real matcher (L7 line) over sayings and titles
// when its module is present in the worktree.
// ---------------------------------------------------------------------------
test('matcher integration: matchLocal maps every saying and title back to its usage', { skip: !existsSync(MATCHER_PATH) ? 'web/relay/matcher.js not present' : false }, async () => {
  const { matchLocal } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'relay', 'matcher.js'));
  const payload = JSON.parse(RAW_TEXT);
  USAGES.forEach((u) => {
    const sayings = u.sayings.concat([u.title]);
    sayings.forEach((saying) => {
      PERSONAS.forEach((persona) => {
        const match = matchLocal(saying, payload, { persona });
        assert.ok(match, `${u.id} "${saying}" (${persona}) no match`);
        assert.equal(match.usageId, u.id,
          `${u.id} "${saying}" (${persona}) → ${match.usageId} alts=${match.alternatives.join(',')}`);
      });
    });
  });
});
