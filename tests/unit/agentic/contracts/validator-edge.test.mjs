import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValid, canonicalJson, validate } from '../../../../scripts/agentic/contracts.mjs';

test('validator enforces composite schemas and scalar constraints', () => {
  const schema = {
    allOf: [
      { type: 'object', required: ['state', 'label'], properties: {
        state: { enum: ['open', 'closed'] },
        label: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[a-z]+$' },
      } },
      { properties: { state: { const: 'open' } } },
    ],
  };
  assert.equal(validate({ state: 'open', label: 'ready' }, schema).valid, true);
  assert.equal(validate({ state: 'closed', label: 'ready' }, schema).valid, false);
  assert.equal(validate({ state: 'open', label: 'R' }, schema).valid, false);
  assert.equal(validate({ state: 'open', label: 'ready-now' }, schema).valid, false);
});

test('validator supports anyOf, oneOf and not branches', () => {
  const either = { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }] };
  assert.equal(validate('ok', either).valid, true);
  assert.equal(validate(2, either).valid, true);
  assert.equal(validate(0, either).valid, false);

  const exactlyOne = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.equal(validate(1.5, exactlyOne).valid, true);
  assert.equal(validate(1, exactlyOne).valid, false);
  assert.equal(validate('1', exactlyOne).valid, false);
  assert.equal(validate('secret', { not: { const: 'secret' } }).valid, false);
  assert.equal(validate('public', { not: { const: 'secret' } }).valid, true);
});

test('validator enforces arrays, numeric limits and object property count', () => {
  const schema = {
    type: 'object',
    minProperties: 2,
    properties: {
      values: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 3 } },
      score: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  assert.equal(validate({ values: [1, 2], score: 0.5 }, schema).valid, true);
  assert.equal(validate({ values: [], score: 0.5 }, schema).valid, false);
  assert.equal(validate({ values: [1, 1], score: 0.5 }, schema).valid, false);
  assert.equal(validate({ values: [4], score: 0.5 }, schema).valid, false);
  assert.equal(validate({ values: [1], score: 2 }, schema).valid, false);
  assert.equal(validate({ values: [1] }, schema).valid, false);
});

test('validator handles date, time, unknown formats and primitive types', () => {
  assert.equal(validate('2026-10-26', { type: 'string', format: 'date' }).valid, true);
  assert.equal(validate('2026-02-30', { type: 'string', format: 'date' }).valid, false);
  assert.equal(validate('12:30:45Z', { type: 'string', format: 'time' }).valid, true);
  assert.equal(validate('25:30:00Z', { type: 'string', format: 'time' }).valid, false);
  assert.equal(validate('opaque', { type: 'string', format: 'custom-format' }).valid, true);
  assert.equal(validate(null, { type: 'null' }).valid, true);
  assert.equal(validate(true, { type: 'boolean' }).valid, true);
  assert.equal(validate(1, { type: 'number' }).valid, true);
  assert.equal(validate(1, { type: 'integer' }).valid, true);
  assert.equal(validate({}, { type: 'array' }).valid, false);
  assert.equal(validate('value', { type: 'unsupported-schema-type' }).valid, true);
});

test('validator resolves JSON pointer and rejects URL refs without network access', () => {
  const schema = {
    type: 'object',
    required: ['value'],
    properties: { value: { $ref: '#/$defs/nonEmpty' } },
    $defs: { nonEmpty: { type: 'string', minLength: 1 } },
  };
  assert.equal(validate({ value: 'ok' }, schema).valid, true);
  assert.equal(validate({ value: '' }, schema).valid, false);
  const result = validate('x', { $ref: 'https://example.invalid/schema.json' }, { schemaDir: '.' });
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /unresolvable/);
});

test('assertValid returns the original valid value', () => {
  const value = { id: 'a1' };
  assert.strictEqual(assertValid(value, { type: 'object', required: ['id'] }), value);
});

test('canonicalJson handles primitive values and preserves array order', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('text'), '"text"');
  assert.equal(canonicalJson([2, 1]), '[2,1]');
});
