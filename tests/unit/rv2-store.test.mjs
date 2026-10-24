import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// RV2 L9存储迁移 line: web/relay/store.js — SPEC §5.4 本地记录 tango-donego.relay.v2
// + D9 账号作用域 (web/app-auth.js scope()) + D5 访客裸键 + v1 迁移 + 隔离区
// + 200 条上限. All shapes/caps/enums come from web/relay/contracts.js — never
// redefined here. Storage objects are injected fakes; the one thing that must
// be verified against the REAL shipped source is the D9 scope regex in
// web/app-auth.js (test 'D9: app-auth.js scope() ...' reads the file itself).

import {
  RELAY_STORE_KEY, LEGACY_V1_STORE_KEY, MAX_RECORDS,
  quarantineKey, sanitizeStoreText,
} from '../../web/relay/contracts.js';
import { createRelayStore, promoteGuestStore, pickStorage } from '../../web/relay/store.js';

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [String(k), String(v)]));
  const api = {
    map,
    getItem(name) { return map.has(String(name)) ? map.get(String(name)) : null; },
    setItem(name, value) {
      if (api.failSetOn && String(name).includes(api.failSetOn)) throw new Error('simulated quota');
      map.set(String(name), String(value));
    },
    removeItem(name) { map.delete(String(name)); },
    failSetOn: null,
  };
  return api;
}

// Mirrors web/app-auth.js scope() AFTER the L9 D9 minimal hook: keys under
// tango-donego.relay.v2* (incl. the .quarantine suffix) are namespaced to the
// account; the legacy ai-relay.v1 key stays pass-through so migration reads it
// exactly where v1 wrote it. Kept in sync with the real file by the D9 test.
const SCOPED_KEY_RE = /^tango-donego\.(web\.v1|relay\.v2|assistant(?:-privacy)?\.v1|llm\.v1|agreements\.v1)(?:\.|$)/;
function accountStorage(userId, base) {
  const scoped = (name) => (SCOPED_KEY_RE.test(name) ? `tango-donego.user.${userId}.${name}` : name);
  return {
    base,
    getItem(name) { return base.getItem(scoped(name)); },
    setItem(name, value) { base.setItem(scoped(name), value); },
    removeItem(name) { base.removeItem(scoped(name)); },
  };
}

const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const AT = (n) => new Date(1760000000000 + n * 1000).toISOString();

function seedRecord(n, over = {}) {
  return {
    id: uuid(n), at: AT(n), event: '事件 ' + n, usageId: 'meeting-notes',
    result: '结果 ' + n, rating: null, graduated: false, graduatedApp: null, failed: null,
    ...over,
  };
}
const seedStore = (records) => JSON.stringify({ v: 2, records });
const fields = (over = {}) => ({ event: '整理组会纪要', usageId: 'meeting-notes', result: '一版结果', ...over });

// ---------------------------------------------------------------------------
// D9 — shipped scope regex + storage picking.
// ---------------------------------------------------------------------------
test('D9: app-auth.js scope() namespaces relay.v2 and its quarantine key, not legacy v1', () => {
  const source = readFileSync(new URL('../../web/app-auth.js', import.meta.url), 'utf8');
  const found = source.match(/function key\(name\)\{return (\/.+?\/)\.test\(name\)/);
  assert.ok(found, 'scope().key regex literal found in web/app-auth.js');
  const re = new RegExp(found[1].slice(1, -1));
  assert.ok(re.test('tango-donego.relay.v2'), 'relay.v2 main key is account-scoped');
  assert.ok(re.test('tango-donego.relay.v2.quarantine'), '.quarantine copy stays in the same account scope');
  assert.equal(re.test('tango-donego.ai-relay.v1'), false, 'legacy v1 stays pass-through (migration reads it where v1 wrote it)');
});

test('pickStorage: explicit storage wins, then TangoAccountStorage, then guest localStorage (D5)', () => {
  const explicit = memoryStorage();
  const guestRoot = { localStorage: memoryStorage() };
  assert.equal(pickStorage({ storage: explicit, root: guestRoot }), explicit);
  assert.equal(pickStorage({ root: guestRoot }), guestRoot.localStorage);
  const loginRoot = { TangoAccountStorage: memoryStorage(), localStorage: memoryStorage() };
  assert.equal(pickStorage({ root: loginRoot }), loginRoot.TangoAccountStorage);
  assert.equal(pickStorage({ root: {} }), null, 'no storage at all resolves to null (blocked store)');
});

test('D9: logged-in store reads/writes land under tango-donego.user.<id>.relay.v2', () => {
  const base = memoryStorage();
  const store = createRelayStore({ storage: accountStorage('u7', base) });
  const added = store.add(fields());
  assert.ok(added, 'add succeeds through the scoped storage');
  const scopedKey = 'tango-donego.user.u7.' + RELAY_STORE_KEY;
  assert.ok(base.map.has(scopedKey), 'payload persisted under the account-scoped key');
  assert.equal(base.map.has(RELAY_STORE_KEY), false, 'bare guest key untouched for a logged-in user');
  const reopened = createRelayStore({ storage: accountStorage('u7', base) });
  assert.equal(reopened.status, 'ok');
  assert.equal(reopened.all().length, 1);
  assert.equal(reopened.all()[0].id, added.id);
});

test('D5: guest store persists under the bare key via root.localStorage', () => {
  const root = { localStorage: memoryStorage() };
  const store = createRelayStore({ root });
  assert.equal(store.status, 'empty');
  const added = store.add(fields());
  assert.ok(added);
  assert.ok(root.localStorage.map.has(RELAY_STORE_KEY), 'guest record lands on the bare device key');
  assert.equal(root.localStorage.map.has('tango-donego.user.u1.' + RELAY_STORE_KEY), false);
});

// ---------------------------------------------------------------------------
// v2 read/write.
// ---------------------------------------------------------------------------
test('loads an existing v2 store; invalid records stay out of the main list', () => {
  const storage = memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1), { id: 'junk' }, 'junk', seedRecord(2)]) });
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'ok');
  assert.deepEqual(store.all().map((r) => r.id), [uuid(1), uuid(2)]);
  assert.equal(storage.getItem(RELAY_STORE_KEY), seedStore([seedRecord(1), { id: 'junk' }, 'junk', seedRecord(2)]), 'read stays side-effect free');
});

test('add: newest first, persisted contract-valid, deterministic now/uuid honored', () => {
  const storage = memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1)]) });
  const store = createRelayStore({ storage });
  const added = store.add(fields({ result: '用户编辑后的纯文本' }), { now: 1760099999000, uuid: uuid(9) });
  assert.ok(added);
  assert.equal(added.id, uuid(9));
  assert.equal(added.at, new Date(1760099999000).toISOString());
  assert.deepEqual(store.all().map((r) => r.id), [uuid(9), uuid(1)]);
  const persisted = sanitizeStoreText(storage.getItem(RELAY_STORE_KEY));
  assert.equal(persisted.status, 'ok');
  assert.deepEqual(persisted.store.records.map((r) => r.id), [uuid(9), uuid(1)]);
  assert.equal(persisted.store.records[0].result, '用户编辑后的纯文本');
});

test('add: rejects invalid fields without touching memory or disk', () => {
  const storage = memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1)]) });
  const before = storage.getItem(RELAY_STORE_KEY);
  const store = createRelayStore({ storage });
  assert.equal(store.add(fields({ event: '' })), null);
  assert.equal(store.add(fields({ event: '   ' })), null);
  assert.equal(store.add(fields({ usageId: 'Bad Id!' })), null);
  assert.equal(store.add(fields({ usageId: null })), null);
  assert.equal(store.add(fields({ rating: 'bananas' })), null);
  assert.equal(store.add(fields({ failed: 'exploded' })), null);
  assert.equal(store.add(fields({ graduatedApp: 'Not An App!' })), null);
  assert.equal(store.all().length, 1);
  assert.equal(storage.getItem(RELAY_STORE_KEY), before);
});

test('add accepts a failed relay record (SPEC §5.4 failed field)', () => {
  const storage = memoryStorage();
  const store = createRelayStore({ storage });
  const failed = store.add(fields({ result: '', failed: 'timeout' }), { uuid: uuid(3) });
  assert.ok(failed);
  assert.equal(failed.failed, 'timeout');
  assert.equal(sanitizeStoreText(storage.getItem(RELAY_STORE_KEY)).store.records[0].failed, 'timeout');
});

test('200 条上限: add caps the store at MAX_RECORDS, evicting the oldest tail', () => {
  const seeds = [];
  for (let i = 0; i < MAX_RECORDS; i += 1) seeds.push(seedRecord(i));
  const storage = memoryStorage({ [RELAY_STORE_KEY]: seedStore(seeds) });
  const store = createRelayStore({ storage });
  assert.equal(store.all().length, MAX_RECORDS);
  const added = store.add(fields(), { now: 1760099999000, uuid: uuid(999) });
  assert.ok(added);
  assert.equal(store.all().length, MAX_RECORDS);
  assert.equal(store.all()[0].id, uuid(999));
  assert.equal(store.all().some((r) => r.id === uuid(MAX_RECORDS - 1)), false, 'oldest seeded record evicted');
  const persisted = sanitizeStoreText(storage.getItem(RELAY_STORE_KEY));
  assert.equal(persisted.store.records.length, MAX_RECORDS);
});

// ---------------------------------------------------------------------------
// ai-relay.v1 migration (SPEC §5.4: 一次迁移; estimatedSavedMinutes 丢弃,
// rating 设为 null; v1 key only ever read).
// ---------------------------------------------------------------------------
const V1_PAYLOAD = JSON.stringify({
  v: 1,
  records: [
    { id: '1729800000000', event: '整理周会', type: '会议整理', result: '旧结果一', learned: '旧learned一', estimatedSavedMinutes: 15, savedAt: '2026-10-20' },
    { id: '1729900000000', event: '写回复', type: '消息起草', result: '旧结果二', learned: '旧learned二', estimatedSavedMinutes: 10, savedAt: '2026-10-21' },
  ],
});

test('v1 migration: imports once, drops minutes, rating null, v1 key untouched', () => {
  const storage = memoryStorage({ [LEGACY_V1_STORE_KEY]: V1_PAYLOAD });
  const store = createRelayStore({ storage, now: 1760000099999, uuids: [uuid(1), uuid(2)] });
  assert.equal(store.status, 'migrated');
  assert.equal(store.migratedCount, 2);
  assert.deepEqual(store.all().map((r) => r.event), ['整理周会', '写回复'], 'v1 payload order preserved');
  assert.equal(store.all()[0].id, uuid(1));
  assert.equal(store.all()[0].usageId, null, 'v1 type has no v2 scene id');
  assert.equal(store.all()[0].rating, null, 'SPEC §5.4: rating 设为 null');
  assert.equal(store.all()[0].at, '2026-10-20T00:00:00.000Z', 'date-only savedAt parsed as UTC midnight');
  assert.ok(!('estimatedSavedMinutes' in store.all()[0]) && !('type' in store.all()[0]) && !('learned' in store.all()[0]));
  const persisted = sanitizeStoreText(storage.getItem(RELAY_STORE_KEY));
  assert.equal(persisted.status, 'ok');
  assert.equal(persisted.store.records.length, 2);
  assert.equal(storage.getItem(LEGACY_V1_STORE_KEY), V1_PAYLOAD, 'v1 payload byte-identical after migration');
  const reopened = createRelayStore({ storage });
  assert.equal(reopened.status, 'ok');
  assert.equal(reopened.migratedCount, 0, 'second boot does not re-migrate');
});

test('v1 migration only runs when the v2 key is absent', () => {
  const storage = memoryStorage({
    [RELAY_STORE_KEY]: seedStore([seedRecord(5)]),
    [LEGACY_V1_STORE_KEY]: V1_PAYLOAD,
  });
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'ok');
  assert.equal(store.migratedCount, 0);
  assert.deepEqual(store.all().map((r) => r.id), [uuid(5)]);
  assert.equal(storage.getItem(LEGACY_V1_STORE_KEY), V1_PAYLOAD);
});

test('fresh visitor: nothing stored, no boot write, no v1 anywhere', () => {
  const storage = memoryStorage();
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'empty');
  assert.deepEqual(store.all(), []);
  assert.equal(storage.map.has(RELAY_STORE_KEY), false, 'lazy: fresh store is only written on first mutation');
});

// ---------------------------------------------------------------------------
// 隔离区 (SPEC §5.4: 未知版本时不覆盖，放进隔离区并提示用户).
// ---------------------------------------------------------------------------
test('unknown version: raw payload moved to .quarantine, fresh store replaces it, user can be prompted', () => {
  const raw = JSON.stringify({ v: 3, records: [{ id: uuid(1), at: AT(1), event: 'x', usageId: 'a', result: '', rating: null, graduated: false, graduatedApp: null, failed: null }] });
  const storage = memoryStorage({ [RELAY_STORE_KEY]: raw });
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'quarantined');
  assert.equal(store.quarantined, true);
  assert.equal(store.blocked, false);
  assert.deepEqual(store.all(), []);
  assert.equal(storage.getItem(quarantineKey(RELAY_STORE_KEY)), raw, 'exact raw payload preserved in the quarantine key');
  const replaced = sanitizeStoreText(storage.getItem(RELAY_STORE_KEY));
  assert.equal(replaced.status, 'ok');
  assert.equal(replaced.store.records.length, 0, 'main key replaced by a fresh empty v2 store');
  assert.ok(store.add(fields(), { uuid: uuid(2) }), 'store usable again after quarantine');
  assert.equal(store.readQuarantined(), raw);
  const reopened = createRelayStore({ storage });
  assert.equal(reopened.status, 'ok');
  assert.equal(reopened.all().length, 1);
  assert.equal(reopened.readQuarantined(), raw, 'quarantine copy survives later boots');
});

test('broken JSON quarantine: same path as unknown version', () => {
  const storage = memoryStorage({ [RELAY_STORE_KEY]: '{oops' });
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'quarantined');
  assert.equal(storage.getItem(quarantineKey(RELAY_STORE_KEY)), '{oops');
  assert.equal(sanitizeStoreText(storage.getItem(RELAY_STORE_KEY)).status, 'ok');
});

test('quarantine write failure: 不覆盖 — main key untouched, persistence blocked', () => {
  const raw = JSON.stringify({ v: 99, records: [] });
  const storage = memoryStorage({ [RELAY_STORE_KEY]: raw });
  storage.failSetOn = '.quarantine';
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'blocked');
  assert.equal(store.blocked, true);
  assert.equal(store.quarantineFailed, true);
  assert.deepEqual(store.all(), []);
  assert.equal(storage.getItem(RELAY_STORE_KEY), raw, 'unknown payload NOT overwritten when the quarantine copy failed');
  assert.equal(store.add(fields()), null);
  assert.equal(store.clear(), false);
});

// ---------------------------------------------------------------------------
// Write failures roll back (v1 precedent: detect setItem failure, keep memory
// consistent with disk).
// ---------------------------------------------------------------------------
test('persist failure rolls back add/setRating/graduate/replaceResult', () => {
  const storage = memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1)]) });
  const store = createRelayStore({ storage });
  const before = storage.getItem(RELAY_STORE_KEY);
  storage.failSetOn = RELAY_STORE_KEY;
  assert.equal(store.add(fields(), { uuid: uuid(9) }), null);
  assert.deepEqual(store.all().map((r) => r.id), [uuid(1)], 'no phantom record after failed write');
  assert.equal(store.setRating(uuid(1), 'much'), false);
  assert.equal(store.graduate(uuid(1), 'doubao'), false);
  assert.equal(store.replaceResult(uuid(1), '改'), false);
  assert.equal(store.all()[0].rating, null);
  assert.equal(storage.getItem(RELAY_STORE_KEY), before);
});

// ---------------------------------------------------------------------------
// Mutators.
// ---------------------------------------------------------------------------
test('setRating/graduate/replaceResult persist and validate', () => {
  const storage = memoryStorage();
  const store = createRelayStore({ storage });
  const added = store.add(fields(), { uuid: uuid(1) });
  assert.equal(store.setRating(added.id, 'much'), true);
  assert.equal(store.setRating(added.id, 'nope'), false);
  assert.equal(store.setRating(added.id, null), false);
  assert.equal(store.setRating(uuid(404), 'much'), false);
  assert.equal(store.graduate(added.id, 'doubao'), true);
  assert.equal(store.graduate(added.id, 'Not An App!'), false);
  assert.equal(store.replaceResult(added.id, '编辑后的结果'), true);
  assert.equal(store.replaceResult(uuid(404), 'x'), false);
  const reopened = createRelayStore({ storage });
  const record = reopened.all()[0];
  assert.equal(record.rating, 'much');
  assert.equal(record.graduated, true);
  assert.equal(record.graduatedApp, 'doubao');
  assert.equal(record.result, '编辑后的结果');
});

// ---------------------------------------------------------------------------
// clear() (SPEC §4⑦ 删除本机记录) + export (SPEC §4⑤ 导出我的记录).
// ---------------------------------------------------------------------------
test('clear(): writes an empty v2 store (key kept), removes the quarantine copy, migration stays one-shot', () => {
  const storage = memoryStorage({ [LEGACY_V1_STORE_KEY]: V1_PAYLOAD, [quarantineKey(RELAY_STORE_KEY)]: 'old quarantine' });
  const store = createRelayStore({ storage });
  assert.equal(store.status, 'migrated');
  assert.equal(store.clear(), true);
  const text = storage.getItem(RELAY_STORE_KEY);
  assert.notEqual(text, null, 'clear keeps the key present so v1 never re-migrates');
  assert.deepEqual(sanitizeStoreText(text).store.records, []);
  assert.equal(storage.getItem(quarantineKey(RELAY_STORE_KEY)), null, 'quarantine copy also deleted with 本机记录');
  const reopened = createRelayStore({ storage });
  assert.equal(reopened.status, 'ok');
  assert.deepEqual(reopened.all(), [], 'no resurrection of migrated v1 records');
});

test('exportText(): valid store JSON round-trip', () => {
  const storage = memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1), seedRecord(2)]) });
  const store = createRelayStore({ storage });
  const exported = JSON.parse(store.exportText());
  assert.equal(exported.v, 2);
  assert.deepEqual(exported.records, store.all());
  assert.equal(sanitizeStoreText(store.exportText()).status, 'ok');
});

// ---------------------------------------------------------------------------
// Guest → account promotion (mechanism for the §4④ guest banner promise
// "已存到这台设备。登录后换手机也能看到"; wiring the login trigger belongs to
// the integration line, see store.js header).
// ---------------------------------------------------------------------------
test('promoteGuestStore merges guest records into the account scope, idempotently', () => {
  const guestRoot = { localStorage: memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1), seedRecord(2)]) }) };
  const base = memoryStorage();
  const result = promoteGuestStore({ root: guestRoot, accountStorage: accountStorage('u7', base) });
  assert.deepEqual(result, { added: 2, duplicates: 0 });
  assert.deepEqual(JSON.parse(base.map.get('tango-donego.user.u7.' + RELAY_STORE_KEY)).records.map((r) => r.id), [uuid(2), uuid(1)], 'merged newest-first');
  assert.ok(guestRoot.localStorage.map.has(RELAY_STORE_KEY), 'guest copy left intact (non-destructive)');
  const again = promoteGuestStore({ root: guestRoot, accountStorage: accountStorage('u7', base) });
  assert.deepEqual(again, { added: 0, duplicates: 2 }, 're-promotion collapses to duplicates');
});

test('promoteGuestStore dedupes against existing account records and caps at 200', () => {
  const accountSeeds = [];
  for (let i = 0; i < 199; i += 1) accountSeeds.push(seedRecord(i));
  const base = memoryStorage({ ['tango-donego.user.u7.' + RELAY_STORE_KEY]: seedStore(accountSeeds) });
  const guestRoot = { localStorage: memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(5), seedRecord(300), seedRecord(301), seedRecord(302), seedRecord(303)]) }) };
  const result = promoteGuestStore({ root: guestRoot, accountStorage: accountStorage('u7', base) });
  assert.deepEqual(result, { added: 4, duplicates: 1 });
  const merged = JSON.parse(base.map.get('tango-donego.user.u7.' + RELAY_STORE_KEY)).records;
  assert.equal(merged.length, MAX_RECORDS);
  assert.ok([300, 301, 302, 303].every((n) => merged.some((r) => r.id === uuid(n))), 'newer guest records kept');
  assert.ok([0, 1, 2].every((n) => !merged.some((r) => r.id === uuid(n))), 'oldest account records evicted by the cap (199+4-200=3)');
  assert.ok(merged.some((r) => r.id === uuid(3)), 'uuid(3) survives — only three records evicted');
});

test('promoteGuestStore: unknown guest payload skipped untouched, write failure → null', () => {
  const guestRoot = { localStorage: memoryStorage({ [RELAY_STORE_KEY]: '{oops' }) };
  const base = memoryStorage();
  const skipped = promoteGuestStore({ root: guestRoot, accountStorage: accountStorage('u7', base) });
  assert.deepEqual(skipped, { added: 0, duplicates: 0, skipped: 'unknown' });
  assert.equal(guestRoot.localStorage.getItem(RELAY_STORE_KEY), '{oops');
  const baseFail = memoryStorage();
  baseFail.failSetOn = 'user.u7';
  const failed = promoteGuestStore({ root: { localStorage: memoryStorage({ [RELAY_STORE_KEY]: seedStore([seedRecord(1)]) }) }, accountStorage: accountStorage('u7', baseFail) });
  assert.equal(failed, null);
  assert.equal(baseFail.map.has('tango-donego.user.u7.' + RELAY_STORE_KEY), false);
});

// ---------------------------------------------------------------------------
// Dead storage: app still runs in memory, nothing persists (D5 robustness).
// ---------------------------------------------------------------------------
test('no usable storage: blocked in-memory store', () => {
  const store = createRelayStore({ root: {} });
  assert.equal(store.status, 'blocked');
  assert.equal(store.blocked, true);
  assert.deepEqual(store.all(), []);
  assert.equal(store.add(fields()), null);
  assert.equal(store.clear(), false);
  assert.equal(store.readQuarantined(), null);
  assert.equal(sanitizeStoreText(store.exportText()).status, 'ok', 'export still emits a valid empty store');
});
