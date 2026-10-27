import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertValid,
  loadSchema,
} from '../../../../scripts/agentic/contracts.mjs';
import { createCodexAdapter } from '../../../../packages/donego-bridge/src/codex/adapter.mjs';
import { chooseModel } from '../../../../packages/donego-bridge/src/model/choose.mjs';
import { fakeSessionFactory, PLAN_FIXTURE, MISSION } from './_fake-codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const fixtureDir = join(contractDir, 'fixtures');
const schema = name => loadSchema(name, contractDir);
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// W8 bridge boundary: the frozen W0 fixtures remain the compatibility corpus.
test('bridge consistency accepts every W0 valid fixture and rejects every invalid fixture', () => {
  const fixtureNames = readdirSync(fixtureDir).filter(name => name.endsWith('.fixtures.json')).sort();
  assert.ok(fixtureNames.length >= 20);
  for (const fixtureName of fixtureNames) {
    const fixture = readJson(join(fixtureDir, fixtureName));
    const contractSchema = schema(fixtureName.replace('.fixtures.json', '.schema.json'));
    for (const value of fixture.valid) {
      assert.doesNotThrow(() => assertValid(value, contractSchema, { schemaDir: contractDir }), fixtureName);
    }
    for (const value of fixture.invalid) {
      assert.throws(() => assertValid(value, contractSchema, { schemaDir: contractDir }), fixtureName);
    }
  }
});

test('bridge-produced model choice and Codex plan satisfy frozen schemas', async () => {
  const choice = chooseModel(PLAN_FIXTURE, { weeklyUsedPercent: 0 }, {});
  assert.doesNotThrow(() => assertValid(choice, schema('codex-choice.schema.json'), { schemaDir: contractDir }));

  const factory = fakeSessionFactory({
    initialize: () => ({ protocolVersion: 1 }),
    'thread/start': () => ({ threadId: 'th_consistency' }),
    'thread/goal/set': () => ({ ok: true }),
    'turn/start': () => ({ output: PLAN_FIXTURE }),
  });
  const adapter = createCodexAdapter({ sessionFactory: factory });
  await adapter.start();
  const result = await adapter.plan(MISSION());
  assert.doesNotThrow(() => assertValid(result.codexPlan, schema('codex-plan.schema.json'), { schemaDir: contractDir }));
});
