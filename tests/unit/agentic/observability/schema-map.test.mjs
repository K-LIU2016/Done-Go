import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule, CONTRACTS_DIR } from './_harness.mjs';

const schemaDir = fileURLToPath(CONTRACTS_DIR);
const schemaMap = () => loadModule('schema-map.mjs');

test('schema-map: FROZEN contract pins the single v1 baseline commit', async () => {
  const { FROZEN_COMMIT, FROZEN_VERSION } = await schemaMap();
  assert.equal(FROZEN_VERSION, 'v1');
  assert.equal(FROZEN_COMMIT, 'b9d9bdfa0511905a95b729753b82e5734adab6bb');
});

test('schema-map: readFrozenContract parses the real FROZEN file', async () => {
  const { readFrozenContract, FROZEN_FILE } = await schemaMap();
  const frozen = readFrozenContract(FROZEN_FILE);
  assert.deepEqual(frozen, {
    version: 'v1',
    commit: 'b9d9bdfa0511905a95b729753b82e5734adab6bb',
    raw: 'v1 b9d9bdfa0511905a95b729753b82e5734adab6bb',
  });
});

test('schema-map: readFrozenContract rejects a malformed FROZEN file', async () => {
  const { parseFrozenContract } = await schemaMap();
  assert.throws(() => parseFrozenContract('v1'), (error) => error.code === 'CONTRACT_INVALID');
  assert.throws(() => parseFrozenContract(''), (error) => error.code === 'CONTRACT_INVALID');
  assert.throws(() => parseFrozenContract('v1 not-a-sha'), (error) => error.code === 'CONTRACT_INVALID');
});

test('schema-map: SCHEMA_MAP covers every W0 object observability consumes', async () => {
  const { SCHEMA_MAP, REQUIRED_CONTRACTS } = await schemaMap();
  const covered = new Set(SCHEMA_MAP.map((entry) => entry.contract));
  for (const name of ['span', 'run', 'step', 'spend', 'evidence', 'acceptance', 'need', 'grant']) {
    assert.ok(covered.has(name), `SCHEMA_MAP is missing ${name}`);
    assert.ok(REQUIRED_CONTRACTS.includes(name), `REQUIRED_CONTRACTS is missing ${name}`);
  }
});

test('schema-map: every mapped schema file exists and parses as JSON', async () => {
  const { SCHEMA_MAP } = await schemaMap();
  for (const entry of SCHEMA_MAP) {
    const schema = JSON.parse(readFileSync(`${schemaDir}${entry.schemaFile}`, 'utf8'));
    assert.equal(typeof schema, 'object');
    assert.equal(typeof entry.schemaFile, 'string');
    assert.ok(entry.schemaFile.endsWith('.schema.json'));
  }
});

test('schema-map: unmodified W0 fields are never claimed as extension points', async () => {
  const { SCHEMA_MAP } = await schemaMap();
  for (const entry of SCHEMA_MAP) {
    assert.equal(entry.modifiesContract, false, `${entry.contract} must not claim to modify W0`);
    assert.ok(entry.projection.length > 0, `${entry.contract} needs a projection target`);
    assert.ok(entry.projection.every((name) => name.startsWith('obs_')), `${entry.contract} projection must be obs_*`);
  }
});

test('schema-map: span attributes is the only sanctioned extension point', async () => {
  const { SCHEMA_MAP, ATTRIBUTE_EXTENSION_POINT } = await schemaMap();
  const span = SCHEMA_MAP.find((entry) => entry.contract === 'span');
  assert.equal(ATTRIBUTE_EXTENSION_POINT.contract, 'span');
  assert.equal(ATTRIBUTE_EXTENSION_POINT.field, 'attributes');
  assert.ok(span.extensionPoints.includes('attributes'));
  for (const entry of SCHEMA_MAP) {
    if (entry.contract !== 'span') assert.deepEqual(entry.extensionPoints, []);
  }
});

test('schema-map: schemaSnapshots hashes every contracts/agentic schema', async () => {
  const { schemaSnapshots } = await schemaMap();
  const snapshots = schemaSnapshots(schemaDir);
  assert.equal(Object.keys(snapshots).length, 29);
  assert.match(snapshots['span.schema.json'], /^[a-f0-9]{64}$/);
});

test('schema-map: verifyFrozenContracts passes against the live, unmodified contracts', async () => {
  const { verifyFrozenContracts } = await schemaMap();
  const result = verifyFrozenContracts({ schemaDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.frozen.commit, 'b9d9bdfa0511905a95b729753b82e5734adab6bb');
  assert.equal(Object.keys(result.checked).length, 29);
});

test('schema-map: verifyFrozenContracts detects a drifted schema hash', async () => {
  const { verifyFrozenContracts, schemaSnapshots, loadSnapshot } = await schemaMap();
  const live = schemaSnapshots(schemaDir);
  const tampered = { ...loadSnapshot(), 'span.schema.json': 'f'.repeat(64) };
  const result = verifyFrozenContracts({ schemaDir, snapshot: tampered });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches.map((item) => item.file), ['span.schema.json']);
  assert.equal(result.mismatches[0].expected, 'f'.repeat(64));
  assert.equal(result.mismatches[0].actual, live['span.schema.json']);
});

test('schema-map: verifyFrozenContracts reports a schema removed from the snapshot', async () => {
  const { verifyFrozenContracts, loadSnapshot } = await schemaMap();
  const snapshot = { ...loadSnapshot() };
  delete snapshot['run.schema.json'];
  const result = verifyFrozenContracts({ schemaDir, snapshot });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('run.schema.json'));
});

test('schema-map: verifyFrozenContracts reports a schema added after freezing', async () => {
  const { verifyFrozenContracts, loadSnapshot } = await schemaMap();
  const snapshot = { ...loadSnapshot(), 'ghost.schema.json': 'e'.repeat(64) };
  const result = verifyFrozenContracts({ schemaDir, snapshot });
  assert.equal(result.ok, false);
  assert.ok(result.unexpected.includes('ghost.schema.json'));
});

test('schema-map: loadSnapshot ships the frozen hashes with the source', async () => {
  const { loadSnapshot, schemaSnapshots } = await schemaMap();
  const snapshot = loadSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(schemaSnapshots(schemaDir)).sort());
});
