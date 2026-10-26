// S2D-W2 · M6 崩溃恢复 · 子进程夹具（非测试文件，不被收集）
// 用法：
//   node child-run.mjs --mode initial --db <file> --marker <file> --status <file>
//   node child-run.mjs --mode resume  --db <file> --marker <file> --run <runId>
// 行为（plan.md M6 subtask 1）：在临时文件库上跑 3-step run：
//   step1 纯本地（结果写进 status 文件）；step2 经 outbox 派发一个“外部动作”
//   （send = 向 marker 文件追加一行 'X'——一次性副作用），随后 initial 模式
//   挂起等待（父测试看到 marker 出现即 SIGKILL，制造“外部动作已发生、检查点
//   未落”的崩溃点位）；resume 模式重放同一程序（幂等跳过 + 不重发）并跑完
//   step3、finish({dodMet:true})。
// 依据：BUILD-PLAN §3 W2-4 L109 第一句；V3-19/20/22。
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEngineDb, applyEngineMigrations } from '../../../../../scripts/agentic/engine/db.mjs';
import { createRunEngine } from '../../../../../scripts/agentic/engine/run-engine.mjs';
import { createOutbox } from '../../../../../scripts/agentic/engine/outbox.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = resolve(ROOT, 'scripts', 'agentic', 'db', 'migrations');
const CONTRACT_HASH = 'a'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])));
const { mode, db: dbFile, marker, status, run: runIdArg } = args;

const db = openEngineDb({ file: dbFile });
applyEngineMigrations(db, MIGRATIONS_DIR);
const outbox = createOutbox({ db });
const engine = createRunEngine({
  db, outbox, now: () => '2026-10-26T09:00:00+08:00', sleep: async () => {}, retryBaseMs: 10,
});

const budget = { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 };

// “外部动作” mock：向 marker 追加一行 X（append 恰好一次 = 副作用恰好一次）。
// initial 模式下 send 在副作用之后**挂起不返回**——制造确定性崩溃点位：
// 外部动作已发生、dispatch 未完成（entry 停在 dispatched、检查点未落）。
const send = async (payload) => {
  appendFileSync(marker, 'X\n');
  if (mode === 'initial') await new Promise(() => { setInterval(() => {}, 1000); });
  return { externalId: 'ext-marker', receipt: { marker: payload.marker } };
};
const verify = async () => (existsSync(marker) ? { ok: true } : { ok: false });
const probe = async () => (existsSync(marker) ? { status: 'verified' } : { status: 'unknown' });

async function step2(ctx) {
  const entry = await ctx.registerAction({ actionKey: 'ext-marker', payload: { marker } });
  const r = await outbox.dispatch(entry, { send, verify });
  if (!r.dispatched) await outbox.reconcile(entry, { probe }); // 已派发/unknown → 只对账，不重发
  return { dispatch: r.dispatched ? r.status : 'reconciled' };
}

async function main() {
  if (mode === 'initial') {
    const run = engine.startRun({ missionId: 'm_crash', contractHash: CONTRACT_HASH, dod: ['done'], budget });
    await run.step('step1', { n: 1 }, async () => 'first-result');
    writeFileSync(status, JSON.stringify({ runId: run.id, step1Result: 'first-result' }));
    await run.step('step2', { n: 2 }, async (ctx) => step2(ctx)); // 阻塞在 send 挂起处等父进程 SIGKILL
    // 正常情况下到不了这里（父进程会 SIGKILL）
    await run.step('step3', { n: 3 }, async () => 'third');
    await run.finish({ dodMet: true });
    return;
  }
  if (mode === 'resume') {
    const run = engine.attach(runIdArg);
    await run.resume({ revalidate: async () => CONTRACT_HASH });
    await run.step('step1', { n: 1 }, async () => 'first-result'); // 幂等跳过
    await run.step('step2', { n: 2 }, async (ctx) => step2(ctx));
    await run.step('step3', { n: 3 }, async () => 'third');
    await run.finish({ dodMet: true });
    const row = engine.getRun(run.id);
    console.log(JSON.stringify({ runId: run.id, status: row.status }));
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

main().then(() => { db.close(); process.exit(0); }, (err) => { console.error(err); process.exit(1); });
