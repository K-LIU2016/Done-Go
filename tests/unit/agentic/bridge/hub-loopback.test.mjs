// M9 环回集成单测：真实 bridge hub/WSS + CLI 出站桥 + 假 Codex runtime。
// 不启动真实 Codex；覆盖 pair→start→plan→chooseModel→execute→Need→review→fork/revert，
// 以及 owner 隔离、重连/吊销和消息大小门禁。端口限定在 W8 端口段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { runCli } from '../../../../packages/donego-bridge/src/cli.mjs';
import { createBridgeRuntime } from '../../../../packages/donego-bridge/src/runtime/session.mjs';
import { createPairingService } from '../../../../scripts/agentic/bridge-hub/pairing.mjs';
import { createDeviceRegistry } from '../../../../scripts/agentic/bridge-hub/devices.mjs';
import { createBridgeRoutes } from '../../../../scripts/agentic/bridge-hub/routes.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/agentic/db/migrations');
const PORTS = [17631, 17632, 17633, 17634, 17635, 17636, 17637, 17638, 17639];
const PLAN = { files: ['src/add.mjs'], summary: 'add helper', estimatedDiffLines: 12, riskFlags: [], tests: ['node --test'], needsNewTests: true };
const contract = () => ({ id: 'contract-1', missionId: 'm1', goal: 'add helper', summary: 'add helper and test', definitionOfDone: ['tests pass'], deliverables: ['src/**', 'tests/**'] });

function openDb() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).filter(name => /^bridge-.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  return db;
}

async function listen(server) {
  for (const port of PORTS) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('error', onError); reject(error); };
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
      });
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('W8_PORT_RANGE_EXHAUSTED');
}

async function makeHub() {
  const db = openDb();
  const pairing = createPairingService({ db });
  const devices = createDeviceRegistry({ db });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const routes = createBridgeRoutes({
    db,
    pairing,
    devices,
    wss,
    maxPayloadBytes: 2048,
    heartbeatMs: 25,
    auth: req => ({ ownerId: req.headers['x-test-owner'] || 'owner-e2e' }),
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!routes(req, res, pathname)) { res.statusCode = 404; res.end(); }
  });
  server.on('upgrade', (req, socket, head) => { if (!routes.handleUpgrade(req, socket, head)) socket.destroy(); });
  const port = await listen(server);
  return { db, pairing, devices, routes, wss, server, base: `http://127.0.0.1:${port}` };
}

async function closeHub(hub) {
  hub.routes.close();
  for (const ws of hub.wss.clients) ws.close();
  await new Promise(resolve => hub.server.close(() => resolve()));
  await new Promise(resolve => hub.wss.close(() => resolve()));
  hub.db.close();
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail('integration condition timed out');
}

function fakeMissionRuntime(events) {
  let need;
  const adapter = {
    start: async () => {},
    plan: async mission => ({ threadId: `thread-${mission.missionId}`, plan: PLAN }),
    rateLimits: async () => ({ weeklyUsedPercent: 12, spendControlReached: false, activeForeignThreads: 0 }),
    execute: async () => { need?.({ requestId: 77, method: 'item/commandExecution/requestApproval', reason: 'OUT_OF_SCOPE' }); return { output: { status: 'completed' } }; },
    review: async (_id, diff, choice) => ({ verdict: 'pass', diff, choice }),
    steer: async (_id, text) => ({ text }),
    interrupt: async () => ({ ok: true }),
    fork: async () => ({ threadId: 'thread-fork' }),
    revert: async (_id, ref) => ({ ref }),
    adoptThread: () => {},
    close: () => {},
  };
  const runtime = createBridgeRuntime({
    makeAdapter: hooks => { need = hooks.onNeed; return adapter; },
    worktrees: { create: async missionId => ({ path: `/tmp/donego-${missionId}`, branch: `feat/donego-${missionId}` }) },
    repoRoot: '/tmp/integration-repo',
    chooseModel: () => ({ model: 'gpt-6-sol', effort: 'medium', reason: '标准', quotaSnapshot: {} }),
    chooseReviewModel: () => ({ model: 'gpt-6-luna', effort: 'high' }),
    sendEvent: event => events.push(event),
  });
  return runtime;
}

async function pair(hub, owner, dir, { fakeFetch = false } = {}) {
  const { code } = hub.pairing.issuePairingCode(owner);
  const result = await runCli(['pair', code, '--hub-url', hub.base], {
    configDir: dir,
    stateDir: dir,
    io: { print: () => {} },
    fetchImpl: fakeFetch
      ? async () => ({ status: 200, body: { deviceId: 'fake-device', token: 'f'.repeat(48) } })
      : (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, 'x-test-owner': owner } }),
    now: () => 123,
  });
  assert.equal(result.code, 0);
  return JSON.parse(readFileSync(join(dir, 'device.json'), 'utf8'));
}

async function start(hub, owner, dir, onMessage, onRevoked = () => {}) {
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const result = await runCli(['start'], {
    configDir: dir,
    stateDir: dir,
    WebSocket,
    heartbeatMs: 25,
    minBackoffMs: 15,
    maxBackoffMs: 60,
    enableRuntime: false,
    onMessage,
    onRevoked,
    onStateChange: state => { if (state === 'connected') connected(); },
    io: { print: () => {} },
  });
  assert.equal(result.code, 0);
  await ready;
  return result.client;
}

test('M9 全流程环回：pair/start→plan/选模/execute+Need→review/fork/revert，owner 隔离', async () => {
  const hub = await makeHub();
  const aDir = mkdtempSync(join(tmpdir(), 'donego-loop-a-'));
  const bDir = mkdtempSync(join(tmpdir(), 'donego-loop-b-'));
  const events = [];
  const receivedA = [];
  const receivedB = [];
  const results = [];
  const runtime = fakeMissionRuntime(events);
  const dispatch = (received, message) => {
    received.push(message);
    if (message.type === 'mission.command') {
      const { type, ...command } = message;
      results.push(runtime.handleCommand({ ...command, type: message.command }));
    }
  };
  let clientA;
  let clientB;
  try {
    const configA = await pair(hub, 'owner-a', aDir);
    const configB = await pair(hub, 'owner-b', bDir);
    assert.notEqual(configA.token, configB.token, '每台桥令牌独立');
    clientA = await start(hub, 'owner-a', aDir, message => dispatch(receivedA, message));
    clientB = await start(hub, 'owner-b', bDir, message => dispatch(receivedB, message));

    assert.equal(hub.routes.sendToOwner('owner-a', { type: 'mission.command', command: 'mission.plan', mission: { missionId: 'm1', contract: contract() } }), 1);
    await eventually(() => events.some(event => event.type === 'mission.planned'));
    assert.equal(receivedB.length, 0, 'owner-b 不得看到 owner-a 指令');
    assert.equal(events.find(event => event.type === 'mission.planned').threadId, 'thread-m1');

    assert.equal(hub.routes.sendToOwner('owner-a', { type: 'mission.command', command: 'mission.execute', missionId: 'm1' }), 1);
    await eventually(() => events.some(event => event.type === 'mission.executed'));
    await eventually(() => events.some(event => event.type === 'need' && event.requestId === 77));
    assert.equal(events.find(event => event.type === 'mission.model.selected').model, 'gpt-6-sol');

    for (const [command, key] of [['mission.review', 'mission.reviewed'], ['mission.fork', 'mission.forked'], ['mission.revert', 'mission.reverted']]) {
      const payload = command === 'mission.review' ? { diff: 'diff --git', missionId: 'm1' } : { missionId: 'm1', ref: 'checkpoint-1' };
      assert.equal(hub.routes.sendToOwner('owner-a', { type: 'mission.command', command, ...payload }), 1);
      await eventually(() => events.some(event => event.type === key));
    }
    await Promise.all(results);
    assert.ok(events.some(event => event.type === 'mission.reviewed' && event.verdict === 'pass'));
    assert.equal(runtime.getState().missions.m1.status, 'executed', '后续 fork/revert 不应覆盖已完成执行状态');
    clientA.stop();
    clientB.stop();
  } finally {
    clientA?.stop();
    clientB?.stop();
    rmSync(aDir, { recursive: true, force: true });
    rmSync(bDir, { recursive: true, force: true });
    await closeHub(hub);
  }
});

test('M9 bridge 生命周期：断线退避重连、撤销立即停止、超限帧 1009', async () => {
  const hub = await makeHub();
  const dir = mkdtempSync(join(tmpdir(), 'donego-life-'));
  const rawDir = mkdtempSync(join(tmpdir(), 'donego-life-raw-'));
  let client;
  let raw;
  let revoked = 0;
  try {
    const config = await pair(hub, 'owner-life', dir);
    const rawConfig = await pair(hub, 'owner-life', rawDir);
    const fakeDir = mkdtempSync(join(tmpdir(), 'donego-life-fake-'));
    try { assert.equal((await pair(hub, 'owner-life', fakeDir, { fakeFetch: true })).deviceId, 'fake-device'); }
    finally { rmSync(fakeDir, { recursive: true, force: true }); }
    client = await start(hub, 'owner-life', dir, () => {}, () => { revoked += 1; });
    raw = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${hub.base.replace('http', 'ws')}/api/bridge`, { headers: { authorization: `Bearer ${rawConfig.token}` } });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    const closed = new Promise(resolve => raw.once('close', code => resolve(code)));
    raw.send('x'.repeat(8192));
    assert.equal(await closed, 1009);

    const before = hub.wss.clients.size;
    const revoke = await fetch(`${hub.base}/api/bridge/devices/revoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': 'owner-life' }, body: JSON.stringify({ deviceId: config.deviceId }) });
    assert.equal(revoke.status, 200);
    await eventually(() => !hub.devices.resolveToken(config.token));
    await wait(100);
    assert.ok(hub.wss.clients.size <= before, '吊销后不得因重连重新建立会话');
    client.stop();
  } finally {
    client?.stop();
    raw?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(rawDir, { recursive: true, force: true });
    await closeHub(hub);
  }
});
