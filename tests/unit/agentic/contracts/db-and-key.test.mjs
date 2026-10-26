import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function loadDbApi() {
  return import('../../../../scripts/agentic/db/index.mjs');
}

async function loadGatewayKey() {
  return import('../../../../scripts/agentic/gateway-key.mjs');
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withHome(home, fn) {
  const before = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve().then(fn).finally(() => {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  });
}

test('openAgenticDb enables WAL and foreign keys for a file database', async () => {
  const { openAgenticDb } = await loadDbApi();
  const dir = tempDir('donego-agentic-db-');
  const db = openAgenticDb(join(dir, 'agentic.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    db.exec('CREATE TABLE owned_records (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, value TEXT)');
    db.prepare('INSERT INTO owned_records (id, owner_id, value) VALUES (?, ?, ?)').run('r1', 'owner-a', 'private');
    assert.deepEqual(db.prepare('SELECT owner_id FROM owned_records WHERE id = ?').get('r1'), { owner_id: 'owner-a' });
  } finally {
    db.close();
  }
});

test('migrate sorts SQL files, records them, and is idempotent', async () => {
  const { openAgenticDb, migrate } = await loadDbApi();
  const dir = tempDir('donego-agentic-migrations-');
  const migrationDir = join(dir, 'migrations');
  mkdirSync(migrationDir);
  writeFileSync(join(migrationDir, '002-second.sql'), 'CREATE TABLE second (id INTEGER PRIMARY KEY);');
  writeFileSync(join(migrationDir, '001-first.sql'), 'CREATE TABLE first (id INTEGER PRIMARY KEY);');
  const db = openAgenticDb(':memory:');
  try {
    migrate(db, migrationDir);
    migrate(db, migrationDir);
    assert.deepEqual(
      db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(row => row.name),
      ['001-first.sql', '002-second.sql'],
    );
    assert.doesNotThrow(() => db.prepare('SELECT * FROM first').all());
    assert.doesNotThrow(() => db.prepare('SELECT * FROM second').all());
  } finally {
    db.close();
  }
});

test('migrate rolls back a failed migration and does not record it', async () => {
  const { openAgenticDb, migrate } = await loadDbApi();
  const dir = tempDir('donego-agentic-migration-rollback-');
  const migrationDir = join(dir, 'migrations');
  mkdirSync(migrationDir);
  writeFileSync(join(migrationDir, '001-good.sql'), 'CREATE TABLE good (id INTEGER PRIMARY KEY);');
  writeFileSync(join(migrationDir, '002-bad.sql'), 'CREATE TABLE partial (id INTEGER PRIMARY KEY);\nINVALID SQL;');
  const db = openAgenticDb(':memory:');
  try {
    assert.throws(() => migrate(db, migrationDir));
    assert.doesNotThrow(() => db.prepare('SELECT * FROM good').all());
    assert.throws(() => db.prepare('SELECT * FROM partial').all());
    assert.deepEqual(db.prepare('SELECT name FROM _migrations').all().map(row => row.name), ['001-good.sql']);
  } finally {
    db.close();
  }
});

test('gatewayKey reads the current donego key at call time', async () => {
  const { gatewayKey } = await loadGatewayKey();
  const home = tempDir('donego-gateway-home-');
  const configDir = join(home, '.config', 'llm-gateway');
  mkdirSync(configDir, { recursive: true });
  const endpoint = join(configDir, 'endpoint.json');
  writeFileSync(endpoint, JSON.stringify({ keys: { donego: 'test-key-one' } }));
  await withHome(home, async () => {
    assert.equal(gatewayKey(), 'test-key-one');
    writeFileSync(endpoint, JSON.stringify({ keys: { donego: 'test-key-two' } }));
    assert.equal(gatewayKey(), 'test-key-two');
  });
});

test('gatewayKey reports GATEWAY_KEY_MISSING without exposing a value', async () => {
  const { gatewayKey } = await loadGatewayKey();
  const home = tempDir('donego-gateway-missing-');
  await withHome(home, async () => {
    assert.throws(
      () => gatewayKey(),
      error => error.code === 'GATEWAY_KEY_MISSING' && !String(error.message).includes('test-key'),
    );
  });
});
