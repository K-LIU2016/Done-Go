import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  contractHash,
  loadSchema,
  validate,
} from '../../../../scripts/agentic/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const fixtureDir = join(contractDir, 'fixtures');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const fixtureNames = readdirSync(fixtureDir).filter(name => name.endsWith('.fixtures.json')).sort();

test('every fixture has at least two valid and one invalid object', () => {
  assert.ok(fixtureNames.length >= 20, `expected broad contract set, got ${fixtureNames.length}`);
  for (const name of fixtureNames) {
    const fixture = readJson(join(fixtureDir, name));
    assert.ok(Array.isArray(fixture.valid) && fixture.valid.length >= 2, name);
    assert.ok(Array.isArray(fixture.invalid) && fixture.invalid.length >= 1, name);
  }
});

test('every valid fixture passes and every invalid fixture fails its schema', () => {
  for (const name of fixtureNames) {
    const fixture = readJson(join(fixtureDir, name));
    const schemaName = name.replace('.fixtures.json', '.schema.json');
    const schema = loadSchema(schemaName, contractDir);
    for (const value of fixture.valid) {
      const result = validate(value, schema, { schemaDir: contractDir });
      assert.equal(result.valid, true, `${name} valid: ${JSON.stringify(result.errors)}`);
    }
    for (const value of fixture.invalid) {
      const result = validate(value, schema, { schemaDir: contractDir });
      assert.equal(result.valid, false, `${name} invalid unexpectedly passed`);
      assert.ok(result.errors.length > 0);
    }
  }
});

test('every schema has a matching fixture file', () => {
  const schemaNames = readdirSync(contractDir).filter(name => name.endsWith('.schema.json')).sort();
  assert.deepEqual(
    schemaNames.map(name => name.replace('.schema.json', '.fixtures.json')),
    fixtureNames,
  );
});

test('validator handles required, properties and additionalProperties', () => {
  const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false };
  assert.equal(validate({ name: 'ok' }, schema).valid, true);
  assert.equal(validate({}, schema).valid, false);
  assert.equal(validate({ name: 'ok', extra: true }, schema).valid, false);
});

test('validator handles enum, items and date-time format', () => {
  const schema = { type: 'object', required: ['state', 'at', 'items'], properties: {
    state: { enum: ['open', 'closed'] },
    at: { type: 'string', format: 'date-time' },
    items: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
  } };
  assert.equal(validate({ state: 'open', at: '2026-10-26T12:30:00Z', items: [1, 2] }, schema).valid, true);
  assert.equal(validate({ state: 'bad', at: 'not-a-date', items: [] }, schema).valid, false);
});

test('validator resolves same-directory refs', () => {
  const schema = { type: 'object', required: ['ref'], properties: { ref: { $ref: 'artifact-ref.schema.json' } } };
  assert.equal(validate({ ref: { artifactId: 'a1' } }, schema, { schemaDir: contractDir }).valid, true);
  assert.equal(validate({ ref: {} }, schema, { schemaDir: contractDir }).valid, false);
});

test('date-time format rejects impossible calendar dates', () => {
  const schema = { type: 'string', format: 'date-time' };
  assert.equal(validate('2026-10-26T12:30:00Z', schema).valid, true);
  assert.equal(validate('2026-02-30T12:30:00Z', schema).valid, false);
});

test('assertValid throws the public CONTRACT_INVALID error code', async () => {
  const { assertValid } = await import('../../../../scripts/agentic/contracts.mjs');
  assert.throws(
    () => assertValid({}, { type: 'object', required: ['id'] }),
    error => error.code === 'CONTRACT_INVALID' && Array.isArray(error.errors),
  );
});

test('contract README documents the W0 API and security boundary', () => {
  const readme = readFileSync(join(contractDir, 'README.md'), 'utf8');
  for (const term of ['状态机', '错误码', 'API 列表', 'owner', 'W0 不把路由挂到', 'contractHash']) {
    assert.match(readme, new RegExp(term));
  }
});

test('canonicalJson sorts object keys recursively but preserves array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 }, list: [{ z: 1, y: 2 }] }), '{"a":{"c":3,"d":2},"b":1,"list":[{"y":2,"z":1}]}');
});

test('contract hash ignores field order and changes when a field changes', async () => {
  const a = { missionId: 'm1', version: 1, goal: 'research', budget: { tokens: 100, calls: 2 } };
  const b = { budget: { calls: 2, tokens: 100 }, goal: 'research', version: 1, missionId: 'm1' };
  assert.equal(await contractHash(a), await contractHash(b));
  assert.notEqual(await contractHash(a), await contractHash({ ...a, goal: 'different' }));
  assert.equal(await contractHash({ ...a, hash: 'stale' }), await contractHash(a));
});

test('validator rejects an unresolvable same-directory ref', () => {
  const result = validate({ ref: true }, { type: 'object', properties: { ref: { $ref: 'missing.schema.json' } } }, { schemaDir: contractDir });
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /unresolvable/);
});
