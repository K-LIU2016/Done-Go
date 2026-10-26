// M7 bridge-client · 出站 WSS 客户端单测（TDD RED 先行）。
// 契约来源：PRD §6.5 L400（出站 WSS、配对令牌/设备令牌）、BUILD-PLAN §3 W8-1（心跳、断线重连、
// 令牌吊销→停止并提示重新配对；不开监听端口）、.s2d/plan.md §2 M7-2。
// 注入假 WebSocket（EventEmitter）；WebSocket 构造器为注入参数 → donego-bridge 包保持零依赖（待裁决 3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeClient } from '../../../../packages/donego-bridge/src/client/wss.mjs';

class FakeWebSocket extends EventEmitter {
  static created = [];
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.pings = 0;
    this.closed = false;
    FakeWebSocket.created.push(this);
  }
  send(data) { this.sent.push(data); }
  ping() { this.pings += 1; }
  close() { this.closed = true; this.emit('close', 1000, ''); }
  terminate() { this.closed = true; this.emit('close', 1006, ''); }
  // 测试驱动
  open() { this.emit('open'); }
  deliver(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  drop(code = 1006) { this.emit('close', code, ''); }
}

function makeClient(over = {}) {
  FakeWebSocket.created = [];
  const states = [];
  const messages = [];
  let revoked = 0;
  const client = createBridgeClient({
    url: 'wss://hub.example/api/bridge',
    token: 'dev-token-123',
    WebSocket: FakeWebSocket,
    now: () => Date.now(),
    log: () => {},
    heartbeatMs: 25,
    minBackoffMs: 30,
    maxBackoffMs: 240,
    onMessage: m => messages.push(m),
    onRevoked: () => { revoked += 1; },
    onStateChange: (s, info) => states.push({ s, info }),
    ...over,
  });
  return { client, states, messages, revoked, sockets: () => FakeWebSocket.created };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('connect：出站连接 URL 携带设备令牌，open 后进入 connected', async () => {
  const { client, states, sockets } = makeClient();
  client.connect();
  const ws = sockets()[0];
  assert.ok(ws, 'connect 必须发起出站连接');
  assert.match(ws.url, /api\/bridge/, '连 /api/bridge');
  assert.ok(ws.url.includes('dev-token-123'), '令牌随连接提交（query 或等价机制）');
  ws.open();
  assert.ok(states.some(x => x.s === 'connected'));
  client.stop();
});

test('心跳：open 后按 heartbeatMs 周期 ping（保活）', async () => {
  const { client, sockets } = makeClient({ heartbeatMs: 25 });
  client.connect();
  const ws = sockets()[0];
  ws.open();
  await wait(120);
  assert.ok(ws.pings >= 2, `120ms 内（heartbeatMs=25）应 ≥2 个 ping，实际 ${ws.pings}`);
  client.stop();
});

test('消息分发：服务端 JSON 消息进 onMessage', async () => {
  const { client, messages, sockets } = makeClient();
  client.connect();
  const ws = sockets()[0];
  ws.open();
  ws.deliver({ type: 'mission.command', op: 'plan', missionId: 'm1' });
  await wait(20);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].op, 'plan');
  client.stop();
});

test('断线重连：close(1006) 后指数退避重连，且退避时间翻倍直至上限', async () => {
  const { client, states, sockets } = makeClient({ minBackoffMs: 40, maxBackoffMs: 300 });
  client.connect();
  sockets()[0].open();
  sockets()[0].drop(1006); // 第一条断
  await wait(10);
  const countAfterDrop = sockets().length;
  await wait(80); // 越过第一个退避窗口
  assert.ok(sockets().length > countAfterDrop, '退避窗口后必须重建连接');
  sockets().at(-1).drop(1006); // 第二次断：退避应更长
  const delays = states.filter(x => x.s === 'reconnecting').map(x => x.info?.delayMs).filter(d => typeof d === 'number');
  assert.ok(delays.length >= 2, 'onStateChange 需带 delayMs（写 trace/测试用）');
  assert.ok(delays[1] > delays[0], `退避必须递增（${delays.join(',')}）`);
  client.stop();
});

test('令牌吊销：close(4001) 或收到 device.revoked → 停止一切重连，onRevoked 恰好一次（提示重新配对）', async () => {
  const { client, revoked, sockets } = makeClient({ minBackoffMs: 20 });
  client.connect();
  const ws = sockets()[0];
  ws.open();
  ws.drop(4001); // hub 的吊销关闭码
  await wait(120);
  assert.equal(revoked, 1, 'onRevoked 恰好一次');
  assert.equal(sockets().length, 1, '吊销后绝不再重连');
  client.stop();
});

test('吊销消息路径：收到 {type:"device.revoked"} 同样触发 onRevoked 且不再重连', async () => {
  const { client, revoked, sockets } = makeClient({ minBackoffMs: 20 });
  client.connect();
  const ws = sockets()[0];
  ws.open();
  ws.deliver({ type: 'device.revoked' });
  await wait(80);
  assert.equal(revoked, 1);
  ws.drop(1000);
  await wait(80);
  assert.equal(sockets().length, 1, '吊销后 close 也不触发重连');
  client.stop();
});

test('stop()：主动停止不再重连', async () => {
  const { client, sockets } = makeClient({ minBackoffMs: 20 });
  client.connect();
  sockets()[0].open();
  client.stop();
  sockets()[0].drop(1006);
  await wait(80);
  assert.equal(sockets().length, 1, 'stop 后不重连');
});
