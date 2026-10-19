import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(html.match(/<script id="tango-time-core">([\s\S]*?)<\/script>/)[1], context);
const time = context.window.TangoTime;
const trial = (extra = {}) => ({ taskId: 'paper', date: '2026-10-16', before: 60, after: 65, confirmed: true, quality: 'accepted', usedAI: true, costs: { preparation: 5, checking: 10, rework: 20 }, ...extra });

test('review exposes accepted preparation, execution, checking and rework while preserving negative net time', () => {
  const result = time.recordedDurations([trial(), trial(), trial({ taskId: 'pending', quality: 'pending' }), trial({ taskId: 'old', date: '2026-09-16' })], '2026-10-10', '2026-10-16');
  assert.equal(result.preparation, 5);
  assert.equal(result.execution, 30);
  assert.equal(result.checking, 10);
  assert.equal(result.rework, 20);
  assert.equal(result.difference, -5);
  assert.equal(result.samples, 1);
  assert.equal(result.pending, 1);
});

test('legacy or malformed cost breakdowns stay explicitly unknown rather than invented as zero', () => {
  const result = time.recordedDurations([
    trial({ costs: undefined }), trial({ taskId: 'bad', costs: { preparation: -1, checking: 0, rework: 0 } }),
    trial({ taskId: 'overflow', costs: { preparation: 100, checking: 0, rework: 0 } }),
  ]);
  assert.equal(result.unknownCosts, 3);
  assert.equal(result.preparation, 0);
  assert.equal(result.execution, 0);
  assert.equal(result.difference, -15);
});

test('optional learning records preserve a real attempt, hint level and self-reported skills without inventing mastery', () => {
  const item = { id: 'paper', title: '读论文', date: '2026-10-16', start: '09:00', end: '10:00', kind: 'explore' };
  const learning = { ownAttempt: 'yes', hintLevel: 'hints', independentRetest: 'needs-practice', skills: ['verification', 'privacy', 'invented-skill'] };
  const result = time.completeTask(item, '30', true, 'read', { quality: 'accepted', learning });
  assert.ok(result.trial.learning, 'the completion carries the optional learning record');
  assert.equal(result.trial.learning.ownAttempt, 'yes');
  assert.equal(result.trial.learning.hintLevel, 'hints');
  assert.equal(result.trial.learning.independentRetest, 'needs-practice');
  assert.equal(result.trial.learning.measurement, 'self-report');
  assert.deepEqual(Array.from(result.entry.completion.learning.skills), ['verification', 'privacy']);
  const skipped = time.completeTask(item, '30', true, 'read', { quality: 'accepted' });
  assert.equal(skipped.trial.learning, null);
});

function appFunction(name, nextName) {
  const start = html.indexOf('  function ' + name + '(');
  const end = html.indexOf('  function ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start, name + ' exists');
  return html.slice(start, end);
}

test('cohort export only includes local aggregates and marks unavailable business evidence unknown', () => {
  const ctx = vm.createContext({ S: { mode: 'real', name: 'private-name', uid: 'private-id', entries: [], trials: [trial({ title: 'private-title', key: 'private-key' })] }, Time: time, PRODUCT_VERSION: 'test-version' });
  vm.runInContext(appFunction('cohortReport', 'exportEvidence'), ctx);
  const report = ctx.cohortReport('2026-10-10', '2026-10-16');
  assert.equal(report.scope, 'single-browser');
  assert.equal(report.accepted.difference, -5);
  assert.equal(report.retentionD7, null);
  assert.equal(report.retentionD30, null);
  assert.equal(report.causalEffect, null);
  assert.equal(report.dataMode, 'real');
  assert.doesNotMatch(JSON.stringify(report), /private-/);
});

test('settings display release, data mode and account boundaries with explicit export actions', () => {
  const ctx = vm.createContext({ S: { mode: 'demo', name: '', wake: 960 }, L: { mode: 'off' }, PRODUCT_VERSION: 'test-version', serviceSummary: () => 'service unavailable', safeStorageGet: () => null, localStorage: { getItem: () => null }, BACKUP_KEY: 'backup', aiSettings: () => '', esc: String, memoryOnly: false, corruptedMain: false, corruptRaw: null, recoveryNotice: '', lastErrorCode: null, legacyLLMKeyFound: false });
  vm.runInContext(appFunction('pageSettings', 'fmtWhen').split('  var agreementState')[0], ctx);
  const view = ctx.pageSettings();
  assert.match(view, /test-version/);
  assert.match(view, /数据模式/);
  assert.match(view, /账户可用性/);
  assert.match(view, /cohort-export/);
  assert.match(view, /model-evaluation-export/);
});

test('AI requests wait for exact prompt and destination approval and cancellation sends nothing', async () => {
  const sent = [];
  let preview = '';
  const ctx = vm.createContext({ pendingSendPreview: null, esc: String, openSheet: (value) => { preview = value; }, closeSheet: () => {}, setTimeout: () => 1, clearTimeout: () => {}, window: {}, fetch: async (url, options) => { sent.push({ url, options }); return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }) }; } });
  vm.runInContext(appFunction('requestPreview', 'llmJSON'), ctx);
  vm.runInContext(appFunction('llmJSON', 'setCap').split('  var capState')[0], ctx);
  const cancelled = ctx.llmJSON({ url: 'https://api.example.com', model: 'test', key: 'do-not-display-secret' }, 'exact prompt');
  await Promise.resolve();
  assert.equal(sent.length, 0);
  assert.match(preview, /https:\/\/api.example.com/);
  assert.match(preview, /exact prompt/);
  assert.doesNotMatch(preview, /do-not-display-secret/);
  ctx.resolveSendPreview(false);
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(sent.length, 0);
  const approved = ctx.llmJSON({ url: 'https://api.example.com', model: 'test', key: '' }, 'approved prompt');
  ctx.resolveSendPreview(true);
  await approved;
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].options.body).messages[0].content, 'approved prompt');
});

test('recording overhead is deducted from net time and missing overhead stays unknown', () => {
  const item = { id: 'paper', date: '2026-10-16', title: '读论文', start: '09:00', end: '10:00', kind: 'explore' };
  const result = time.completeTask(item, '30', true, 'read', { quality: 'accepted', recording: '5', preparation: '5', checking: '5', rework: '5' });
  assert.equal(result.trial.after, 45);
  assert.equal(result.trial.recording, 5);
  const totals = time.recordedDurations([result.trial]);
  assert.equal(totals.netDifference, 10);
  assert.equal(totals.recording, 5);
  assert.equal(time.recordedDurations([trial()]).netDifference, null);
  assert.equal(time.recordedDurations([trial()]).unknownRecording, 1);
});

test('model evaluation exports only explicit opt-in real records with allowed model metadata and no task text or identifiers', () => {
  const opted = trial({ anonymousEvaluationConsent: true, dataMode: 'real', modelId: 'gpt-5.4', modelVersion: '2026-10-16', inputScale: 'short', title: 'private-text', taskId: 'private-task', key: 'private-key' });
  const ctx = vm.createContext({ S: { mode: 'real', trials: [opted, { ...opted, taskId: 'private-two', anonymousEvaluationConsent: false }, { ...opted, taskId: 'private-demo', dataMode: 'demo' }, { ...opted, taskId: 'private-legacy', dataMode: undefined }] }, MODEL_IDS: ['claude-sonnet-5.5', 'gpt-5.4', 'gemini-3.1-pro-preview'], Time: time });
  vm.runInContext(appFunction('modelEvaluationRows', 'cohortReport'), ctx);
  const rows = ctx.modelEvaluationRows('2026-10-10', '2026-10-16');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelId, 'gpt-5.4');
  assert.equal(rows[0].modelVersion, '2026-10-16');
  assert.doesNotMatch(JSON.stringify(rows), /private-|taskId|title|key/);
  ctx.S.mode = 'demo';
  assert.equal(ctx.modelEvaluationRows('2026-10-10', '2026-10-16').length, 0);
});

test('storage-disabled settings remain usable and corrupt original state is never silently overwritten', () => {
  const writes = [];
  const ctx = vm.createContext({ STORE_KEY: 'state', BACKUP_KEY: 'backup', corruptedMain: false, storageConflict: false, memoryOnly: false, recoveryNotice: '', S: { entries: [] }, localStorage: { getItem: () => { throw new Error('disabled'); }, setItem: (...args) => writes.push(args) } });
  vm.runInContext(appFunction('safeStorageGet', 'showRecoveryNotice'), ctx);
  assert.equal(ctx.safeStorageGet('backup'), null);
  assert.equal(ctx.memoryOnly, true);
  vm.runInContext(appFunction('canWriteStorage', 'demoState').split('  // ---------- demo ----------')[0], ctx);
  ctx.corruptedMain = true;
  assert.equal(ctx.save(), false);
  assert.equal(writes.length, 0);
});

test('another tab changing the stored baseline blocks a stale save before it can overwrite new data', () => {
  const writes = [];
  const ctx = vm.createContext({ STORE_KEY: 'state', corruptedMain: false, storageConflict: false, lastStoredRaw: 'old', recoveryNotice: '', showRecoveryNotice: () => {}, S: { entries: [] }, localStorage: { getItem: () => 'another-tab', setItem: (...args) => writes.push(args) } });
  vm.runInContext(appFunction('canWriteStorage', 'demoState').split('  // ---------- demo ----------')[0], ctx);
  assert.equal(ctx.save(), false);
  assert.equal(ctx.storageConflict, true);
  assert.equal(writes.length, 0);
  assert.match(ctx.recoveryNotice, /另一个标签页/);
});

test('replacement snapshots the old state before saving and keeps memory unchanged when backup fails', () => {
  const writes = [], old = { entries: [{ id: 'old' }] }, next = { entries: [] };
  const ctx = vm.createContext({ STORE_KEY: 'state', BACKUP_KEY: 'backup', corruptedMain: false, storageConflict: false, lastStoredRaw: 'old', recoveryNotice: '', toast: () => {}, S: old, localStorage: { getItem: () => 'old', setItem: (...args) => writes.push(args) } });
  vm.runInContext(appFunction('canWriteStorage', 'demoState').split('  // ---------- demo ----------')[0], ctx);
  assert.equal(ctx.replaceWithSnapshot(next), true);
  assert.equal(writes[0][0], 'backup');
  assert.equal(writes[0][1], JSON.stringify(old));
  assert.equal(writes[1][0], 'state');
  ctx.S = old; ctx.lastStoredRaw = 'old';
  ctx.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(ctx.replaceWithSnapshot(next), false);
  assert.equal(ctx.S, old);
});

test('personal time distinguishes task-linked reservations, ordinary reservations and unconfirmed use in the selected period', () => {
  assert.equal(typeof time.personalUseSummary, 'function');
  const personal = (id, extra = {}) => ({ id, date: '2026-10-16', kind: 'stillness', start: '19:00', end: '20:00', state: 'reserved', ...extra });
  const linked = personal('linked', { from: 'paper', state: 'partial', kept: 30, use: 'connect' });
  const result = time.personalUseSummary([linked, linked, personal('ordinary', { state: 'kept', kept: 60, use: 'restore' }), personal('pending'), personal('past', { date: '2026-09-16' })], '2026-10-10', '2026-10-16');
  assert.equal(result.reserved, 180);
  assert.equal(result.confirmedUsed, 90);
  assert.equal(result.unconfirmed, 1);
  assert.equal(result.taskLinked.reserved, 60);
  assert.equal(result.taskLinked.confirmedUsed, 30);
  assert.equal(result.ordinary.reserved, 120);
  assert.equal(result.purposes.connect, 30);
  assert.equal(result.purposes.restore, 60);
});

test('AI drafts reject impossible dates and prototype names cannot become kinds', () => {
  const ctx = vm.createContext({ KINDS: { necessary: {} }, todayStr: () => '2026-10-16', guessKind: () => 'necessary', isHM: (value) => /^(?:09|10):00$/.test(value), uid: () => 'draft', PRIO_STRIP: /$^/, prioOf: () => 3 });
  vm.runInContext(appFunction('normalizeAI', 'withTimeout').split('  var sampleP')[0], ctx);
  const item = { title: 'read', kind: 'constructor', date: '2026-10-16', start: '09:00', end: '10:00' };
  assert.equal(ctx.normalizeAI([item])[0].kind, 'necessary');
  assert.equal(ctx.normalizeAI([{ ...item, kind: '__proto__' }])[0].kind, 'necessary');
  for (const date of ['2026-99-99', '2026-02-31', 'bad']) assert.equal(ctx.normalizeAI([{ ...item, date }]).length, 0);
});

test('English review labels describe planned references and accepted differences without an AI counterfactual', () => {
  const ctx = vm.createContext({ guidanceCopy: {} });
  const start = html.indexOf('  var gapCopy = {'), end = html.indexOf('  // English fallback', start);
  vm.runInContext(html.slice(start, end), ctx);
  ctx.LANG = 'en'; ctx.I18N = { en: ctx.guidanceCopy }; ctx.NUM_RE = /\d+(?:[.:]\d+)?/g; ctx.CJK_RE = /[一-鿿]/; ctx.trCache = {}; ctx.fragRe = {};
  vm.runInContext(appFunction('fragmentsOf', 'trNode').split('  var TR_ATTRS')[0], ctx);
  assert.equal(ctx.tr('个人历史参考'), 'Personal history reference');
  assert.equal(ctx.tr('待实测'), 'Not measured');
  assert.equal(ctx.tr('已验收差值'), 'Accepted time difference');
  assert.equal(ctx.tr('计划基线'), 'Planned baseline');
  assert.equal(ctx.tr('参考用时'), 'Reference duration');
});
