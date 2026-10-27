// M2 bridge-hub 设备令牌单测（TDD RED 先行）。
// 契约来源：.s2d/plan.md §2 M2（令牌 ≥256bit、DB 存哈希、吊销立即失效）、PRD §10.2 L736（bridge_devices 带 owner_id）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceRegistry } from '../../../../scripts/agentic/bridge-hub/devices.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/agentic/db/migrations');

function openDb() {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(migrationsDir).filter(f => /^bridge-.*\.sql$/.test(f)).sort();
  assert.ok(files.length >= 1, '至少应有一个 bridge-* 迁移文件');
  for (const f of files) db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  return db;
}

function makeRegistry(over = {}) {
  const db = openDb();
  let t = 1_000_000;
  const reg = createDeviceRegistry({ db, now: () => t, ...over });
  return { reg, db, advance: ms => { t += ms; } };
}

function assertNoPlaintextToken(db, token) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bridge_%'").all().map(r => r.name);
  for (const table of tables) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'string') assert.ok(!v.includes(token), `${table}.${k} 不得包含明文设备令牌`);
      }
    }
  }
}

test('bridge_devices 表带 owner_id 列（PRD §10.2）', () => {
  const { db } = makeRegistry();
  const cols = db.prepare('PRAGMA table_info(bridge_devices)').all().map(c => c.name);
  assert.ok(cols.includes('owner_id'), `bridge_devices 需含 owner_id，实际列：${cols.join(',')}`);
});

test('签发：令牌 ≥256bit（base64url ≥43 字符），库中只存哈希', () => {
  const { reg, db } = makeRegistry();
  const { deviceId, token } = reg.issueDeviceToken('owner_a', 'MacBook');
  assert.ok(deviceId, '返回 deviceId');
  assert.ok(typeof token === 'string' && token.length >= 43, '≥256bit 随机令牌');
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assertNoPlaintextToken(db, token);
});

test('校验：resolveToken 换回 deviceId/ownerId；未知/伪造令牌返回 null', () => {
  const { reg } = makeRegistry();
  const { token } = reg.issueDeviceToken('owner_a', 'MacBook');
  const r = reg.resolveToken(token);
  assert.equal(r.ownerId, 'owner_a');
  assert.equal(r.label, 'MacBook');
  assert.equal(reg.resolveToken('faketoken'.repeat(8)), null);
  assert.equal(reg.resolveToken(''), null);
});

test('吊销：revokeDevice 后同令牌立即失效（下一次 resolve 即 null）', () => {
  const { reg } = makeRegistry();
  const { deviceId, token } = reg.issueDeviceToken('owner_a', 'MBP');
  assert.ok(reg.resolveToken(token));
  reg.revokeDevice(deviceId);
  assert.equal(reg.resolveToken(token), null, '吊销必须立即生效');
});

test('多设备多 owner 隔离：同 owner 两设备互不串、跨 owner 不串', () => {
  const { reg } = makeRegistry();
  const a1 = reg.issueDeviceToken('owner_a', 'd1');
  const a2 = reg.issueDeviceToken('owner_a', 'd2');
  const b1 = reg.issueDeviceToken('owner_b', 'd3');
  assert.notEqual(a1.token, a2.token);
  assert.equal(reg.resolveToken(a1.token).deviceId, a1.deviceId);
  assert.equal(reg.resolveToken(a2.token).deviceId, a2.deviceId);
  assert.equal(reg.resolveToken(b1.token).ownerId, 'owner_b');
  const list = reg.listDevices('owner_a');
  assert.equal(list.length, 2);
  assert.ok(list.every(d => d.ownerId === 'owner_a'), 'listDevices 只返回本 owner 的设备');
});

test('吊销可枚举：listDevices 不再包含已吊销设备（或标记 revoked）', () => {
  const { reg } = makeRegistry();
  const { deviceId } = reg.issueDeviceToken('owner_a', 'd1');
  reg.issueDeviceToken('owner_a', 'd2');
  reg.revokeDevice(deviceId);
  const active = reg.listDevices('owner_a').filter(d => !d.revoked);
  assert.equal(active.length, 1);
});
