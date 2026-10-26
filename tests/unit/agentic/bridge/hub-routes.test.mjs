// M2 bridge-hub 路由/WSS 单测（TDD RED 先行）。
// 契约来源：.s2d/plan.md §2 M2、BUILD-PLAN §2.1 L46（createBridgeRoutes 工厂，不挂 serve-tango）+ §3 W8-7
// （WSS /api/bridge：鉴权、owner 隔离、消息大小上限）、PRD §6.5 L400（服务端只接受出站桥回连）。
// harness：node:http + ws noServer + 内存库自跑迁移；端口只用本流段 17631–17639。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createPairingService } from '../../../../scripts/agentic/bridge-hub/pairing.mjs';
import { createDeviceRegistry } from '../../../../scripts/agentic/bridge-hub/devices.mjs';
import { createBridgeRoutes } from '../../../../scripts/agentic/bridge-hub/routes.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/agentic/db/migrations');
const PORT_RANGE = [17631, 17639];

function openDb() {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(migrationsDir).filter(f => /^bridge-.*\.sql$/.test(f)).sort();
  assert.ok(files.length >= 1, '至少应有一个 bridge-* 迁移文件');
  for (const f of files) db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  return db;
}

async function listenInRange(server) {
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port += 1) {
    try { await new Promise((res, rej) => server.once('error', rej).listen(port, '127.0.0.1', res)); return port; }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; server.removeAllListeners('error'); }
  }
  throw new Error('端口段 17631–17639 全被占用');
}

async function makeHub(over = {}) {
  const db = openDb();
  let t = 1_000_000;
  const deps = {
    db,
    auth: req => {
      const owner = req.headers['x-test-owner'];
      if (!owner) throw new Error('AUTH_REQUIRED');
      return { ownerId: owner };
    },
    now: () => t,
    wss: new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }),
    heartbeatMs: 40,
    maxPayloadBytes: 64 * 1024,
    ...over,
  };
  const pairing = createPairingService({ db, now: deps.now });
  const devices = createDeviceRegistry({ db, now: deps.now });
  const routes = createBridgeRoutes({ ...deps, pairing, devices });
  const server = createHttpServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!routes(req, res, pathname)) { res.statusCode = 404; res.end('{"error":"NOT_FOUND"}'); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!routes.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await listenInRange(server);
  return { routes, server, port, pairing, devices, db, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, advance: ms => { t += ms; } };
}

function postJson(base, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = httpRequest(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

function wsOpen(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP_${res.statusCode}`), { statusCode: res.statusCode })));
    ws.once('error', reject);
  });
}

function nextMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS_MESSAGE_TIMEOUT')), timeoutMs);
    ws.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
  });
}

test('配对端点：POST /api/bridge/pair 用一次性码换设备令牌；坏码 400；未登录 401', async () => {
  const hub = await makeHub();
  try {
    const { code } = hub.pairing.issuePairingCode('owner_a');
    const ok = await postJson(hub.base, '/api/bridge/pair', { code, label: 'MBP' }, { 'x-test-owner': 'owner_a' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token?.length >= 43, '下发设备令牌');
    assert.ok(ok.body.deviceId);
    const bad = await postJson(hub.base, '/api/bridge/pair', { code: '000000', label: 'x' }, { 'x-test-owner': 'owner_a' });
    assert.equal(bad.status, 400);
    const anon = await postJson(hub.base, '/api/bridge/pair', { code, label: 'x' });
    assert.equal(anon.status, 401);
  } finally { hub.server.close(); hub.wss?.close?.(); }
});

test('WSS /api/bridge：Bearer 设备令牌鉴权通过；伪造令牌收到 HTTP 401', async () => {
  const hub = await makeHub();
  try {
    const { token } = hub.devices.issueDeviceToken('owner_a', 'd1');
    const ws = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${token}` });
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await assert.rejects(() => wsOpen(`${hub.wsBase}/api/bridge`, { authorization: 'Bearer nope' }), /HTTP_401|401/);
  } finally { hub.server.close(); hub.wss?.close?.(); }
});

test('owner 隔离：sendToOwner 只投递到该 owner 的在线设备', async () => {
  const hub = await makeHub();
  let wsA, wsB;
  try {
    const ta = hub.devices.issueDeviceToken('owner_a', 'da').token;
    const tb = hub.devices.issueDeviceToken('owner_b', 'db').token;
    wsA = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${ta}` });
    wsB = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${tb}` });
    const gotB = nextMessage(wsB).catch(e => e.message);
    const n = hub.routes.sendToOwner('owner_a', { type: 'mission.command', op: 'plan', missionId: 'm1' });
    assert.equal(n, 1, '只有 owner_a 的 1 台设备收到');
    const msg = await nextMessage(wsA);
    assert.equal(msg.type, 'mission.command');
    assert.equal(msg.missionId, 'm1');
    assert.equal(await gotB, 'WS_MESSAGE_TIMEOUT', 'owner_b 什么也收不到');
  } finally { wsA?.close(); wsB?.close(); hub.server.close(); hub.wss?.close?.(); }
});

test('心跳：服务端按 heartbeatMs 周期发 ws ping', async () => {
  const hub = await makeHub({ heartbeatMs: 40 });
  try {
    const { token } = hub.devices.issueDeviceToken('owner_a', 'd');
    const ws = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${token}` });
    const pings = [];
    ws.on('ping', () => pings.push(1));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(pings.length >= 2, `200ms 内（heartbeatMs=40）应收到 ≥2 个 ping，实际 ${pings.length}`);
    ws.close();
  } finally { hub.server.close(); hub.wss?.close?.(); }
});

test('消息大小上限：超过 maxPayloadBytes 的帧被服务端关闭（1009）', async () => {
  const hub = await makeHub({ maxPayloadBytes: 2048 });
  try {
    const { token } = hub.devices.issueDeviceToken('owner_a', 'd');
    const ws = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${token}` });
    const closed = new Promise(resolve => ws.once('close', (code) => resolve(code)));
    ws.send('x'.repeat(8192));
    const code = await closed;
    assert.equal(code, 1009);
  } finally { hub.server.close(); hub.wss?.close?.(); }
});

test('上行事件：桥发 {type:"bridge.event"} 进 onBridgeMessage，携带 ownerId/deviceId', async () => {
  const received = [];
  const hub = await makeHub({ onBridgeMessage: m => received.push(m) });
  try {
    const { deviceId, token } = hub.devices.issueDeviceToken('owner_a', 'd');
    const ws = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${token}` });
    ws.send(JSON.stringify({ type: 'bridge.event', kind: 'progress', missionId: 'm1' }));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(received.length, 1);
    assert.equal(received[0].ownerId, 'owner_a');
    assert.equal(received[0].deviceId, deviceId);
    assert.equal(received[0].message.kind, 'progress');
    ws.close();
  } finally { hub.server.close(); hub.wss?.close?.(); }
});

test('吊销联动：HTTP 撤销设备后，该设备令牌再 upgrade 即 401', async () => {
  const hub = await makeHub();
  try {
    const { deviceId, token } = hub.devices.issueDeviceToken('owner_a', 'd');
    const ws = await wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${token}` });
    ws.close();
    const rev = await postJson(hub.base, '/api/bridge/devices/revoke', { deviceId }, { 'x-test-owner': 'owner_a' });
    assert.equal(rev.status, 200);
    await assert.rejects(() => wsOpen(`${hub.wsBase}/api/bridge`, { authorization: `Bearer ${token}` }), /HTTP_401|401/);
  } finally { hub.server.close(); hub.wss?.close?.(); }
});

test('owner 越权防护：A 不能撤销 B 的设备，B 设备仍有效', async () => {
  const hub = await makeHub();
  try {
    const { deviceId, token } = hub.devices.issueDeviceToken('owner_b', 'd');
    const rev = await postJson(hub.base, '/api/bridge/devices/revoke', { deviceId }, { 'x-test-owner': 'owner_a' });
    assert.ok(rev.status === 403 || rev.status === 404, '跨 owner 撤销必须被拒（403/404），实际 ' + rev.status);
    assert.ok(hub.devices.resolveToken(token), 'B 的设备不受 A 的越权请求影响');
  } finally { hub.server.close(); hub.wss?.close?.(); }
});
