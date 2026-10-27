// S2D-W6 module 6: patch-parser — utterance → MissionPatch (PRD §11.3).
// Deterministic rule kernel first (zero external calls); an injectable LLM
// interface extends it; every upstream failure is fail-closed
// UPSTREAM_UNAVAILABLE so a discussion can never half-apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePreview } from './_helpers.mjs';

async function loadParser() {
  return import('../../../../scripts/agentic/discussion/patch-parser.mjs');
}

test('rule R1: 只看X constrains sources.include, origin=rules, no LLM call', async () => {
  const { parsePatch } = await loadParser();
  let llmCalls = 0;
  const llm = { parse: async () => { llmCalls += 1; return { format: 'x' }; } };
  const result = await parsePatch('研究只看国内 K12', { llm });
  assert.equal(result.origin, 'rules');
  assert.equal(result.utterance, '研究只看国内 K12');
  assert.deepEqual(result.patch.sources, { include: ['国内 K12'] });
  assert.equal(llmCalls, 0);
});

test('rule R2: 别读我的邮箱 / 不读邮箱 adds a wont boundary', async () => {
  const { parsePatch } = await loadParser();
  const result = await parsePatch('别读我的邮箱');
  assert.deepEqual(result.patch.boundary, { wont: { add: ['读取邮箱'] } });
  const alias = await parsePatch('以后不读邮箱了');
  assert.deepEqual(alias.patch.boundary, { wont: { add: ['读取邮箱'] } });
});

test('rule R3: N 课时 becomes a length patch', async () => {
  const { parsePatch } = await loadParser();
  const result = await parsePatch('课程是给初中老师的 4 课时工作坊');
  assert.deepEqual(result.patch.length, { unit: '课时', value: 4 });
});

test('a combined utterance applies several rules into one patch', async () => {
  const { parsePatch } = await loadParser();
  const result = await parsePatch('研究只看国内 K12，课程是给初中老师的 4 课时工作坊，另外别读我的邮箱');
  assert.deepEqual(result.patch.sources, { include: ['国内 K12'] });
  assert.deepEqual(result.patch.length, { unit: '课时', value: 4 });
  assert.deepEqual(result.patch.boundary, { wont: { add: ['读取邮箱'] } });
});

test('no rule matches and no llm injected → patch null, origin none', async () => {
  const { parsePatch } = await loadParser();
  const result = await parsePatch('标题颜色换成深色');
  assert.equal(result.patch, null);
  assert.equal(result.origin, 'none');
});

test('llm fallback is used only when rules miss; result is passed through as origin=llm', async () => {
  const { parsePatch } = await loadParser();
  const seen = [];
  const llm = { parse: async utterance => { seen.push(utterance); return { format: '深色主题' }; } };
  const result = await parsePatch('标题颜色换成深色', { llm });
  assert.deepEqual(seen, ['标题颜色换成深色']);
  assert.equal(result.origin, 'llm');
  assert.deepEqual(result.patch, { format: '深色主题' });
});

test('llm timeout fails closed with UPSTREAM_UNAVAILABLE', async () => {
  const { parsePatch } = await loadParser();
  const llm = { parse: () => new Promise(() => {}) }; // never resolves
  await assert.rejects(
    () => parsePatch('标题颜色换成深色', { llm, timeoutMs: 25 }),
    error => error.code === 'UPSTREAM_UNAVAILABLE' && /timeout/i.test(error.message),
  );
});

test('llm rejection is wrapped as UPSTREAM_UNAVAILABLE with the cause preserved', async () => {
  const { parsePatch } = await loadParser();
  const cause = new Error('gateway 503');
  const llm = { parse: async () => { throw cause; } };
  await assert.rejects(
    () => parsePatch('标题颜色换成深色', { llm }),
    error => error.code === 'UPSTREAM_UNAVAILABLE' && error.cause === cause,
  );
});

test('llm returning a non-object is treated as upstream failure, not a patch', async () => {
  const { parsePatch } = await loadParser();
  const llm = { parse: async () => '只看国内' };
  await assert.rejects(
    () => parsePatch('标题颜色换成深色', { llm }),
    error => error.code === 'UPSTREAM_UNAVAILABLE',
  );
});

test('empty / whitespace utterance and >2000 chars are CONTRACT_INVALID; 2000 exactly is fine', async () => {
  const { parsePatch } = await loadParser();
  await assert.rejects(() => parsePatch(''), error => error.code === 'CONTRACT_INVALID');
  await assert.rejects(() => parsePatch('   \n\t '), error => error.code === 'CONTRACT_INVALID');
  await assert.rejects(() => parsePatch('长'.repeat(2001)), error => error.code === 'CONTRACT_INVALID');
  const boundary = await parsePatch('长'.repeat(2000));
  assert.equal(boundary.origin, 'none');
});

test('the deterministic kernel performs no I/O (sync-shape contract)', async () => {
  const { parsePatch } = await loadParser();
  // No llm option at all: the default path must never touch network/fs,
  // so parsing a rich utterance is safe in tests without mocks.
  const result = await parsePatch('研究只看国内 K12');
  assert.equal(result.origin, 'rules');
  // Sanity for the fixture used elsewhere: unchanged narration sentences split cleanly.
  assert.ok(makePreview().narration.includes('。'));
});

/* ---- GREEN-stage additions: plan §2 negative paths specific to the parser.
 * The 11 tests above are the frozen RED spec and stay untouched. ---- */

test('near-miss utterances fire no rule (kernel stays precise)', async () => {
  const { parsePatch } = await loadParser();
  // 不只看到… is not a narrowing; 允许读邮箱 is a loosening, not a wont.add;
  // 只看 + only whitespace captures nothing usable.
  for (const utterance of ['不只看到海外案例', '允许读邮箱', '研究只看 ']) {
    const result = await parsePatch(utterance);
    assert.equal(result.patch, null, `${utterance} must not fire a rule`);
    assert.equal(result.origin, 'none');
  }
});

test('顿号 list: 只看A、B splits into separate include entries', async () => {
  const { parsePatch } = await loadParser();
  const result = await parsePatch('研究只看论文、公开官网');
  assert.deepEqual(result.patch.sources, { include: ['论文', '公开官网'] });
});

test('llm null return means "no patch" with origin=llm', async () => {
  const { parsePatch } = await loadParser();
  const llm = { parse: async () => null };
  const result = await parsePatch('标题颜色换成深色', { llm });
  assert.equal(result.patch, null);
  assert.equal(result.origin, 'llm');
});

test('llm returning an array fails closed (an array is not a MissionPatch)', async () => {
  const { parsePatch } = await loadParser();
  const llm = { parse: async () => [{ format: '深色主题' }] };
  await assert.rejects(
    () => parsePatch('标题颜色换成深色', { llm }),
    error => error.code === 'UPSTREAM_UNAVAILABLE' && /array/.test(error.message),
  );
});

test('bad inputs are CONTRACT_INVALID before any llm call; options=null tolerated', async () => {
  const { parsePatch } = await loadParser();
  let calls = 0;
  const llm = { parse: async () => { calls += 1; return null; } };
  await assert.rejects(
    () => parsePatch(42, { llm }),
    error => error.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    () => parsePatch('标题颜色换成深色', { llm: { parse: 'not-a-function' } }),
    error => error.code === 'CONTRACT_INVALID',
  );
  await assert.rejects(
    () => parsePatch('标题颜色换成深色', { llm, timeoutMs: 0 }),
    error => error.code === 'CONTRACT_INVALID',
  );
  assert.equal(calls, 0, 'validation must precede any upstream call');
  const tolerated = await parsePatch('标题颜色换成深色', null);
  assert.equal(tolerated.origin, 'none');
});
