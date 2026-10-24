import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// L7 匹配线 unit：web/relay/matcher.js（SPEC design/relay-v2/SPEC.md §4②/§5.3, D7）。
// 结构一律来自 web/relay/contracts.js；本文件只测匹配行为：
//   关键词打分 + 人群加权 → top1 + 2 备选 + 置信度；
//   置信度 < 0.6（D7）→ 升级 mode:'route'（light 档，注入式调用，保持纯模块）；
//   场景库覆盖：每个场景的 3 条典型说法都能匹配到它自己。

import {
  PERSONAS, validateUsage, validateSceneLib, sanitizeRouteResult, ROUTE_MODE,
} from '../../web/relay/contracts.js';
import {
  ROUTE_CONFIDENCE_THRESHOLD, CHOOSER_CONFIDENCE_THRESHOLD,
  normalizeEventText, keywordWeight, scoreUsage, rankUsages,
  matchLocal, needsRoute, buildRouteRequest, matchFromRoute, matchEvent,
} from '../../web/relay/matcher.js';

// ---------------------------------------------------------------------------
// Fixture scene library — same schema as web/relay/scenes.zh.json (SPEC §5.1),
// validates through contracts.validateSceneLib. Keywords are designed so every
// usage owns unique keywords (no other usage lists them) — the property the
// coverage test below relies on, mirroring what the real library must achieve.
// ---------------------------------------------------------------------------

const FIXTURE = {
  version: 1,
  usages: [
    {
      id: 'meeting-notes', title: '整理会议纪要', category: '整理',
      does: ['列出重点', '拆出待办和负责人', '标出没说清的地方'],
      materialLabel: '把会议内容给我', materialHint: '把聊天记录、笔记或转写文字粘贴到这里……',
      learned: '把会议材料交给 AI，先要「重点、待办、没说清的地方」。',
      externalPrompt: '请把下面的会议内容整理成三部分：1. 会议重点；2. 待办（写清负责人）；3. 没说清、需要追问的地方。\n会议内容：{{material}}',
      keywords: ['会议', '开会', '纪要', '组会', '周会', '例会', '录音'],
      personas: { student: { featured: true, title: '整理组会纪要', hint: '重点、待办、待补充' }, worker: { featured: true } },
    },
    {
      id: 'weekly-report', title: '写好工作周报', category: '写',
      does: ['按项目梳理进展', '标出下周计划'],
      materialLabel: '把这周做的事给我', materialHint: '随手记的流水账、待办清单都可以贴进来……',
      learned: '写周报先让 AI 按「进展 / 下周计划」分两栏。',
      externalPrompt: '请把下面这周的工作记录整理成周报，分「本周进展」和「下周计划」两栏：\n工作记录：{{material}}',
      keywords: ['周报', '工作汇报'],
      personas: { worker: { featured: true } },
    },
    {
      id: 'paper-reading', title: '读懂一篇论文', category: '读',
      does: ['先给 5 个要点', '列出 3 个可以追问的问题'],
      materialLabel: '把论文给我', materialHint: '粘贴摘要或正文都可以……',
      learned: '读论文先要「要点 + 追问」，再自己核对。',
      externalPrompt: '请读下面的论文内容，给出 5 个要点和 3 个值得追问的问题：\n论文内容：{{material}}',
      keywords: ['论文', '文献', '读不懂'],
      personas: { student: { featured: true } },
    },
    {
      id: 'email-draft', title: '给导师写邮件', category: '写',
      does: ['说清意图', '先起草一版语气得体的邮件'],
      materialLabel: '说下你要写什么', materialHint: '想请什么事、跟谁说、什么语气……',
      learned: '写邮件先说清「给谁、要什么、什么语气」。',
      externalPrompt: '请根据下面的意图起草一封邮件，语气得体、不啰嗦：\n意图：{{material}}',
      keywords: ['邮件', '导师', '套磁信'],
      personas: { student: { featured: true } },
    },
    {
      id: 'resume-polish', title: '改一版简历', category: '写',
      does: ['突出相关经历', '不编造内容'],
      materialLabel: '把简历内容给我', materialHint: '贴上现在的简历文字……',
      learned: '改简历先让 AI 突出「和岗位相关的经历」，事实自己核对。',
      externalPrompt: '请改写下面的简历内容，突出与目标岗位相关的经历，不要编造：\n简历：{{material}}',
      keywords: ['简历', '求职', 'resume'],
      personas: { student: {}, worker: {} },
    },
    {
      id: 'abstract-translate', title: '摘要翻译', category: '翻译',
      does: ['保留术语', '给出可校对的译文'],
      materialLabel: '把要翻译的内容给我', materialHint: '中文摘要、英文段落都可以……',
      learned: '翻译先保留术语，再自己通读校对一遍。',
      externalPrompt: '请翻译下面的内容，保留专业术语，译文放在「译文：」之后：\n内容：{{material}}',
      keywords: ['翻译', '译成英文', '摘要'],
      personas: { student: {}, worker: {}, teacher: { featured: true } },
    },
    {
      id: 'homework-plan', title: '拆解作业计划', category: '计划',
      does: ['按截止日拆成小步', '每步给个时间点'],
      materialLabel: '说说这次的作业', materialHint: '什么作业、什么时候交、现在做到哪了……',
      learned: '大作业先拆成「带截止日的小步」。',
      externalPrompt: '请把下面的作业拆解成带截止日的小步计划：\n作业情况：{{material}}',
      keywords: ['作业', '截止日', '赶不完'],
      personas: { student: { featured: true } },
    },
    {
      id: 'class-comments', title: '写期末学生评语', category: '写',
      does: ['按要点成段', '语气具体不套话'],
      materialLabel: '把学生情况给我', materialHint: '每行一个学生的表现要点……',
      learned: '写评语先给「具体表现要点」，AI 只是起草。',
      externalPrompt: '请根据每个学生的表现要点各写一条期末评语，具体、不套话：\n要点：{{material}}',
      keywords: ['评语', '写评语'],
      personas: { teacher: { featured: true } },
    },
  ],
};

const FIXTURE_IDS = FIXTURE.usages.map((u) => u.id);
const libOrNull = validateSceneLib(FIXTURE);
assert.ok(libOrNull, 'fixture scene library must validate through contracts.validateSceneLib');

// ---------------------------------------------------------------------------
// Thresholds pinned by SPEC / D7.
// ---------------------------------------------------------------------------

test('thresholds: D7 route escalation at <0.6, SPEC §4② chooser at <0.5', () => {
  assert.equal(ROUTE_CONFIDENCE_THRESHOLD, 0.6);
  assert.equal(CHOOSER_CONFIDENCE_THRESHOLD, 0.5);
  assert.equal(ROUTE_MODE, 'route'); // request mode literal comes from contracts
});

// ---------------------------------------------------------------------------
// Text normalization and keyword weights.
// ---------------------------------------------------------------------------

test('normalizeEventText: trim, NFKC, lowercase latin, collapse whitespace', () => {
  assert.equal(normalizeEventText('  HeLLo   World '), 'hello world');
  assert.equal(normalizeEventText('整理会议纪要'), '整理会议纪要');
  assert.equal(normalizeEventText('ＲＥＳＵＭＥ　改一下'), 'resume 改一下');
  assert.equal(normalizeEventText(null), '');
  assert.equal(normalizeEventText(42), '42');
});

test('keywordWeight grows with keyword length and caps at 2.4', () => {
  assert.equal(keywordWeight('写'), 1);
  assert.equal(keywordWeight('a'), 1);
  assert.equal(keywordWeight(''), 1);
  assert.equal(keywordWeight('会议'), 1.35);
  assert.equal(keywordWeight('译成英文'), 2.05);
  assert.equal(keywordWeight('abcde'), 2.4);
  assert.equal(keywordWeight('这是一个很长的关键词'), 2.4);
});

// ---------------------------------------------------------------------------
// Scoring: keyword hits with diminishing returns, persona weighting.
// ---------------------------------------------------------------------------

const MEETING = libOrNull.usages[0];

test('scoreUsage: single hit scores its keyword weight, no hits score 0', () => {
  const one = scoreUsage('明天下午要开会讨论', MEETING, {});
  assert.deepEqual(one.hits, ['开会']);
  assert.ok(Math.abs(one.score - 1.35) < 1e-9);
  assert.equal(one.weighted, one.score); // no persona → no boost

  const none = scoreUsage('今天天气不错', MEETING, {});
  assert.deepEqual(none.hits, []);
  assert.equal(none.score, 0);
  assert.equal(none.weighted, 0);
});

test('scoreUsage: multiple hits decay (1 + 0.6 + 0.36)×w, equal weights keep keyword order', () => {
  const many = scoreUsage('帮我把组会录音整理成纪要', MEETING, {});
  assert.deepEqual(many.hits, ['纪要', '组会', '录音']); // stable sort for equal weights
  assert.ok(Math.abs(many.score - 1.35 * (1 + 0.6 + 0.36)) < 1e-9); // 2.646
});

let mkSeq = 0;
function mkUsage(overrides) {
  mkSeq += 1;
  const base = {
    id: 'fixture-' + mkSeq, title: '占位用法' + mkSeq, category: '写',
    does: ['先做一版'],
    materialLabel: '把材料给我', materialHint: '粘贴在这里',
    learned: '一句话',
    externalPrompt: '请处理：{{material}}',
    keywords: ['占位词' + mkSeq],
    personas: { student: {} },
  };
  const usage = validateUsage(Object.assign(base, overrides));
  assert.ok(usage, 'mkUsage must produce a contracts-valid usage: ' + JSON.stringify(overrides));
  return usage;
}

test('persona weighting: applicable ×1.25, featured ×1.375, others neutral', () => {
  const uB = mkUsage({ id: 'report-b', title: '汇报B', keywords: ['汇报'], personas: { worker: { featured: true } } });
  const uC = mkUsage({ id: 'report-c', title: '汇报C', keywords: ['汇报'], personas: { worker: {} } });

  const neutral = scoreUsage('帮我做个汇报', uB, {});
  assert.ok(Math.abs(neutral.weighted - 1.35) < 1e-9);           // no persona
  const student = scoreUsage('帮我做个汇报', uB, { persona: 'student' });
  assert.ok(Math.abs(student.weighted - 1.35) < 1e-9);           // not applicable
  const alien = scoreUsage('帮我做个汇报', uB, { persona: 'alien' });
  assert.ok(Math.abs(alien.weighted - 1.35) < 1e-9);             // unknown persona ignored
  const workerFeatured = scoreUsage('帮我做个汇报', uB, { persona: 'worker' });
  assert.ok(Math.abs(workerFeatured.weighted - 1.35 * 1.25 * 1.1) < 1e-9);
  const workerPlain = scoreUsage('帮我做个汇报', uC, { persona: 'worker' });
  assert.ok(Math.abs(workerPlain.weighted - 1.35 * 1.25) < 1e-9);
});

test('rankUsages: persona boost flips a keyword tie, neutral stays stable', () => {
  const uA = mkUsage({ id: 'report-a', title: '汇报A', keywords: ['汇报'], personas: { student: { featured: true } } });
  const uB = mkUsage({ id: 'report-b', title: '汇报B', keywords: ['汇报'], personas: { worker: { featured: true } } });

  assert.equal(rankUsages('帮我做个汇报', [uA, uB], {})[0].usage.id, 'report-a');
  assert.equal(rankUsages('帮我做个汇报', [uA, uB], { persona: 'student' })[0].usage.id, 'report-a');
  assert.equal(rankUsages('帮我做个汇报', [uA, uB], { persona: 'worker' })[0].usage.id, 'report-b');
});

// ---------------------------------------------------------------------------
// matchLocal: contract-shaped top1 + 2 alternatives + confidence.
// ---------------------------------------------------------------------------

test('matchLocal: confident hit returns contract shape with 2 distinct alternatives', () => {
  const match = matchLocal('我要整理今天的组会记录', FIXTURE, { persona: 'student' });
  assert.ok(match);
  assert.equal(match.usageId, 'meeting-notes');
  assert.ok(match.confidence >= ROUTE_CONFIDENCE_THRESHOLD, 'confident: ' + match.confidence);
  assert.equal(match.needsRoute, false);
  assert.equal(match.alternatives.length, 2);
  assert.ok(!match.alternatives.includes(match.usageId));
  assert.equal(new Set(match.alternatives).size, 2);
  match.alternatives.forEach((id) => assert.ok(FIXTURE_IDS.includes(id)));

  // The three core fields must round-trip the contract sanitizer untouched:
  // ids can only come from the scene library (SPEC §5.3).
  assert.deepEqual(sanitizeRouteResult(match, FIXTURE_IDS), {
    usageId: match.usageId, confidence: match.confidence, alternatives: match.alternatives,
  });
});

test('matchLocal: latin keyword matches case-insensitively after normalization', () => {
  const match = matchLocal('帮我看看 RESUME 怎么改', FIXTURE, {});
  assert.equal(match.usageId, 'resume-polish');
  assert.ok(match.confidence >= 0.6);
});

test('matchLocal: no keyword evidence → confidence 0, needsRoute, valid ids only', () => {
  const match = matchLocal('随便聊聊今天的心情', FIXTURE, {});
  assert.ok(match);
  assert.equal(match.confidence, 0);
  assert.equal(match.needsRoute, true);
  assert.ok(FIXTURE_IDS.includes(match.usageId));
  assert.equal(match.alternatives.length, 2);
  match.alternatives.forEach((id) => assert.ok(FIXTURE_IDS.includes(id)));
});

test('matchLocal: rejects empty event and invalid library', () => {
  assert.equal(matchLocal('', FIXTURE, {}), null);
  assert.equal(matchLocal('   ', FIXTURE, {}), null);
  assert.equal(matchLocal(null, FIXTURE, {}), null);
  assert.equal(matchLocal('开会', null, {}), null);
  assert.equal(matchLocal('开会', { version: 9, usages: [] }, {}), null);
});

// ---------------------------------------------------------------------------
// D7: confidence < 0.6 escalates to mode:'route' (light tier, server side).
// ---------------------------------------------------------------------------

test('needsRoute: strict < 0.6 boundary, defensive on missing match', () => {
  assert.equal(needsRoute({ confidence: 0.6 }), false);
  assert.equal(needsRoute({ confidence: 0.599999 }), true);
  assert.equal(needsRoute({ confidence: 0 }), true);
  assert.equal(needsRoute({ confidence: 1 }), false);
  assert.equal(needsRoute(null), true);
});

test('buildRouteRequest: exact contracts.validateRouteRequest wire body', () => {
  assert.deepEqual(buildRouteRequest('  整理组会  '), { mode: ROUTE_MODE, event: '整理组会' });
  assert.equal(buildRouteRequest(''), null);
  assert.equal(buildRouteRequest(null), null);
  assert.equal(buildRouteRequest('x'.repeat(601)), null);
  const edge = buildRouteRequest('x'.repeat(600));
  assert.equal(edge.event.length, 600);
});

test('matchFromRoute: accepts lib ids only, drops unknown alternatives (D7)', () => {
  const good = matchFromRoute(
    { usageId: 'paper-reading', confidence: 0.9, alternatives: ['meeting-notes', 'weekly-report'] },
    FIXTURE,
  );
  assert.ok(good);
  assert.equal(good.usageId, 'paper-reading');
  assert.equal(good.confidence, 0.9);
  assert.deepEqual(good.alternatives, ['meeting-notes', 'weekly-report']);
  assert.equal(good.needsRoute, false);

  const scrubbed = matchFromRoute(
    { usageId: 'abstract-translate', confidence: 0.55, alternatives: ['ghost-id', 'email-draft', 'meeting-notes', 'weekly-report'] },
    FIXTURE,
  );
  assert.deepEqual(scrubbed.alternatives, ['email-draft', 'meeting-notes']);
  assert.equal(scrubbed.needsRoute, true); // 0.55 < 0.6 keeps the D7 door open

  assert.equal(matchFromRoute({ usageId: 'nonexistent', confidence: 0.9, alternatives: [] }, FIXTURE), null);
  assert.equal(matchFromRoute({ usageId: 'paper-reading', confidence: 'high', alternatives: [] }, FIXTURE), null);
  assert.equal(matchFromRoute(null, FIXTURE), null);
});

test('matchEvent: confident local match never calls route', async () => {
  let calls = 0;
  const result = await matchEvent('我要整理今天的组会记录', FIXTURE, {
    persona: 'student',
    route: () => { calls += 1; return { usageId: 'paper-reading', confidence: 0.9, alternatives: [] }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.via, 'local');
  assert.equal(result.routeCalled, false);
  assert.equal(result.usageId, 'meeting-notes');
});

test('matchEvent: low confidence calls route with the exact request body and adopts its answer', async () => {
  const seen = [];
  const result = await matchEvent('随便聊聊今天的心情', FIXTURE, {
    route: async (request) => {
      seen.push(request);
      return { usageId: 'class-comments', confidence: 0.8, alternatives: ['homework-plan'] };
    },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { mode: ROUTE_MODE, event: '随便聊聊今天的心情' });
  assert.equal(result.via, 'route');
  assert.equal(result.routeCalled, true);
  assert.equal(result.usageId, 'class-comments');
  assert.equal(result.confidence, 0.8);
  assert.equal(result.needsRoute, false);
});

test('matchEvent: route returning junk falls back to the local match, flagged', async () => {
  const result = await matchEvent('随便聊聊今天的心情', FIXTURE, {
    route: () => ({ usageId: 'not-in-lib', confidence: 1, alternatives: [] }),
  });
  assert.equal(result.via, 'local');
  assert.equal(result.routeCalled, true);
  assert.equal(result.routeFailed, true);
  assert.ok(FIXTURE_IDS.includes(result.usageId));
  assert.equal(result.confidence, 0);
});

test('matchEvent: route throwing falls back with the error message', async () => {
  const result = await matchEvent('随便聊聊今天的心情', FIXTURE, {
    route: () => { throw new Error('gateway down'); },
  });
  assert.equal(result.via, 'local');
  assert.equal(result.routeFailed, true);
  assert.ok(result.routeError.includes('gateway down'));
});

test('matchEvent: no route function and empty event', async () => {
  const noRoute = await matchEvent('随便聊聊今天的心情', FIXTURE, {});
  assert.equal(noRoute.via, 'local');
  assert.equal(noRoute.routeCalled, false);
  assert.equal(noRoute.needsRoute, true);

  let calls = 0;
  const empty = await matchEvent('   ', FIXTURE, { route: () => { calls += 1; return null; } });
  assert.equal(empty, null);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Coverage: every usage's 3 typical sayings must match back to itself, for
// every persona. Typical sayings are generated from the usage's own keywords
// that are unique in the library (title as the plainest way people name a
// task) wrapped in function-word carriers that are nobody's keyword.
// ---------------------------------------------------------------------------

function typicalSayings(usage, lib) {
  const foreign = new Set();
  lib.usages.forEach((u) => {
    if (u.id !== usage.id) u.keywords.forEach((k) => foreign.add(k.toLowerCase()));
  });
  const own = usage.keywords.slice().sort((a, b) => b.length - a.length);
  const unique = own.filter((k) => !foreign.has(k.toLowerCase()));
  const pool = unique.length ? unique : own;
  const kw1 = pool[0] || usage.title;
  const kw2 = pool[1] || kw1;
  return ['我要' + kw1, usage.title, '帮我弄一下' + kw2 + '这件事'];
}

function assertCoverage(payload, label) {
  const usages = payload.usages;
  PERSONAS.forEach((persona) => {
    usages.forEach((usage) => {
      typicalSayings(usage, { usages }).forEach((saying) => {
        const match = matchLocal(saying, payload, { persona });
        assert.ok(match, label + ' · ' + persona + ' · ' + usage.id + ' · "' + saying + '" → no match');
        assert.equal(
          match.usageId, usage.id,
          label + ' · persona=' + persona + ' · usage=' + usage.id + ' · saying="' + saying
            + '" got=' + match.usageId + ' alts=' + match.alternatives.join(','),
        );
      });
    });
  });
}

test('coverage (fixture library): 3 typical sayings × 4 personas per usage match to itself', () => {
  assertCoverage(FIXTURE, 'fixture');
});

// The real scene library (web/relay/scenes.zh.json, scenes line). This test
// activates itself the moment the file lands on the branch; until then it
// reports the skip reason instead of passing vacuously. The ≥48-usage count
// gate belongs to the scenes line, not here.
const SCENES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'relay', 'scenes.zh.json');
test('coverage (real scenes.zh.json): 3 typical sayings × 4 personas per usage match to itself', { skip: !existsSync(SCENES_PATH) ? 'web/relay/scenes.zh.json not committed yet (scenes line deliverable)' : false }, () => {
  const payload = JSON.parse(readFileSync(SCENES_PATH, 'utf8'));
  const lib = validateSceneLib(payload);
  assert.ok(lib, 'scenes.zh.json must validate through contracts.validateSceneLib');
  assertCoverage(payload, 'scenes.zh.json');
});
