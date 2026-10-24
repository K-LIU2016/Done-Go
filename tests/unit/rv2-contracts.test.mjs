import assert from 'node:assert/strict';
import { test } from 'node:test';

// RV2 contract line: web/relay/contracts.js is the single source of truth for
// the relay v2 data shapes (SPEC design/relay-v2/SPEC.md §5). Every later
// relay line imports these names instead of redefining them.
//
// Pinned decisions (documented in contracts.js):
// - D9: the store key is account-scoped via TangoAccountStorage; the scope
//   regex in web/app-auth.js must learn 'relay.v2' (integration line).
// - D3/SPEC §1.5: estimatedSavedMinutes can never survive any v2 shape.
// - D10/SPEC §5.5: metric bodies carry exactly {event} — counts, no content.
// - Migrated ai-relay.v1 records keep usageId:null (SPEC defines no mapping).

import {
  RELAY_STORE_KEY, RELAY_STORE_VERSION, LEGACY_V1_STORE_KEY,
  RELAY_QUARANTINE_SUFFIX, quarantineKey, MAX_RECORDS,
  RATINGS, FAIL_TYPES, PERSONAS, CATEGORIES,
  MATERIAL_MAX, RESULT_MAX, EVENT_MAX, BATON_MATERIAL_PREVIEW_MAX,
  createRecord, sanitizeRecord, sanitizeStoreText, migrateLegacyText,
  validateUsage, validateSceneLib, checkMaterial, batonMaterialPreview,
  validateRelayRequest, sanitizeRelayResult,
  validateRouteRequest, sanitizeRouteResult,
  METRIC_BASE_EVENTS, METRIC_PARAM_EVENTS, metricEvent, metricPayload, sanitizeMetricBody,
} from '../../web/relay/contracts.js';

const UUID = (n) => String(n).padStart(8, '0') + '-1111-4111-8111-111111111111';
const mkRecord = (n) => ({
  id: UUID(n), at: '2026-10-01T00:00:00.000Z', event: 'e' + n, usageId: 'meeting-notes',
  result: 'r' + n, rating: null, graduated: false, graduatedApp: null, failed: null,
});
const RECORD_KEYS = ['at', 'event', 'failed', 'graduated', 'graduatedApp', 'id', 'rating', 'result', 'usageId'];
const SPEC_USAGE = {
  id: 'meeting-notes', title: '整理会议纪要', category: '整理',
  does: ['列出重点', '拆出待办和负责人', '标出没说清的地方'],
  materialLabel: '把会议内容给我', materialHint: '把聊天记录、笔记或转写文字粘贴到这里……',
  learned: '把会议材料交给 AI，先要「重点、待办、没说清的地方」。',
  externalPrompt: '请把下面的会议内容整理成三部分：1. 会议重点；2. 待办（写清负责人）；3. 没说清、需要追问的地方。只根据内容整理，不要补充没提到的信息。\n会议内容：{{material}}',
  keywords: ['会议', '开会', '纪要', '组会', '周会', '例会', '录音'],
  personas: { student: { featured: true, title: '整理组会纪要', hint: '重点、待办、待补充' }, worker: { featured: true } },
};

test('storage constants pin the SPEC §5.4 keys and caps', () => {
  assert.equal(RELAY_STORE_KEY, 'tango-donego.relay.v2');
  assert.equal(RELAY_STORE_VERSION, 2);
  assert.equal(LEGACY_V1_STORE_KEY, 'tango-donego.ai-relay.v1');
  assert.equal(MAX_RECORDS, 200);
  assert.equal(RELAY_QUARANTINE_SUFFIX, '.quarantine');
  assert.equal(quarantineKey(RELAY_STORE_KEY), 'tango-donego.relay.v2.quarantine');
  assert.deepEqual(RATINGS, ['much', 'little', 'none']);
  assert.deepEqual(FAIL_TYPES, ['unconfigured', 'timeout', 'ratelimit', 'upstream', 'format']);
  assert.deepEqual(PERSONAS, ['student', 'teacher', 'worker', 'elder']);
  assert.deepEqual(CATEGORIES, ['写', '读', '整理', '计划', '翻译', '生活']);
  assert.equal(MATERIAL_MAX, 8000);
  assert.equal(RESULT_MAX, 12000);
  assert.equal(EVENT_MAX, 600);
  assert.equal(BATON_MATERIAL_PREVIEW_MAX, 200);
});

test('createRecord produces a schema-valid record with v2 defaults', () => {
  const record = createRecord({ event: ' 整理周会记录 ', usageId: 'meeting-notes', result: '一版' },
    { now: 1760000000000, uuid: UUID(7) });
  assert.ok(record);
  assert.equal(record.id, UUID(7));
  assert.equal(record.at, new Date(1760000000000).toISOString());
  assert.equal(record.event, '整理周会记录');
  assert.equal(record.usageId, 'meeting-notes');
  assert.equal(record.result, '一版');
  assert.equal(record.rating, null);
  assert.equal(record.graduated, false);
  assert.equal(record.graduatedApp, null);
  assert.equal(record.failed, null);
  assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
});

test('createRecord rejects untrustworthy input and caps the event', () => {
  assert.equal(createRecord({ event: '   ', usageId: 'meeting-notes' }), null);
  assert.equal(createRecord({ event: 'e', usageId: 'Meeting Notes' }), null);
  assert.equal(createRecord({ event: 'e' }), null);
  assert.equal(createRecord({ event: 'e', usageId: 'meeting-notes', rating: 'alot' }), null);
  assert.equal(createRecord({ event: 'e', usageId: 'meeting-notes', failed: 'crash' }), null);
  const capped = createRecord({ event: '事'.repeat(700), usageId: 'meeting-notes' });
  assert.equal(capped.event.length, EVENT_MAX);
  const defaultId = createRecord({ event: 'e', usageId: 'meeting-notes' });
  assert.match(defaultId.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('sanitizeRecord whitelists the 8 v2 fields and never revives minutes', () => {
  const tainted = Object.assign(mkRecord(1), { estimatedSavedMinutes: 15, learned: 'x', type: '会议整理', extra: true });
  const clean = sanitizeRecord(tainted);
  assert.deepEqual(Object.keys(clean).sort(), RECORD_KEYS);
  assert.ok(!('estimatedSavedMinutes' in clean));
  const legacy = sanitizeRecord(Object.assign(mkRecord(2), { usageId: null }));
  assert.equal(legacy.usageId, null);
  assert.equal(sanitizeRecord(Object.assign(mkRecord(3), { at: '昨天' })), null);
  assert.equal(sanitizeRecord(Object.assign(mkRecord(4), { event: '  ' })), null);
  assert.equal(sanitizeRecord(Object.assign(mkRecord(5), { id: '123' })), null);
  assert.equal(sanitizeRecord(Object.assign(mkRecord(6), { rating: 'alot' })), null);
  assert.equal(sanitizeRecord(Object.assign(mkRecord(7), { failed: 'kaput' })), null);
  assert.equal(sanitizeRecord(Object.assign(mkRecord(8), { graduatedApp: 'Doubao!' })), null);
  const long = sanitizeRecord(Object.assign(mkRecord(9), { result: '字'.repeat(RESULT_MAX + 1) }));
  assert.equal(long.result.length, RESULT_MAX);
  assert.equal(sanitizeRecord('not an object'), null);
  assert.equal(sanitizeRecord(null), null);
});

test('sanitizeStoreText: fresh, capped at 200, unknown versions quarantined', () => {
  const fresh = sanitizeStoreText(null);
  assert.equal(fresh.status, 'empty');
  assert.deepEqual(fresh.store, { v: 2, records: [] });
  const ok = sanitizeStoreText(JSON.stringify({ v: 2, records: [mkRecord(1), mkRecord(2)] }));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.store.records.length, 2);
  const many = [];
  for (let i = 0; i < 205; i += 1) many.push(mkRecord(i));
  const capped = sanitizeStoreText(JSON.stringify({ v: 2, records: many }));
  assert.equal(capped.store.records.length, MAX_RECORDS);
  assert.equal(capped.store.records[0].event, 'e0');
  assert.equal(capped.store.records[199].event, 'e199');
  const mixed = sanitizeStoreText(JSON.stringify({ v: 2, records: [mkRecord(1), { id: 'x' }, 'junk', mkRecord(2)] }));
  assert.equal(mixed.store.records.length, 2);
  assert.equal(sanitizeStoreText(JSON.stringify({ v: 3, records: [] })).status, 'unknown');
  assert.equal(sanitizeStoreText(JSON.stringify({ records: [] })).status, 'unknown');
  const unknownJson = sanitizeStoreText('{oops');
  assert.equal(unknownJson.status, 'unknown');
  assert.equal('store' in unknownJson, false);
});

test('migrateLegacyText follows SPEC §5.4 (drop minutes, rating null)', () => {
  const v1 = JSON.stringify({ v: 1, records: [
    { id: '1760000000000', event: '整理会议', type: '会议整理', result: '纪要', learned: '先要重点', estimatedSavedMinutes: 15, savedAt: '2026-10-20' },
    { id: '1760000000001', event: '写周报', type: '写作起草', result: '', learned: '先列提纲', estimatedSavedMinutes: 10 },
  ] });
  const migrated = migrateLegacyText(v1, { now: 1760000099999, uuids: [UUID(1), UUID(2)] });
  assert.equal(migrated.status, 'ok');
  assert.equal(migrated.store.v, 2);
  assert.equal(migrated.store.records.length, 2);
  const first = migrated.store.records[0];
  assert.equal(first.id, UUID(1));
  assert.equal(first.at, '2026-10-20T00:00:00.000Z');
  assert.equal(first.event, '整理会议');
  assert.equal(first.usageId, null);
  assert.equal(first.rating, null);
  assert.equal(first.graduated, false);
  assert.ok(!('estimatedSavedMinutes' in first));
  assert.ok(!('learned' in first));
  assert.ok(!('type' in first));
  assert.equal(migrated.store.records[1].at, new Date(1760000099999).toISOString());
  assert.deepEqual(Object.keys(migrated.store.records[0]).sort(), RECORD_KEYS);
  assert.equal(migrateLegacyText('').status, 'empty');
  assert.equal(migrateLegacyText(null).status, 'empty');
  assert.equal(migrateLegacyText(JSON.stringify({ v: 1, records: [] })).status, 'empty');
  assert.equal(migrateLegacyText('{oops').status, 'empty');
  const dropped = migrateLegacyText(JSON.stringify({ v: 1, records: [{ event: '   ' }] }));
  assert.equal(dropped.status, 'empty');
});

test('validateUsage accepts the SPEC §5.1 example and sanitizes personas', () => {
  const usage = validateUsage(SPEC_USAGE);
  assert.ok(usage);
  assert.equal(usage.id, 'meeting-notes');
  assert.equal(usage.category, '整理');
  assert.equal(usage.does.length, 3);
  assert.ok(usage.externalPrompt.includes('{{material}}'));
  assert.equal(usage.personas.student.title, '整理组会纪要');
  assert.equal(usage.personas.worker.featured, true);
  assert.equal(usage.personas.worker.title, undefined);
  assert.deepEqual(Object.keys(usage.personas).sort(), ['student', 'worker']);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { personas: { alien: { featured: true } } })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { externalPrompt: '没有占位符的模板' })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { category: '其他' })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { does: [] })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { does: ['', '  '] })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { id: 'Meeting Notes' })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { title: '  ' })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { keywords: [] })), null);
  assert.equal(validateUsage(Object.assign({}, SPEC_USAGE, { materialHint: '' })), null);
  const long = validateUsage(Object.assign({}, SPEC_USAGE, { externalPrompt: 'x'.repeat(2001) + '{{material}}' }));
  assert.equal(long, null);
  assert.equal(validateUsage(null), null);
});

test('validateSceneLib enforces version 1 and unique usage ids', () => {
  const lib = validateSceneLib({ version: 1, usages: [SPEC_USAGE] });
  assert.ok(lib);
  assert.equal(lib.version, 1);
  assert.equal(lib.usages[0].id, 'meeting-notes');
  const other = Object.assign({}, SPEC_USAGE, { id: 'weekly-report' });
  assert.equal(validateSceneLib({ version: 1, usages: [SPEC_USAGE, other] }).usages.length, 2);
  assert.equal(validateSceneLib({ version: 1, usages: [SPEC_USAGE, SPEC_USAGE] }), null);
  assert.equal(validateSceneLib({ version: 2, usages: [SPEC_USAGE] }), null);
  assert.equal(validateSceneLib({ usages: [SPEC_USAGE] }), null);
  assert.equal(validateSceneLib({ version: 1, usages: [SPEC_USAGE, { id: 'broken' }] }), null);
  assert.equal(validateSceneLib({ version: 1, usages: [] }), null);
  assert.equal(validateSceneLib(null), null);
});

test('checkMaterial and batonMaterialPreview implement §4②/§4④ caps', () => {
  assert.deepEqual(checkMaterial(''), { ok: false, reason: 'empty', value: '' });
  assert.equal(checkMaterial('   ').reason, 'empty');
  assert.equal(checkMaterial('x'.repeat(8000)).ok, true);
  assert.equal(checkMaterial('x'.repeat(8001)).reason, 'too_long');
  assert.equal(batonMaterialPreview('x'.repeat(250)).length, 200);
  assert.equal(batonMaterialPreview('短材料'), '短材料');
});

test('validateRelayRequest accepts only the SPEC §5.3 relay body', () => {
  const ok = validateRelayRequest({ mode: 'relay', stream: true, prompt: '请整理：<材料>…' });
  assert.deepEqual(ok, { mode: 'relay', stream: true, prompt: '请整理：<材料>…' });
  assert.equal(validateRelayRequest({ mode: 'relay', prompt: 'p' }).stream, false);
  assert.equal(validateRelayRequest({ mode: 'route', prompt: 'p' }), null);
  assert.equal(validateRelayRequest({ mode: 'relay', prompt: '' }), null);
  assert.equal(validateRelayRequest({ mode: 'relay', prompt: 'x'.repeat(10001) }), null);
  assert.equal(validateRelayRequest({ mode: 'relay', stream: 'yes', prompt: 'p' }), null);
  assert.deepEqual(Object.keys(ok).sort(), ['mode', 'prompt', 'stream']);
});

test('sanitizeRelayResult validates and truncates the final frame (§5.3)', () => {
  const good = { sections: [{ title: '会议重点', items: ['一', '二'] }], learned: '一句话', followups: ['更短一点'] };
  const clean = sanitizeRelayResult(good);
  assert.deepEqual(clean, { sections: [{ title: '会议重点', items: ['一', '二'] }], learned: '一句话', followups: ['更短一点'] });
  const framed = sanitizeRelayResult('前置说明 {"sections":[{"title":"重点","items":["含 } 的条目"]}],"learned":"学会"} 后缀');
  assert.equal(framed.learned, '学会');
  assert.equal(framed.sections[0].items[0], '含 } 的条目');
  const wide = sanitizeRelayResult({
    sections: Array.from({ length: 7 }, (_, i) => ({ title: 't' + i, items: ['字'.repeat(400)].concat(Array.from({ length: 12 }, (_, j) => 'i' + j)) })),
    learned: 'l',
  });
  assert.equal(wide.sections.length, 5);
  assert.equal(wide.sections[0].items.length, 10);
  assert.equal(wide.sections[0].items[0].length, 300);
  const tainted = sanitizeRelayResult(Object.assign({}, good, { estimatedSavedMinutes: 15 }));
  assert.deepEqual(Object.keys(tainted).sort(), ['followups', 'learned', 'sections']);
  assert.ok(!('estimatedSavedMinutes' in tainted));
  const manyFollowups = sanitizeRelayResult({ sections: good.sections, learned: 'l', followups: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal(manyFollowups.followups.length, 3);
  const noFollowups = sanitizeRelayResult({ sections: good.sections, learned: 'l' });
  assert.deepEqual(noFollowups.followups, []);
  assert.equal(sanitizeRelayResult({ sections: [], learned: 'l' }), null);
  assert.equal(sanitizeRelayResult({ sections: [{ title: 't', items: [] }, { title: ' ', items: ['x'] }], learned: 'l' }), null);
  assert.equal(sanitizeRelayResult({ sections: good.sections }), null);
  assert.equal(sanitizeRelayResult('完全不是 JSON'), null);
  assert.equal(sanitizeRelayResult(42), null);
});

test('validateRouteRequest accepts the SPEC §5.3 route body', () => {
  const ok = validateRouteRequest({ mode: 'route', event: '整理组会纪要' });
  assert.deepEqual(ok, { mode: 'route', event: '整理组会纪要' });
  assert.equal(validateRouteRequest({ mode: 'relay', event: 'e' }), null);
  assert.equal(validateRouteRequest({ mode: 'route', event: '  ' }), null);
  assert.equal(validateRouteRequest({ mode: 'route', event: 'x'.repeat(601) }), null);
  assert.deepEqual(Object.keys(ok).sort(), ['event', 'mode']);
});

test('sanitizeRouteResult constrains answers to scene-library ids', () => {
  const known = ['meeting-notes', 'weekly-report', 'translate-paper', 'trip-plan'];
  const ok = sanitizeRouteResult({ usageId: 'meeting-notes', confidence: 0.72, alternatives: ['meeting-notes', 'translate-paper', 'ghost', 'translate-paper', 'trip-plan', 'extra'] }, known);
  assert.deepEqual(ok, { usageId: 'meeting-notes', confidence: 0.72, alternatives: ['translate-paper', 'trip-plan'] });
  assert.equal(sanitizeRouteResult({ usageId: 'ghost', confidence: 0.9, alternatives: [] }, known), null);
  assert.equal(sanitizeRouteResult({ usageId: 'meeting-notes', confidence: 1.5, alternatives: [] }, known), null);
  assert.equal(sanitizeRouteResult({ usageId: 'meeting-notes', confidence: -0.1, alternatives: [] }, known), null);
  assert.equal(sanitizeRouteResult({ usageId: 'meeting-notes', confidence: '0.5', alternatives: [] }, known), null);
  assert.deepEqual(sanitizeRouteResult({ usageId: 'meeting-notes', confidence: 0 }, known).alternatives, []);
  assert.equal(sanitizeRouteResult({ usageId: 'meeting-notes', confidence: 0.5, alternatives: [] }, []), null);
  assert.equal(sanitizeRouteResult('junk', known), null);
});

test('metricEvent enumerates exactly the SPEC §5.5 funnel (D10)', () => {
  assert.deepEqual(METRIC_BASE_EVENTS, ['start_submit', 'scene_click', 'match_shown', 'match_switch', 'relay_send', 'relay_ok', 'stop', 'signup_nudge_click']);
  assert.deepEqual(Object.keys(METRIC_PARAM_EVENTS).sort(), ['baton_copy', 'graduated', 'rate', 'relay_fail']);
  for (const name of METRIC_BASE_EVENTS) assert.equal(metricEvent(name), name);
  assert.equal(metricEvent('stop', 'x'), null);
  assert.equal(metricEvent('relay_fail', 'timeout'), 'relay_fail:timeout');
  assert.equal(metricEvent('relay_fail', 'crash'), null);
  assert.equal(metricEvent('rate', 'much'), 'rate:much');
  assert.equal(metricEvent('rate', 'alot'), null);
  assert.equal(metricEvent('baton_copy', 'doubao'), 'baton_copy:doubao');
  assert.equal(metricEvent('baton_copy', 'Deep Seek'), null);
  assert.equal(metricEvent('baton_copy', 'deepseek', { apps: ['doubao', 'kimi'] }), null);
  assert.equal(metricEvent('baton_copy', 'kimi', { apps: ['doubao', 'kimi'] }), 'baton_copy:kimi');
  assert.equal(metricEvent('graduated', 'doubao'), 'graduated:doubao');
  assert.equal(metricEvent('relay_sent'), null);
  assert.equal(metricEvent('relay_fail'), null);
});

test('metric bodies are count-only: exactly {event}, nothing else (D10)', () => {
  assert.deepEqual(metricPayload('relay_ok'), { event: 'relay_ok' });
  assert.deepEqual(metricPayload('relay_fail', 'timeout'), { event: 'relay_fail:timeout' });
  assert.deepEqual(sanitizeMetricBody({ event: 'relay_fail:timeout' }), { event: 'relay_fail:timeout' });
  assert.deepEqual(sanitizeMetricBody({ event: 'stop' }), { event: 'stop' });
  assert.deepEqual(sanitizeMetricBody({ event: 'baton_copy', text: '会议内容' }), null);
  assert.equal(sanitizeMetricBody({ event: 'relay_ok', user: 'jc' }), null);
  assert.equal(sanitizeMetricBody({ event: 'relay_ok', count: 1 }), null);
  assert.equal(sanitizeMetricBody({ event: 'nope' }), null);
  assert.equal(sanitizeMetricBody({ event: 'relay_fail:timeout:x' }), null);
  assert.equal(sanitizeMetricBody('relay_ok'), null);
  assert.equal(sanitizeMetricBody(null), null);
});
