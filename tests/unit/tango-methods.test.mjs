import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="tango-method-core">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'tango-method-core script block exists');
const context = vm.createContext({ window: {} });
vm.runInContext(script, context);
const methods = context.window.TangoMethods;

const privacyContext = vm.createContext({ window: {}, URL });
vm.runInContext(readFileSync(new URL('../../web/privacy.js', import.meta.url), 'utf8'), privacyContext);
const privacy = privacyContext.window.TangoPrivacy;

const iso = '2026-10-19T08:00:00.000Z';
const recipe = (extra = {}) => ({
  id: 'm1', version: 1, createdAt: iso, updatedAt: iso, name: '资料初筛与原文核对',
  purpose: '筛论文并核对出处', category: 'screen', fit: '', unfit: '',
  inputs: '[公开资料]、[研究问题]、[输出结构]', steps: '第一步', verify: '抽查出处', stop: '不可分享即停',
  modelId: 'unknown', modelReason: '未验证 · 尚无个人实测依据', status: 'active',
  origin: { taskId: 't1', date: '2026-10-18', quality: 'accepted' }, ...extra
});
const methodUse = (extra = {}) => ({
  id: 'u1', methodId: 'm1', methodVersion: 1, methodName: '资料初筛与原文核对',
  taskId: 't2', date: '2026-10-19', status: 'applied', at: iso, ...extra
});
const entry = { id: 'paper', date: '2026-10-19', title: '筛选5篇论文', kind: 'necessary', start: '14:00', end: '15:00' };
const state = extra => ({ v: 1, mode: 'real', entries: [entry], methods: [recipe()], methodUses: [methodUse()], ...extra });

test('saved method templates use variable slots and never copy the private task text', () => {
  const draft = methods.buildMethodDraft({ nameHint: '按问题筛选资料，核对出处', category: 'screen', taskId: 't1', date: '2026-10-18', quality: 'accepted', stepsHint: '拆解问题' });
  assert.equal(draft.version, 1);
  assert.equal(draft.status, 'active');
  assert.ok(draft.inputs.indexOf('[') >= 0, 'template keeps variable slots');
  assert.doesNotMatch(JSON.stringify(draft), /筛选5篇论文|秘密正文/, 'task text must not leak into the template');
  assert.match(draft.modelReason, /未验证/, 'model reason stays unverified by default');
});

test('matching is local and explainable: same category suggests, archived or answered does not', () => {
  const task = { id: 't2', category: 'screen' };
  assert.equal(methods.matchMethod([recipe()], [], task).id, 'm1');
  assert.equal(methods.matchMethod([recipe({ status: 'archived' })], [], task), null, 'archived methods are not suggested');
  assert.equal(methods.matchMethod([recipe()], [methodUse()], task), null, 'already answered for this task is not re-suggested');
  assert.equal(methods.matchMethod([recipe()], [methodUse({ taskId: 'other' })], task).id, 'm1', 'other tasks do not block this task');
  assert.equal(methods.matchMethod([recipe({ category: 'code' })], [], task), null, 'different category yields no suggestion instead of a weak push');
  assert.equal(methods.matchMethod([], [], task), null, 'no methods means no suggestion');
});

test('applying a suggestion refuses stale, changed or finished tasks', () => {
  assert.equal(methods.applyAllowed(entry, '筛选5篇论文'), true);
  assert.equal(methods.applyAllowed({ ...entry, title: '已经改过的标题' }, '筛选5篇论文'), false);
  assert.equal(methods.applyAllowed({ ...entry, done: true }, '筛选5篇论文'), false);
  assert.equal(methods.applyAllowed({ ...entry, kind: 'stillness' }, '筛选5篇论文'), false);
  assert.equal(methods.applyAllowed(null, '筛选5篇论文'), false);
});

test('use statistics keep aborted and dismissed separate from completed reuse', () => {
  const stats = methods.useStats([methodUse(), methodUse({ id: 'u2', status: 'aborted' }), methodUse({ id: 'u3', status: 'completed' }), methodUse({ id: 'u4', status: 'dismissed' }), null, { status: 'bogus' }]);
  assert.equal(stats.applied, 1);
  assert.equal(stats.aborted, 1);
  assert.equal(stats.completed, 1);
  assert.equal(stats.dismissed, 1);
});

test('state validation keeps methods and use records, restores old data without them', () => {
  const kept = privacy.validateState(state());
  assert.equal(kept.ok, true);
  assert.equal(kept.state.methods.length, 1);
  assert.equal(kept.state.methods[0].name, '资料初筛与原文核对');
  assert.equal(kept.state.methodUses[0].status, 'applied');
  const legacy = privacy.validateState({ v: 1, mode: 'real', entries: [entry] });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.state.methods.length, 0);
  assert.equal(legacy.state.methodUses.length, 0);
});

test('invalid methods and use records are rejected or stripped, never silently healed', () => {
  for (const bad of [
    { ...recipe(), id: '" onclick="alert(1)' },
    { ...recipe(), status: 'verified-effective' },
    { ...recipe(), version: 0 },
    { ...recipe(), name: '' },
    { ...recipe(), category: 'secret-ranking' },
    { ...recipe(), modelId: 'gpt-9-max' },
    { ...recipe(), createdAt: 'not-a-date' },
    { ...recipe(), origin: { taskId: 't1', quality: 'accepted-forever' } }
  ]) assert.equal(privacy.validateState({ ...state(), methods: [bad] }).ok, false, JSON.stringify(bad));
  for (const bad of [
    { ...methodUse(), status: 'opened' },
    { ...methodUse(), taskId: 'no such task!' },
    { ...methodUse(), date: '2026-02-31' },
    { ...methodUse(), at: 'yesterday' }
  ]) assert.equal(privacy.validateState({ ...state(), methodUses: [bad] }).ok, false, JSON.stringify(bad));
  const cleaned = privacy.validateState({ ...state(), methods: [{ ...recipe(), secretField: 'strip-me' }], methodUses: [{ ...methodUse(), extra: 'strip' }] });
  assert.equal(cleaned.ok, true);
  assert.equal('secretField' in cleaned.state.methods[0], false);
  assert.equal('extra' in cleaned.state.methodUses[0], false);
});

test('a task can carry a method reference and cleaning keeps exactly the known fields', () => {
  const withRef = privacy.validateState({ ...state(), entries: [{ ...entry, methodRef: { methodId: 'm1', version: 1, name: '资料初筛与原文核对' } }] });
  assert.equal(withRef.ok, true);
  assert.equal(withRef.state.entries[0].methodRef.name, '资料初筛与原文核对');
  for (const badRef of [{ methodId: 'm1', version: 1 }, { methodId: 'm1', version: 1, name: '' }, { methodId: 'x y', version: 1, name: '名' }])
    assert.equal(privacy.validateState({ ...state(), entries: [{ ...entry, methodRef: badRef }] }).ok, false, JSON.stringify(badRef));
});

test('edited methods become a new version while historical use records keep their snapshot', () => {
  const edited = recipe({ version: 2, name: '资料初筛与逐条核对', updatedAt: '2026-10-19T09:00:00.000Z' });
  const snapshotUse = methodUse({ methodVersion: 1, methodName: '资料初筛与原文核对', status: 'completed' });
  const kept = privacy.validateState({ ...state(), methods: [edited], methodUses: [snapshotUse] });
  assert.equal(kept.ok, true);
  assert.equal(kept.state.methods[0].version, 2);
  assert.equal(kept.state.methodUses[0].methodVersion, 1, 'old use keeps the version it was applied with');
  assert.equal(kept.state.methodUses[0].methodName, '资料初筛与原文核对', 'old use keeps the name snapshot');
});
