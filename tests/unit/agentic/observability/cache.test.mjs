import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './_harness.mjs';

const cacheApi = () => loadModule('cache.mjs');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const baseInputs = {
  kind: 'block-summary',
  contractHash: HASH_A,
  blockRevision: 'rev-1',
  model: 'gpt-6-luna',
  effort: 'low',
  inputsHash: HASH_B,
};

test('cache: cacheKey is a 64-hex SHA-256 over stable canonical JSON', async () => {
  const { cacheKey } = await cacheApi();
  const key = cacheKey(baseInputs);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(cacheKey({ ...baseInputs }), key);
});

test('cache: cacheKey ignores object key order but not values', async () => {
  const { cacheKey } = await cacheApi();
  const shuffled = Object.fromEntries(Object.entries(baseInputs).reverse());
  assert.equal(cacheKey(shuffled), cacheKey(baseInputs));
  assert.notEqual(cacheKey({ ...baseInputs, blockRevision: 'rev-2' }), cacheKey(baseInputs));
  assert.notEqual(cacheKey({ ...baseInputs, model: 'glm-5.3' }), cacheKey(baseInputs));
});

test('cache: cacheKey requires every identity field, so a partial key cannot collide', async () => {
  const { cacheKey } = await cacheApi();
  for (const field of Object.keys(baseInputs)) {
    const partial = { ...baseInputs };
    delete partial[field];
    assert.throws(() => cacheKey(partial), (error) => error.code === 'CACHE_KEY_INCOMPLETE', `missing ${field}`);
  }
});

test('cache: a matching entry is fresh', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-27T10:00:00.000Z' };
  const verdict = assessCacheEntry(entry, baseInputs);
  assert.equal(verdict.freshness, FRESHNESS.FRESH);
  assert.equal(verdict.stale, false);
  assert.equal(verdict.verifiable, true);
});

test('cache: a changed contractHash makes the entry stale (N7)', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway' };
  const verdict = assessCacheEntry(entry, { ...baseInputs, contractHash: HASH_C });
  assert.equal(verdict.freshness, FRESHNESS.STALE);
  assert.equal(verdict.stale, true);
  assert.ok(verdict.reasons.includes('contractHash'));
});

test('cache: a changed inputsHash makes the entry stale', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway' };
  const verdict = assessCacheEntry(entry, { ...baseInputs, inputsHash: HASH_C });
  assert.equal(verdict.freshness, FRESHNESS.STALE);
  assert.ok(verdict.reasons.includes('inputsHash'));
});

test('cache: a changed blockRevision or model or effort makes the entry stale', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway' };
  for (const [field, value] of [['blockRevision', 'rev-9'], ['model', 'glm-5.3'], ['effort', 'high']]) {
    const verdict = assessCacheEntry(entry, { ...baseInputs, [field]: value });
    assert.equal(verdict.freshness, FRESHNESS.STALE, field);
    assert.ok(verdict.reasons.includes(field), field);
  }
});

test('cache: an entry whose stored key no longer recomputes is stale even if fields match', async () => {
  const { assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: 'f'.repeat(64), modelSource: 'gateway' };
  const verdict = assessCacheEntry(entry, baseInputs);
  assert.equal(verdict.freshness, FRESHNESS.STALE);
  assert.ok(verdict.reasons.includes('key'));
});

test('cache: a mock-sourced entry is unverifiable, never a success (N8)', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'mock' };
  const verdict = assessCacheEntry(entry, baseInputs);
  assert.equal(verdict.verifiable, false);
  assert.equal(verdict.freshness, FRESHNESS.UNVERIFIABLE);
  assert.ok(verdict.reasons.includes('modelSource'));
});

test('cache: an unknown-sourced entry is unverifiable', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'unknown' };
  const verdict = assessCacheEntry(entry, baseInputs);
  assert.equal(verdict.freshness, FRESHNESS.UNVERIFIABLE);
  assert.equal(verdict.verifiable, false);
});

test('cache: a time-expired but content-matching entry is expired-but-matching, not stale', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = {
    ...baseInputs,
    key: cacheKey(baseInputs),
    modelSource: 'gateway',
    createdAt: '2026-10-20T10:00:00.000Z',
  };
  const verdict = assessCacheEntry(entry, baseInputs, { now: '2026-10-27T10:00:00.000Z', ttlMs: 24 * 3600 * 1000 });
  assert.equal(verdict.freshness, FRESHNESS.EXPIRED_BUT_MATCHING);
  assert.equal(verdict.stale, false);
  assert.equal(verdict.expired, true);
  assert.equal(verdict.verifiable, true);
});

test('cache: a within-TTL matching entry is FRESH', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const verdict = assessCacheEntry(entry, baseInputs, { now: '2026-10-27T10:00:00.000Z', ttlMs: 24 * 3600 * 1000 });
  assert.equal(verdict.freshness, FRESHNESS.FRESH);
});

test('cache: an entry with no createdAt cannot claim freshness', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway' };
  const verdict = assessCacheEntry(entry, baseInputs, { now: '2026-10-27T10:00:00.000Z', ttlMs: 1000 });
  assert.equal(verdict.freshness, FRESHNESS.UNVERIFIABLE);
  assert.ok(verdict.reasons.includes('createdAt'));
});

test('cache: stale entries never enter the verified set (N7/N8)', async () => {
  const { cacheKey, partitionCacheEntries } = await cacheApi();
  const fresh = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const stale = { ...baseInputs, key: 'f'.repeat(64), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const mock = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'mock', createdAt: '2026-10-27T09:00:00.000Z' };
  const partition = partitionCacheEntries([fresh, stale, mock], baseInputs, {
    now: '2026-10-27T10:00:00.000Z',
    ttlMs: 24 * 3600 * 1000,
  });
  assert.deepEqual(partition.verified.map((entry) => entry.modelSource), ['gateway']);
  assert.equal(partition.stale.length, 1);
  assert.equal(partition.unverifiable.length, 1);
  assert.equal(partition.verified.length + partition.stale.length + partition.unverifiable.length, 3);
});

test('cache: partitioned entries carry the reason they were rejected', async () => {
  // A bucket that drops its reasons forces a report to claim STALE with
  // nothing behind it, so the verdict travels with the entry.
  const { cacheKey, partitionCacheEntries } = await cacheApi();
  const fresh = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const stale = { ...baseInputs, key: 'f'.repeat(64), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const mock = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'mock', createdAt: '2026-10-27T09:00:00.000Z' };
  const partition = partitionCacheEntries([fresh, stale, mock], baseInputs, {
    now: '2026-10-27T10:00:00.000Z',
    ttlMs: 24 * 3600 * 1000,
  });
  assert.equal(partition.verified[0].freshness, 'FRESH');
  assert.deepEqual(partition.verified[0].reasons, []);
  assert.equal(partition.stale[0].freshness, 'STALE');
  assert.ok(partition.stale[0].reasons.includes('key'));
  assert.ok(partition.unverifiable[0].reasons.includes('modelSource'));
});

test('cache: a refreshed entry re-keys to the current identity', async () => {
  const { cacheKey, refreshCacheEntry } = await cacheApi();
  const entry = { ...baseInputs, key: 'f'.repeat(64), modelSource: 'gateway', createdAt: '2026-10-20T10:00:00.000Z' };
  const refreshed = refreshCacheEntry(entry, { ...baseInputs, inputsHash: HASH_C });
  assert.equal(refreshed.key, cacheKey({ ...baseInputs, inputsHash: HASH_C }));
  assert.equal(refreshed.inputsHash, HASH_C);
  assert.match(refreshed.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('cache: cacheKey rejects non-object inputs instead of hashing garbage', async () => {
  const { cacheKey } = await cacheApi();
  for (const bad of [null, undefined, ['kind'], 'block-summary', 42]) {
    assert.throws(() => cacheKey(bad), (error) => error.code === 'CACHE_KEY_INCOMPLETE', `input ${JSON.stringify(bad)}`);
  }
});

test('cache: cacheKey rejects blank field values, not just missing ones', async () => {
  // A whitespace-only model would otherwise hash to a key that looks complete.
  const { cacheKey } = await cacheApi();
  assert.throws(
    () => cacheKey({ ...baseInputs, model: '   ' }),
    (error) => error.code === 'CACHE_KEY_INCOMPLETE' && /model/.test(error.message),
  );
});

test('cache: assessCacheEntry rejects a non-object entry', async () => {
  const { assessCacheEntry } = await cacheApi();
  for (const bad of [null, undefined, ['entry'], 'entry']) {
    assert.throws(() => assessCacheEntry(bad, baseInputs), (error) => error.code === 'CACHE_UNVERIFIABLE', `entry ${JSON.stringify(bad)}`);
  }
});

test('cache: a verifiable entry with no stored key is stale, not fresh', async () => {
  const { assessCacheEntry, FRESHNESS } = await cacheApi();
  const verdict = assessCacheEntry({ ...baseInputs, modelSource: 'gateway' }, baseInputs);
  assert.equal(verdict.freshness, FRESHNESS.STALE);
  assert.ok(verdict.reasons.includes('key'));
});

test('cache: a clock without a TTL cannot expire a matching entry', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-01T10:00:00.000Z' };
  // Weeks old, but with no TTL to compare against the content still matches.
  const verdict = assessCacheEntry(entry, baseInputs, { now: '2026-10-27T10:00:00.000Z' });
  assert.equal(verdict.freshness, FRESHNESS.FRESH);
  assert.equal(verdict.expired, false);
});

test('cache: a TTL without a clock is unverifiable, never quietly fresh', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const verdict = assessCacheEntry(entry, baseInputs, { ttlMs: 1000 });
  assert.equal(verdict.freshness, FRESHNESS.UNVERIFIABLE);
  assert.equal(verdict.verifiable, false);
});

test('cache: a non-numeric ttlMs is ignored as no TTL at all', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-01T10:00:00.000Z' };
  const verdict = assessCacheEntry(entry, baseInputs, { now: '2026-10-27T10:00:00.000Z', ttlMs: '1 day' });
  assert.equal(verdict.freshness, FRESHNESS.FRESH);
});

test('cache: an unparseable now string is treated as no usable clock', async () => {
  const { cacheKey, assessCacheEntry, FRESHNESS } = await cacheApi();
  const entry = { ...baseInputs, key: cacheKey(baseInputs), modelSource: 'gateway', createdAt: '2026-10-27T09:00:00.000Z' };
  const verdict = assessCacheEntry(entry, baseInputs, { now: 'not-a-date', ttlMs: 1000 });
  assert.equal(verdict.freshness, FRESHNESS.UNVERIFIABLE);
  assert.ok(verdict.reasons.includes('createdAt'));
});

test('cache: an expired-but-matching entry is recorded in verified with its marker, never in stale', async () => {
  // plan §2.3: content-identical but past TTL is "recorded, not stale" — the
  // freshness marker travels with it so no downstream reader can mistake it
  // for a fresh hit.
  const { cacheKey, partitionCacheEntries, FRESHNESS } = await cacheApi();
  const expired = {
    ...baseInputs,
    key: cacheKey(baseInputs),
    modelSource: 'gateway',
    createdAt: '2026-10-01T10:00:00.000Z',
  };
  const partition = partitionCacheEntries([expired], baseInputs, {
    now: '2026-10-27T10:00:00.000Z',
    ttlMs: 24 * 3600 * 1000,
  });
  assert.equal(partition.stale.length, 0);
  assert.equal(partition.unverifiable.length, 0);
  assert.equal(partition.verified.length, 1);
  assert.equal(partition.verified[0].freshness, FRESHNESS.EXPIRED_BUT_MATCHING);
});

test('cache: partitionCacheEntries over a non-array input yields empty buckets', async () => {
  const { partitionCacheEntries } = await cacheApi();
  for (const bad of [null, undefined, 'nope']) {
    const partition = partitionCacheEntries(bad, baseInputs);
    assert.deepEqual(partition, { verified: [], stale: [], unverifiable: [] }, `input ${JSON.stringify(bad)}`);
  }
});
