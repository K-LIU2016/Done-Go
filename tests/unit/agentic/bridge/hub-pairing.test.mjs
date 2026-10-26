// M2 bridge-hub 配对码单测（TDD RED 先行）。
// 契约来源：.s2d/plan.md §2 M2、BUILD-PLAN §3 W8-7（配对码一次性、10 分钟）、PRD §10.2 bridge_devices/owner。
// W0 迁移运行器未交付前：内存库（node:sqlite :memory:）自跑 scripts/agentic/db/migrations/bridge-*.sql（§2.1 L48）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPairingService } from '../../../../scripts/agentic/bridge-hub/pairing.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/agentic/db/migrations');

function openDb() {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(migrationsDir).filter(f => /^bridge-.*\.sql$/.test(f)).sort();
  assert.ok(files.length >= 1, '至少应有一个 bridge-* 迁移文件');
  for (const f of files) db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  return db;
}

function makeService(over = {}) {
  let t = 1_000_000;
  const now = () => t;
  const db = openDb();
  const svc = createPairingService({ db, now, ...over });
  return { svc, db, advance: ms => { t += ms; }, now };
}

// 安全巡检：任何 bridge_* 表的任何文本列都不得出现明文码（防泄露面）
function rawCodeLeaked(db, needle) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bridge_%'").all().map(r => r.name);
  for (const table of tables) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const cols = info.map(c => c.name);
    const idcol = cols[0];
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
      for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && v.includes(needle)) return `${table}.${k}`;
    }
    void idcol;
  }
  return null;
}

test('签发：返回码与到期时间，10 分钟 TTL', () => {
  const { svc, now } = makeService();
  const { code, expiresAt } = svc.issuePairingCode('owner_a');
  assert.match(code, /^[A-Za-z0-9]{6,}$/); // 人类可输入的一次性码
  assert.equal(expiresAt, now() + 10 * 60_000); // BUILD-PLAN W8-7：10 分钟
});

test('消费：正确码首次消费成功并返回 owner；同一码二次消费被拒（一次性）', () => {
  const { svc } = makeService();
  const { code } = svc.issuePairingCode('owner_a');
  assert.deepEqual(svc.consumePairingCode(code), { ok: true, ownerId: 'owner_a' });
  const again = svc.consumePairingCode(code);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'PAIRING_CODE_USED');
});

test('过期：签发 10 分钟后消费返回 EXPIRED；9 分 59 秒仍有效', () => {
  const { svc, advance } = makeService();
  const { code } = svc.issuePairingCode('owner_a');
  advance(10 * 60_000 - 1_000);
  assert.equal(svc.consumePairingCode(code).ok, true);
  const { code: c2 } = svc.issuePairingCode('owner_b');
  advance(10 * 60_000 + 1_000);
  const r = svc.consumePairingCode(c2);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PAIRING_CODE_EXPIRED');
});

test('未知码：PAIRING_CODE_UNKNOWN，不泄露是否存在', () => {
  const { svc } = makeService();
  const r = svc.consumePairingCode('000000');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PAIRING_CODE_UNKNOWN');
});

test('用后即焚：消费成功后 DB 里查不到该码（存哈希不存明文）', () => {
  const { svc, db } = makeService();
  const { code } = svc.issuePairingCode('owner_a');
  svc.consumePairingCode(code);
  assert.equal(rawCodeLeaked(db, code), null, '数据库不得存明文配对码');
  // 未消费的也不存明文
  const { code: c2 } = svc.issuePairingCode('owner_a');
  assert.equal(rawCodeLeaked(db, c2), null);
});

test('配对码绑定 owner：A 签的码只能兑换出 A', () => {
  const { svc } = makeService();
  const { code } = svc.issuePairingCode('owner_a');
  const r = svc.consumePairingCode(code);
  assert.equal(r.ownerId, 'owner_a');
});
