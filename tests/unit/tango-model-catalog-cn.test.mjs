import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// The catalog is a plain browser script like web/privacy.js: an IIFE that
// attaches its API to `window`. Loading it in a bare vm context (no document)
// also proves it has no DOM dependency.
const source = readFileSync(new URL('../../web/model-catalog-cn.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const catalog = context.window.TangoModelCatalogCN;

const EXPECTED_IDS = ['doubao-seed-2.1', 'deepseek-v4.1-flash', 'qwen3.8-max', 'kimi-k3', 'tencent-yuanbao'];
const HTTPS = /^https:\/\//;
const DATA_FIELDS = ['vendor', 'displayName', 'descZh', 'appUrl', 'capabilityUrl', 'taskFit'];
const nonCN = (modelId) => ({ modelId, vendor: 'vendor-' + modelId });
const ids = (list) => Array.from(list, (m) => m.modelId);

test('module loads without any DOM globals and exports its API', () => {
  assert.equal(context.document, undefined);
  assert.ok(catalog, 'TangoModelCatalogCN attaches to window');
  assert.equal(typeof catalog.sortModels, 'function');
});

test('catalog holds exactly the five CN models with unique ids', () => {
  assert.equal(catalog.CN_MODELS.length, 5);
  assert.deepEqual(Array.from(catalog.CN_MODEL_IDS), EXPECTED_IDS);
  const seen = new Set();
  for (const entry of catalog.CN_MODELS) assert.ok(!seen.has(entry.modelId) && seen.add(entry.modelId), 'unique modelId ' + entry.modelId);
});

test('data completeness: official capability link or explicit 未核验 marker, and a verification date, on every entry', () => {
  for (const entry of catalog.CN_MODELS) {
    assert.ok(typeof entry.accessDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.accessDate) && Number.isFinite(Date.parse(entry.accessDate)), entry.modelId + ' needs an accessDate');
    for (const key of ['appUrl', 'capabilityUrl']) {
      assert.ok(entry[key] === '未核验' || (typeof entry[key] === 'string' && HTTPS.test(entry[key])), entry.modelId + ' ' + key + ' must be an https official link or 未核验');
    }
    for (const key of ['vendor', 'displayName', 'descZh', 'taskFit']) {
      assert.ok(entry[key] === '未核验' || (typeof entry[key] === 'string' && entry[key].trim().length > 0), entry.modelId + ' ' + key + ' must be non-empty text or 未核验');
    }
    assert.equal(typeof entry.verified, 'boolean', entry.modelId + ' verified flag');
  }
});

test('entries not marked verified carry 未核验 in every data field', () => {
  for (const entry of catalog.CN_MODELS) {
    if (entry.verified === true) continue;
    for (const key of DATA_FIELDS) assert.equal(entry[key], '未核验', entry.modelId + ' ' + key);
  }
});

test('zh locale: CN models first, relative order stable inside both groups', () => {
  const input = [
    nonCN('claude-sonnet-5.5'),
    catalog.CN_MODELS[3],
    nonCN('gpt-5.4'),
    catalog.CN_MODELS[0],
    nonCN('gemini-3.1-pro-preview'),
    catalog.CN_MODELS[2]
  ];
  const sorted = catalog.sortModels(input, 'zh');
  assert.deepEqual(ids(sorted), [
    'kimi-k3', 'doubao-seed-2.1', 'qwen3.8-max',
    'claude-sonnet-5.5', 'gpt-5.4', 'gemini-3.1-pro-preview'
  ]);
});

test('zh-CN and zh-TW count as Chinese; other locales keep the input order', () => {
  const input = [nonCN('gpt-5.4'), catalog.CN_MODELS[0], nonCN('claude-sonnet-5.5')];
  assert.deepEqual(ids(catalog.sortModels(input, 'zh-CN')), ['doubao-seed-2.1', 'gpt-5.4', 'claude-sonnet-5.5']);
  assert.deepEqual(ids(catalog.sortModels(input, 'zh-TW')), ['doubao-seed-2.1', 'gpt-5.4', 'claude-sonnet-5.5']);
  for (const locale of ['en', 'ru', 'th', 'ar', 'ko', undefined, 'ZH']) {
    assert.deepEqual(ids(catalog.sortModels(input, locale)), ['gpt-5.4', 'doubao-seed-2.1', 'claude-sonnet-5.5'], 'locale ' + locale + ' keeps input order');
  }
});

test('sortModels is pure: fresh array, input never mutated, entries shared not cloned', () => {
  const input = [nonCN('gpt-5.4'), catalog.CN_MODELS[1], nonCN('gemini-3.1-pro-preview')];
  const before = input.map((m) => m.modelId);
  const sorted = catalog.sortModels(input, 'zh');
  assert.deepEqual(Array.from(input, (m) => m.modelId), before, 'input order untouched');
  assert.notEqual(sorted, input, 'returns a new array');
  assert.equal(sorted[0], catalog.CN_MODELS[1], 'entries are shared, not cloned');
  assert.equal(catalog.sortModels([], 'zh').length, 0, 'empty input stays empty');
});

test('entries without a catalog modelId (unknown ids, tuple rows) sort as non-CN', () => {
  const tupleRow = ['Anthropic', 'Claude Sonnet 5.5', '长上下文。', 'https://claude.ai/', 'https://example.invalid/docs'];
  const input = [tupleRow, { modelId: 'unknown-model' }, catalog.CN_MODELS[4]];
  const sorted = catalog.sortModels(input, 'zh');
  assert.equal(sorted[0].modelId, 'tencent-yuanbao');
  assert.equal(sorted[1], tupleRow);
  assert.equal(sorted[2].modelId, 'unknown-model');
});
