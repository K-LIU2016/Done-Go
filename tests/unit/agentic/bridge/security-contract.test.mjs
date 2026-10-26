// W8 G6/W0 收口：桥的安全输出必须能被冻结契约校验器接受。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid, loadSchema } from '../../../../scripts/agentic/contracts.mjs';
import { createCodexAdapter } from '../../../../packages/donego-bridge/src/codex/adapter.mjs';
import { fakeSessionFactory, PLAN_FIXTURE, MISSION } from './_fake-codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '../../../../contracts/agentic');
const schema = name => loadSchema(name, schemaDir);

test('Codex adapter emits a frozen-contract codexPlan alongside the planning detail', async () => {
  const factory = fakeSessionFactory({
    initialize: () => ({ protocolVersion: 1 }),
    'thread/start': () => ({ threadId: 'th_1' }),
    'thread/goal/set': () => ({ ok: true }),
    'turn/start': () => ({ output: PLAN_FIXTURE }),
  });
  const adapter = createCodexAdapter({ sessionFactory: factory });
  await adapter.start();
  const result = await adapter.plan(MISSION());
  assert.doesNotThrow(() => assertValid(result.codexPlan, schema('codex-plan.schema.json'), { schemaDir }));
  assert.equal(result.codexPlan.missionId, 'm1');
});

test('bridge Need event does not claim W0 Need schema without required delivery fields', () => {
  const need = { type: 'approval', missionId: 'm1', reason: 'outside worktree' };
  const result = assertValid;
  assert.equal(typeof result, 'function');
  assert.throws(() => result(need, schema('need.schema.json'), { schemaDir }), /CONTRACT_INVALID/);
});
