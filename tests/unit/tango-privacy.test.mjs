import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {}, URL });
vm.runInContext(readFileSync(new URL('../../web/privacy.js', import.meta.url), 'utf8'), context);
const privacy = context.window.TangoPrivacy;

test('a user can spend a freed personal interval on necessary work and reload it', () => {
  const result = privacy.validateState({ v: 1, mode: 'real', entries: [{ id: 'chosen-work', date: '2026-10-16', title: '处理报销', kind: 'stillness', start: '18:00', end: '18:20', state: 'reserved', kept: 0, use: 'necessary' }] });
  assert.equal(result.ok, true);
  assert.equal(result.state.entries[0].use, 'necessary');
});
const item = { id: 'paper', date: '2026-10-14', title: '读论文', kind: 'explore', start: '09:00', end: '10:00' };
const state = { v: 1, entries: [item] };

test('optional completion time and a user-entered model survive export and reload without inventing zero', () => {
  const completion = { actual: null, timeRecorded: false, before: 60, plannedEnd: '10:00', usedAI: true, modelName: 'gpt-6.1-sol', modelId: 'unknown', quality: 'pending' };
  const result = privacy.validateState({ ...state, entries: [{ ...item, done: true, completion }] });
  assert.equal(result.ok, true);
  assert.equal(result.state.entries[0].completion.actual, null);
  assert.equal(result.state.entries[0].completion.modelName, 'gpt-6.1-sol');
  for (const invalid of [{ ...completion, timeRecorded: undefined }, { ...completion, actual: 0 }, { ...completion, modelName: 'x'.repeat(81) }]) {
    assert.equal(privacy.validateState({ ...state, entries: [{ ...item, done: true, completion: invalid }] }).ok, false);
  }
});

test('credentials never enter saved preferences, including migrated legacy keys', () => {
  const migrated = privacy.preferences({ mode: 'custom', url: 'https://api.example.com', model: 'test', key: 'legacy-secret', consent: true });
  assert.equal(migrated.key, '');
  assert.equal(migrated.consent, false);
  const saved = privacy.storablePreferences({ ...migrated, key: 'session-secret', consent: true });
  assert.equal(JSON.stringify(saved).includes('secret'), false);
  assert.equal('key' in saved, false);
});

test('custom credentials can only travel to HTTPS or local HTTP endpoints', () => {
  for (const url of ['https://api.example.com/v1', 'http://localhost:3458/v1', 'http://127.0.0.1:3458/v1', 'http://[::1]:3458/v1']) assert.equal(privacy.safeEndpoint(url), true, url);
  for (const url of ['http://api.example.com', 'javascript:alert(1)', 'https://user:pass@api.example.com', 'http://127.0.0.1.evil.com', '//example.com', 'not a url']) assert.equal(privacy.safeEndpoint(url), false, url);
});

test('valid legacy export is restored with defaults without inventing quality approval', () => {
  const result = privacy.validateState({ ...state, trials: [{ taskId: 'p', date: '2026-10-14', before: 60, after: 40, confirmed: true }] });
  assert.equal(result.ok, true);
  assert.equal(result.state.wake, 960);
  assert.equal(result.state.trials[0].quality, undefined);
  assert.equal(result.state.drafts.length, 0);
});

test('legacy blank entries upgrade to stillness without mutating the input', () => {
  const legacy = { v: 1, entries: [{ ...item, id: 'quiet-old', kind: 'blank' }] };
  const result = privacy.validateState(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.state.entries[0].kind, 'stillness');
  assert.equal(legacy.entries[0].kind, 'blank');
});

test('invalid imports cannot become live state or inject unsafe attributes', () => {
  for (const data of [null, [], { v: 2, entries: [] }, { v: 1, entries: 'oops' }, { ...state, trials: {} }, { ...state, wake: 'oops' },
    { ...state, entries: [null] }, { ...state, entries: [{ ...item, id: '" onclick="alert(1)' }] },
    { ...state, entries: [{ ...item, date: '2026-02-31' }] }, { ...state, entries: [{ ...item, end: '25:00' }] },
    { ...state, entries: [{ ...item, end: '10:00junk' }] },
    { ...state, entries: [{ ...item, start: '10:00', end: '09:00' }] },
    { ...state, entries: [{ ...item, completion: { actual: 'bad' } }] },
    { ...state, entries: [item, { ...item }] }, { ...state, trials: [null] }]) assert.equal(privacy.validateState(data).ok, false, JSON.stringify(data));
});

test('privacy status distinguishes memory-only persistence and session credentials', () => {
  const status = privacy.privacyStatus({ preferences: { key: 'session-secret', consent: true }, memoryOnly: true, hasBackup: true });
  assert.equal(status.storage, 'memory-only');
  assert.equal(status.customModelConsent, true);
  assert.equal(status.sessionKeyPresent, true);
  assert.equal(status.hasBackup, true);
  assert.equal(JSON.stringify(status).includes('session-secret'), false);
  assert.equal(privacy.privacyStatus({}).storage, 'browser-local');
});

test('diagnostics export only allowlisted counts and state, never user text or configuration', () => {
  const input = {
    state: { ...state, title: 'private title', entries: [{ ...item, title: 'private title' }], drafts: [], trials: [{ text: 'private title' }] },
    preferences: { key: 'session-secret', url: 'https://private.example/token', path: 'C:/private', model: 'private-model', consent: true },
    service: { status: 'ok', version: '0.1.0-local', runtime: 'web-local', secret: 'private title' },
    lastError: { code: 'TANGO_ORIGIN_REJECTED', message: 'private title' }, hasBackup: true
  };
  const report = privacy.diagnosticExport(input);
  assert.equal(report.schema, 1);
  assert.equal(report.counts.entries, 1);
  assert.equal(report.counts.trials, 1);
  assert.equal(report.privacy.hasBackup, true);
  assert.equal(report.service.status, 'ok');
  assert.equal(report.service.version, '0.1.0-local');
  assert.equal(report.lastError, 'TANGO_ORIGIN_REJECTED');
  for (const value of ['private title', 'private-model', 'private.example', 'C:/private', 'session-secret']) assert.equal(JSON.stringify(report).includes(value), false);
  assert.equal(input.state.entries[0].title, 'private title');
  assert.equal(privacy.diagnosticExport({ service: { version: 'a secret token' }, lastError: { code: 'secret token' } }).lastError, null);
  assert.equal(privacy.diagnosticExport({ service: { version: 'a secret token' } }).service.version, null);
});

test('malformed draft containers return validation failure without throwing', () => {
  assert.equal(privacy.validateState({ ...state, drafts: {} }).ok, false);
});

test('imports reject prototype names and malformed page settings instead of crashing review', () => {
  for (const patch of [{ pal: '__proto__' }, { pal: {} }, { name: { toString: {} } }, { mode: {} }, { sound: {} }, { sortBy: {} }, { fw: { '2026-10-14': {} } }, { ideal: { restore: {} } }]) {
    assert.equal(privacy.validateState({ ...state, ...patch }).ok, false, JSON.stringify(patch));
  }
  for (const patch of [{ kind: 'constructor' }, { kind: '__proto__' }, { kind: { toString: {} } }, { id: { toString: {} } }, { prio: {} }, { done: {} }, { kept: '<script>' }, { freed: { pending: true, minutes: '<img>', start: '09:00', end: '10:00' } }]) {
    assert.equal(privacy.validateState({ ...state, entries: [{ ...item, ...patch }] }).ok, false, JSON.stringify(patch));
  }
});

test('completion and trial learning and costs are bounded structured records', () => {
  const completion = { actual: 30, quality: 'accepted', before: 60, plannedEnd: '10:00' };
  const trial = { date: item.date, before: 60, after: 30 };
  const invalid = [
    { learning: [] }, { learning: 'unexpected' }, { learning: { hintLevel: { toString: {} } } },
    { learning: { ownAttempt: 'invented' } }, { learning: { independentRetest: 'proven' } },
    { learning: { skills: {} } }, { learning: { skills: ['invented'] } },
    { costs: [] }, { costs: { preparation: '1', checking: 0, rework: 0 } },
    { costs: { preparation: -1, checking: 0, rework: 0 } },
    { costs: { preparation: 20, checking: 20, rework: 0 } },
    { costs: { execution: 30, preparation: 1, checking: 0, rework: 0 } }
  ];
  for (const patch of invalid) {
    assert.equal(privacy.validateState({ ...state, entries: [{ ...item, completion: { ...completion, ...patch } }] }).ok, false, JSON.stringify(patch));
    assert.equal(privacy.validateState({ ...state, trials: [{ ...trial, ...patch }] }).ok, false, JSON.stringify(patch));
  }
  const learning = { ownAttempt: 'yes', hintLevel: 'hints', independentRetest: 'needs-practice', skills: ['privacy'], measurement: 'self-report' };
  const costs = { execution: 20, preparation: 5, checking: 5, rework: 0 };
  const valid = privacy.validateState({ ...state, entries: [{ ...item, completion: { ...completion, learning, costs } }], trials: [{ ...trial, learning, costs }] });
  assert.equal(valid.ok, true);
  assert.equal(valid.state.entries[0].completion.learning.skills[0], 'privacy');
});

test('imported state and nested records cannot smuggle configuration or secrets into data export', () => {
  const secret = { key: 'private-secret', config: { url: 'private-url' } };
  const input = { ...state, ...secret, entries: [{ ...item, ...secret, completion: { actual: 30, baseline: secret, ...secret, costs: { execution: 30, preparation: 0, checking: 0, rework: 0, ...secret }, learning: { skills: ['privacy'], ...secret } } }], trials: [{ date: item.date, before: 60, after: 30, actual: secret, plannedEnd: secret, ...secret }], fw: {}, name: '保留名称', mode: 'real' };
  const valid = privacy.validateState(input);
  assert.equal(valid.ok, true);
  assert.equal(valid.state.name, '保留名称');
  assert.doesNotMatch(JSON.stringify(valid.state), /private-secret|private-url|"config"|"key"/);
  valid.state.entries[0].completion.learning.skills.push('verification');
  assert.deepEqual(input.entries[0].completion.learning.skills, ['privacy']);
});

test('valid zero-minute completions and legacy stillness/history survive import', () => {
  const input = { ...state, entries: [{ ...item, end: item.start, done: true, completion: { actual: 0, before: 60, plannedEnd: '10:00', quality: 'accepted', learning: null } }, { ...item, id: 'quiet', kind: 'blank', state: 'partial', kept: 20, use: 'restore', note: '散步', intent: '' }], trials: [{ id: 'old', date: item.date, title: '旧事项', before: 30, after: 15, method: '手动记录' }], ideal: { restore: 15, create: 35, connect: 25, explore: 25 }, fw: { '2026-10-14': 3 }, pal: 6 };
  const result = privacy.validateState(input);
  assert.equal(result.ok, true);
  assert.equal(result.state.entries[1].kind, 'stillness');
  assert.equal(result.state.trials[0].method, '手动记录');
  assert.equal(result.state.trials[0].quality, undefined);
});

test('model evidence and account checks round trip through an explicit schema', () => {
  const evidence = { recording: 5, modelId: 'claude-sonnet-5.5', modelVersion: '2026-10-16', inputScale: 'long', anonymousEvaluationConsent: true };
  const modelAvailability = { 'claude-sonnet-5.5': { state: 'unavailable', reason: 'quota', checkedAt: '2026-10-16T10:00:00.000Z', key: 'private-secret' }, 'unknown-provider': { key: 'private-secret' } };
  const result = privacy.validateState({ ...state, modelAvailability, entries: [{ ...item, completion: { actual: 30, ...evidence } }], trials: [{ date: item.date, before: 60, after: 30, dataMode: 'real', ...evidence }] });
  assert.equal(result.ok, true);
  assert.equal(result.state.entries[0].completion.recording, 5);
  assert.equal(result.state.trials[0].modelId, 'claude-sonnet-5.5');
  assert.equal(result.state.trials[0].dataMode, 'real');
  assert.equal(result.state.modelAvailability['claude-sonnet-5.5'].reason, 'quota');
  assert.doesNotMatch(JSON.stringify(result.state), /private-secret|unknown-provider/);
  for (const patch of [{ recording: -1 }, { recording: 1441 }, { modelId: {} }, { modelVersion: '<img>' }, { inputScale: 'huge' }, { anonymousEvaluationConsent: 'yes' }, { dataMode: {} }]) {
    assert.equal(privacy.validateState({ ...state, trials: [{ date: item.date, before: 60, after: 30, ...patch }] }).ok, false, JSON.stringify(patch));
  }
  for (const patch of [{ state: {} }, { reason: 'token' }, { checkedAt: 'private-text' }]) {
    assert.equal(privacy.validateState({ ...state, modelAvailability: { 'gpt-5.4': { state: 'available', reason: 'none', checkedAt: '2026-10-16T10:00:00.000Z', ...patch } } }).ok, false);
  }
});

test('entry and draft model preferences retain only a confirmed supported model through import and export', () => {
  for (const modelPreference of ['claude-sonnet-5.5', 'gpt-5.4', 'gemini-3.1-pro-preview']) {
    const input = { ...state, entries: [{ ...item, modelPreference }], drafts: [{ ...item, id: 'draft-model', start: '', end: '', modelPreference }] };
    const before = JSON.stringify(input);
    const result = privacy.validateState(input);
    assert.equal(result.ok, true);
    assert.equal(result.state.entries[0].modelPreference, modelPreference);
    assert.equal(result.state.drafts[0].modelPreference, modelPreference);
    const restored = privacy.validateState(JSON.parse(JSON.stringify(result.state)));
    assert.equal(restored.state.entries[0].modelPreference, modelPreference);
    assert.equal(restored.state.drafts[0].modelPreference, modelPreference);
    assert.equal(JSON.stringify(input), before);
  }
  const legacy = privacy.validateState({ ...state, drafts: [{ ...item, id: 'legacy-draft', start: '', end: '' }] });
  assert.equal(legacy.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.state.entries[0], 'modelPreference'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.state.drafts[0], 'modelPreference'), false);
});

test('unsupported model preferences reject the whole entry or draft import without replacing input', () => {
  for (const modelPreference of ['unknown', 'unapproved-model', '__proto__', '', null, undefined, 123, {}, ['gpt-5.4']]) {
    for (const field of ['entries', 'drafts']) {
      const input = { ...state, [field]: [{ ...item, modelPreference }] };
      assert.equal(privacy.validateState(input).ok, false, field + ': ' + JSON.stringify(modelPreference));
      assert.equal(input[field][0].modelPreference, modelPreference);
    }
  }
});
