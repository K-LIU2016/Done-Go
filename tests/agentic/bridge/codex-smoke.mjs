// W8 M10 Codex 真实冒烟：仅在 DONEGO_S2D_SMOKE=1 时运行，始终使用一次性临时 git 仓库。
// 回合数、模型、effort、耗时和结果写入同目录 SMOKE-LOG.md；不读取、不打印、也不落盘任何密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createJsonRpcSession } from '../../../packages/donego-bridge/src/codex/jsonrpc.mjs';
import { createCodexAdapter } from '../../../packages/donego-bridge/src/codex/adapter.mjs';
import { chooseModel } from '../../../packages/donego-bridge/src/model/choose.mjs';
import { createMissionWorktree, containedIn } from '../../../packages/donego-bridge/src/git/worktree.mjs';
import { decideApproval } from '../../../packages/donego-bridge/src/policy/approvals.mjs';

const ENABLED = process.env.DONEGO_S2D_SMOKE === '1';
const MAX_TURNS = 10; // BUILD-PLAN §2.3：真实 Codex 回合上限。
const TURN_TIMEOUT_MS = 8 * 60 * 1000;
const LOG_FILE = new URL('./SMOKE-LOG.md', import.meta.url);
const PLAN_SCHEMA = {
  type: 'object',
  // Codex may add harmless complexity-signal fields (for example `kinds` or
  // `signals`) while retaining the required plan envelope.
  additionalProperties: true,
  required: ['files', 'summary', 'riskFlags', 'tests', 'estimatedDiffLines'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    riskFlags: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    estimatedDiffLines: { type: 'number' },
  },
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), 'donego-codex-smoke-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'donego-smoke@example.invalid']);
  git(root, ['config', 'user.name', 'DoneGo Smoke']);
  writeFileSync(join(root, 'math.mjs'), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(join(root, 'math.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\n\ntest('add', () => assert.equal(add(1, 2), 3));\n");
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'smoke fixture']);
  return root;
}

function parsePlan(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch (error) { throw new Error(`CODEX_PLAN_NOT_JSON: ${error.message}`); }
}

function textFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'agentMessage') return item.text || '';
  if (item.type === 'plan') return item.text || '';
  return '';
}

/**
 * Adapt the app-server's asynchronous turn notifications to the adapter's
 * request/response seam. The protocol's turn/start response only acknowledges
 * creation; the result arrives in turn/completed and item/completed events.
 */
function createCompletingSessionFactory({ spawn, argv, onTurn, turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
  return hooks => {
    const completed = new Map();
    const waiters = new Map();
    const items = new Map();
    const raw = createJsonRpcSession({
      spawn,
      argv,
      onNotify(method, params) {
        hooks.onNotify?.(method, params);
        if (method === 'item/completed' && params?.turnId) {
          const list = items.get(params.turnId) || [];
          list.push(params.item);
          items.set(params.turnId, list);
        }
        if (method !== 'turn/completed' || !params?.turn?.id) return;
        const turnId = params.turn.id;
        const result = {
          turn: params.turn,
          text: (items.get(turnId) || []).map(textFromItem).join(''),
        };
        completed.set(turnId, result);
        const resolve = waiters.get(turnId);
        if (resolve) { waiters.delete(turnId); resolve(result); }
      },
      onServerRequest: hooks.onServerRequest,
      onParseError: hooks.onParseError,
    });

    async function completedTurn(turnId) {
      const existing = completed.get(turnId);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(turnId);
          reject(new Error(`CODEX_TURN_TIMEOUT: ${turnId}`));
        }, turnTimeoutMs);
        waiters.set(turnId, result => { clearTimeout(timer); resolve(result); });
      });
    }

    async function request(method, params) {
      // The checked-in adapter keeps fixture compatibility aliases (`goal`, `sandbox`,
      // `diff`). Strip those aliases at the real protocol boundary; generated v2
      // schemas accept only the fields emitted by Codex 0.163.0.
      const wireParams = method === 'thread/goal/set'
        ? (({ goal: _goal, ...value }) => value)(params || {})
        : method === 'review/start'
          ? (({ diff: _diff, ...value }) => value)(params || {})
          : method === 'turn/start'
            ? (({ sandbox: _sandbox, outputSchema: _outputSchema, ...value }) => value)(params || {})
            : params;
      if (method !== 'turn/start') return raw.request(method, wireParams);
      const startedAt = Date.now();
      const response = await raw.request(method, wireParams);
      const turnId = response?.turn?.id ?? response?.turnId;
      if (!turnId) throw new Error('CODEX_TURN_ID_MISSING');
      const result = await completedTurn(turnId);
      const elapsedMs = Date.now() - startedAt;
      onTurn?.({ model: params?.model, effort: params?.effort, elapsedMs, result: result.turn?.status || 'completed' });
      const text = result.text.trim();
      return { output: params?.outputSchema ? parsePlan(text) : { status: result.turn?.status || 'completed', text } };
    }

    return Object.freeze({ request, notify: raw.notify, close: raw.close });
  };
}

function approveSafeRequest(request, contract) {
  const method = request?.method;
  const params = request?.params || {};
  if (method === 'applyPatchApproval' && params.fileChanges && typeof params.fileChanges === 'object') {
    const paths = Object.keys(params.fileChanges);
    const safe = paths.length > 0 && paths.every(file => containedIn(contract.worktreeRoot, join(contract.worktreeRoot, file)));
    return safe ? { decision: 'approve', reason: 'SMOKE_FILE_CHANGE_WITHIN_WORKTREE' } : { decision: 'reject', reason: 'SMOKE_FILE_CHANGE_OUTSIDE_WORKTREE' };
  }
  return decideApproval(request, contract, { resolvePath: (candidate, root) => containedIn(root, candidate) });
}

function runTests(worktree) {
  execFileSync(process.execPath, ['--test', 'math.test.mjs'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeSmokeLog({ root, worktree, turns, plan, choice, result, error }) {
  const lines = [
    '# W8 Codex smoke log',
    '',
    `- date: ${new Date().toISOString()}`,
    `- temporary repository: ${basename(root)}`,
    `- worktree fence: ${containedIn(worktree, join(worktree, 'math.mjs')) ? 'passed' : 'failed'}`,
    `- real Codex turn count: ${turns.length}/${MAX_TURNS}`,
    `- final result: ${result || (error ? 'failed' : 'not-run')}`,
    '',
    '## Turns',
    '',
    '| # | model | effort | elapsed_ms | result |',
    '|---:|---|---|---:|---|',
    ...turns.map((turn, index) => `| ${index + 1} | ${turn.model || 'unknown'} | ${turn.effort || 'unknown'} | ${turn.elapsedMs} | ${turn.result} |`),
    '',
    '## Structured plan and model choice',
    '',
    '```json',
    JSON.stringify({ plan, choice }, null, 2),
    '```',
    ...(error ? ['', `- error: ${String(error.message || error).replaceAll('\n', ' ')}`] : []),
  ];
  writeFileSync(LOG_FILE, `${lines.join('\n')}\n`, { mode: 0o644 });
}

test('W8 真实 Codex 冒烟：函数+测试→plan→chooseModel→execute→test→review', { skip: !ENABLED, timeout: 10 * 60 * 1000 }, async () => {
  const turns = [];
  let root;
  let worktree;
  let plan;
  let choice;
  let finalResult = 'failed';
  try {
    root = makeRepository();
    const missionId = `smoke-${Date.now().toString(36)}`;
    const created = createMissionWorktree(root, missionId, { base: 'HEAD' });
    worktree = created.path;
    assert.equal(containedIn(worktree, join(worktree, 'math.mjs')), true, 'mission worktree fence must hold');
    const contract = {
      missionId,
      worktreeRoot: worktree,
      summary: 'Add a clamp(value, min, max) function to math.mjs and add a focused node:test in math.test.mjs. Do not modify other files.',
      definitionOfDone: ['math.test.mjs passes', 'only the requested function and test are changed'],
      deliverables: ['math.mjs', 'math.test.mjs'],
    };
    const sessionFactory = createCompletingSessionFactory({
      spawn: (command, args, options) => requireSpawn(command, args, options),
      argv: ['codex', 'app-server', '--stdio'],
      onTurn: turn => {
        turns.push(turn);
        assert.ok(turns.length <= MAX_TURNS, 'real Codex turn limit exceeded');
      },
    });
    const adapter = createCodexAdapter({
      sessionFactory,
      decideApproval: (request, receivedContract) => approveSafeRequest(request, { ...contract, ...receivedContract }),
      onNeed: need => { throw new Error(`UNEXPECTED_SMOKE_NEED: ${need.reason}`); },
      now: Date.now,
    });
    await adapter.start();
    const planned = await adapter.plan({ missionId, worktree, contract });
    plan = parsePlan(planned.plan);
    assert.ok(Array.isArray(plan.files), 'Codex plan must include files');
    assert.ok(Array.isArray(plan.tests), 'Codex plan must include tests');
    const limits = await adapter.rateLimits();
    choice = chooseModel(plan, limits, {});
    // The smoke contract pins external calls to gpt-6-luna/low (BUILD-PLAN §2.3).
    // chooseModel is still exercised and retained in the log for policy evidence.
    choice = { ...choice, model: 'gpt-6-luna', effort: 'low', need: false, reason: `${choice.reason}; smoke pin gpt-6-luna/low` };
    const executed = await adapter.execute(missionId, choice);
    assert.ok(executed.output, 'execute must return a Codex result');
    runTests(worktree);
    const reviewed = await adapter.review(missionId, git(worktree, ['diff']), choice);
    assert.ok(reviewed, 'review/start must return a response');
    assert.equal(git(worktree, ['status', '--short']).includes('math.mjs'), true, 'Codex must change the requested source');
    assert.equal(containedIn(worktree, join(worktree, 'math.test.mjs')), true);
    finalResult = 'passed';
  } catch (error) {
    finalResult = 'failed';
    throw error;
  } finally {
    writeSmokeLog({ root: root || 'not-created', worktree: worktree || 'not-created', turns, plan, choice, result: finalResult });
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function requireSpawn(command, args, options) {
  // Lazy import avoids making the smoke fixture itself spawn a process when skipped.
  // The real test path injects node:child_process.spawn without reading any key.
  return execSpawn(command, args, options);
}

import { spawn as execSpawn } from 'node:child_process';

export { createCompletingSessionFactory, parsePlan };
