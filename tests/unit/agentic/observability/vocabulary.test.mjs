import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule, CONTRACTS_DIR } from './_harness.mjs';

const contractsPath = fileURLToPath(CONTRACTS_DIR);
const schema = (name) => JSON.parse(readFileSync(`${contractsPath}${name}`, 'utf8'));
const vocabulary = () => loadModule('vocabulary.mjs');

test('vocabulary: UNKNOWN sentinel is the literal string UNKNOWN', async () => {
  const { UNKNOWN } = await vocabulary();
  assert.equal(UNKNOWN, 'UNKNOWN');
});

test('vocabulary: ACTOR_ROLES is exactly the six BRIEF §3 roles', async () => {
  const { ACTOR_ROLES } = await vocabulary();
  assert.deepEqual([...ACTOR_ROLES], [
    'conductor',
    'block_agent',
    'worker',
    'verifier',
    'reviewer',
    'fixer',
  ]);
});

test('vocabulary: MODEL_SOURCES enumerates every provenance source', async () => {
  const { MODEL_SOURCES, VERIFIABLE_MODEL_SOURCES } = await vocabulary();
  assert.deepEqual([...MODEL_SOURCES].sort(), ['fixture', 'gateway', 'local', 'mock', 'unknown']);
  assert.deepEqual([...VERIFIABLE_MODEL_SOURCES].sort(), ['gateway', 'local']);
});

test('vocabulary: ATTRIBUTE_KEYS are unique and namespaced gen_ai./donego.', async () => {
  const { ATTRIBUTE_KEYS } = await vocabulary();
  const values = Object.values(ATTRIBUTE_KEYS);
  assert.equal(new Set(values).size, values.length);
  for (const value of values) {
    assert.match(value, /^(gen_ai|donego)\./);
  }
});

test('vocabulary: ATTRIBUTE_KEYS carries every provenance projection key', async () => {
  const { ATTRIBUTE_KEYS } = await vocabulary();
  for (const name of ['requestModel', 'actorRole', 'actorModel', 'resolvedModel', 'modelSource', 'modelLocal']) {
    assert.equal(typeof ATTRIBUTE_KEYS[name], 'string', `missing ${name}`);
  }
});

test('vocabulary: ATTRIBUTE_KEYS covers the PRD §10.5 span attributes', async () => {
  const { ATTRIBUTE_KEYS } = await vocabulary();
  assert.equal(ATTRIBUTE_KEYS.agentName, 'gen_ai.agent.name');
  assert.equal(ATTRIBUTE_KEYS.missionId, 'donego.mission.id');
  assert.equal(ATTRIBUTE_KEYS.contractHash, 'donego.contract.hash');
  assert.equal(ATTRIBUTE_KEYS.workOrderId, 'donego.work_order.id');
});

test('vocabulary: enum tables do not drift from the frozen W0 schemas', async () => {
  const v = await vocabulary();
  assert.deepEqual([...v.SPAN_KINDS], schema('span.schema.json').properties.kind.enum);
  assert.deepEqual([...v.SPAN_STATUSES], schema('span.schema.json').properties.status.enum);
  assert.deepEqual([...v.RUN_STATES], schema('run.schema.json').properties.state.enum);
  assert.deepEqual([...v.STEP_KINDS], schema('step.schema.json').properties.kind.enum);
  assert.deepEqual([...v.STEP_STATES], schema('step.schema.json').properties.state.enum);
});

test('vocabulary: API_ERROR_CODES does not drift from api-error.schema.json', async () => {
  const { API_ERROR_CODES } = await vocabulary();
  const expected = schema('api-error.schema.json').properties.error.properties.code.enum;
  assert.deepEqual([...API_ERROR_CODES], expected);
});

test('vocabulary: OBS_ERROR_CODES names every internal rejection path', async () => {
  const { OBS_ERROR_CODES } = await vocabulary();
  for (const code of [
    'PROVENANCE_UNRESOLVED',
    'RUN_NOT_VERIFIABLE',
    'GATE_INCOMPLETE',
    'ACTOR_ROLE_INVALID',
    'ACTOR_INVALID',
    'MODEL_SOURCE_INVALID',
    'CACHE_UNVERIFIABLE',
    'MATRIX_INCOMPLETE',
    'OWNER_REQUIRED',
  ]) {
    assert.equal(OBS_ERROR_CODES[code], code);
  }
  for (const value of Object.values(OBS_ERROR_CODES)) {
    assert.equal(value, value.toUpperCase());
  }
});

test('vocabulary: observabilityError builds a coded Error without leaking secrets', async () => {
  const { observabilityError } = await vocabulary();
  const error = observabilityError('GATE_INCOMPLETE', 'gate is missing rc', { stream: 'w10' });
  assert.equal(error.code, 'GATE_INCOMPLETE');
  assert.equal(error.message, 'gate is missing rc');
  assert.deepEqual(error.details, { stream: 'w10' });
  assert.equal(/sk-|apikey|token=/i.test(error.message), false);
});

test('vocabulary: normalizeActor trims the model and marks gateway actors verifiable', async () => {
  const { normalizeActor, PROVENANCE } = await vocabulary();
  const actor = normalizeActor({ role: 'worker', model: '  gpt-6-luna  ', modelSource: 'gateway' });
  assert.equal(actor.role, 'worker');
  assert.equal(actor.model, 'gpt-6-luna');
  assert.equal(actor.modelSource, 'gateway');
  assert.equal(actor.provenance, PROVENANCE.RESOLVED);
  assert.equal(actor.verifiable, true);
  assert.equal(actor.unresolvedReason, null);
});

test('vocabulary: normalizeActor marks a missing model as UNKNOWN with MODEL_MISSING', async () => {
  const { normalizeActor, PROVENANCE, UNKNOWN } = await vocabulary();
  const actor = normalizeActor({ role: 'worker' });
  assert.equal(actor.model, null);
  assert.equal(actor.modelSource, 'unknown');
  assert.equal(actor.provenance, PROVENANCE.UNKNOWN);
  assert.equal(actor.verifiable, false);
  assert.equal(actor.unresolvedReason, 'MODEL_MISSING');
  assert.equal(actor.provenance, UNKNOWN);
});

test('vocabulary: normalizeActor treats blank and whitespace models as missing', async () => {
  const { normalizeActor, PROVENANCE } = await vocabulary();
  for (const model of ['', '   ', '\t\n']) {
    const actor = normalizeActor({ role: 'verifier', model });
    assert.equal(actor.provenance, PROVENANCE.UNKNOWN, `model ${JSON.stringify(model)}`);
    assert.equal(actor.unresolvedReason, 'MODEL_MISSING');
  }
});

test('vocabulary: normalizeActor never inherits a model from another actor', async () => {
  const { normalizeActor, PROVENANCE } = await vocabulary();
  const resolved = normalizeActor({ role: 'worker', model: 'gpt-6-luna', modelSource: 'gateway' });
  const unresolved = normalizeActor({ role: 'reviewer' }, resolved);
  assert.equal(resolved.model, 'gpt-6-luna');
  assert.equal(unresolved.model, null);
  assert.equal(unresolved.provenance, PROVENANCE.UNKNOWN);
});

test('vocabulary: normalizeActor rejects an unknown role', async () => {
  const { normalizeActor } = await vocabulary();
  assert.throws(
    () => normalizeActor({ role: 'intern', model: 'gpt-6-luna' }),
    (error) => error.code === 'ACTOR_ROLE_INVALID',
  );
  assert.throws(
    () => normalizeActor({ model: 'gpt-6-luna' }),
    (error) => error.code === 'ACTOR_ROLE_INVALID',
  );
  assert.throws(
    () => normalizeActor(null),
    (error) => error.code === 'ACTOR_INVALID',
  );
});

test('vocabulary: normalizeActor rejects an out-of-enum model source instead of guessing', async () => {
  const { normalizeActor } = await vocabulary();
  assert.throws(
    () => normalizeActor({ role: 'worker', model: 'gpt-6-luna', modelSource: 'prod' }),
    (error) => error.code === 'MODEL_SOURCE_INVALID',
  );
});

test('vocabulary: mock actors keep a resolved model but are never verifiable evidence', async () => {
  const { normalizeActor, PROVENANCE } = await vocabulary();
  const actor = normalizeActor({ role: 'reviewer', model: 'glm-5.3', modelSource: 'mock' });
  assert.equal(actor.provenance, PROVENANCE.RESOLVED);
  assert.equal(actor.modelSource, 'mock');
  assert.equal(actor.verifiable, false);
});

test('vocabulary: a resolved model with an unknown source is not verifiable', async () => {
  const { normalizeActor, PROVENANCE } = await vocabulary();
  const actor = normalizeActor({ role: 'fixer', model: 'glm-5.3' });
  assert.equal(actor.model, 'glm-5.3');
  assert.equal(actor.modelSource, 'unknown');
  assert.equal(actor.provenance, PROVENANCE.RESOLVED);
  assert.equal(actor.verifiable, false);
  assert.equal(actor.unresolvedReason, null);
});
