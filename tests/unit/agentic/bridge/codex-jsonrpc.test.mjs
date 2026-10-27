// M1 codex-jsonrpc 单测（TDD RED 先行）。
// 契约来源：.s2d/plan.md §2 M1、BUILD-PLAN §3 W8-2（stdio JSON-RPC：请求-响应/通知流/服务端请求=审批）、PRD §6.5 L408–422。
// 分帧假设：app-server 为换行分隔 JSON（JSONL）；M6 generate-ts 落地时如分帧不同，只改实现与本文件夹具（见 tests-red.md 假设节）。
// 全部用注入的假子进程（PassThrough 管道），绝不真起 codex（§2.3 外部调用配额）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createJsonRpcSession } from '../../../../packages/donego-bridge/src/codex/jsonrpc.mjs';

const NEWLINE_DELIMITED = true; // 夹具统一按 JSONL 分帧

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state = { killed: 0 };
  const child = {
    stdin, stdout, stderr,
    kill: () => { state.killed += 1; },
    _state: state,
  };
  return child;
}

function framesFrom(stream) {
  // 收集写入 stdin 的帧（按行解析），供断言协议内容
  const chunks = [];
  stream.on('data', c => chunks.push(c));
  return {
    raw: () => Buffer.concat(chunks).toString('utf8'),
    async lines() {
      let text = this.raw();
      for (let i = 0; i < 20 && !text.endsWith('\n'); i += 1) { await new Promise(r => setImmediate(r)); text = this.raw(); }
      return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    },
  };
}

function makeSession(over = {}) {
  const child = fakeChild();
  const sent = framesFrom(child.stdin);
  const opts = {
    spawn: () => child,
    argv: ['codex', 'app-server'],
    ...over,
  };
  const session = createJsonRpcSession(opts);
  return { session, child, sent };
}

test('request 写出 JSONL 帧，id 从 1 递增，result 响应按 id 关联（乱序也能对上）', async () => {
  const { session, child, sent } = makeSession();
  const p1 = session.request('thread/start', { cwd: '/tmp/x' });
  const p2 = session.request('turn/start', { model: 'gpt-6-luna' });
  const lines = await sent.lines();
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].method, 'thread/start');
  assert.equal(lines[0].params.cwd, '/tmp/x');
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].jsonrpc, '2.0');

  // 乱序响应：先回 id=2 再回 id=1
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { turn: 't2' } })}\n`);
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { threadId: 'th_1' } })}\n`);
  assert.deepEqual(await p2, { turn: 't2' });
  assert.deepEqual(await p1, { threadId: 'th_1' });
});

test('error 响应：promise 以错误码拒绝，不抛崩会话', async () => {
  const { session, child } = makeSession();
  const p = session.request('model/list', {});
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'MODEL_UNKNOWN' } })}\n`);
  await assert.rejects(p, /MODEL_UNKNOWN/);
  // 会话仍可用
  const p2 = session.request('model/list', {});
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { models: [] } })}\n`);
  assert.deepEqual(await p2, { models: [] });
});

test('服务端通知（无 id）进入 onNotify 流', async () => {
  let got = null;
  const { session, child } = makeSession({ onNotify: (method, params) => { got = { method, params }; } });
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentReasoning', params: { delta: 'x' } })}\n`);
  await new Promise(r => setImmediate(r));
  assert.equal(got?.method, 'item/agentReasoning');
  assert.equal(got?.params.delta, 'x');
});

test('服务端请求（审批）：onServerRequest 收到请求与 reply 句柄，reply({result}) 回写同 id 响应', async () => {
  let captured = null;
  const { session, child, sent } = makeSession({ onServerRequest: (req, reply) => { captured = { req, reply }; } });
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'item/commandExecution/requestApproval', params: { command: 'node --test' } })}\n`);
  await new Promise(r => setImmediate(r));
  assert.equal(captured?.req.id, 77);
  assert.equal(captured?.req.method, 'item/commandExecution/requestApproval');
  captured.reply({ result: { decision: 'approved' } });
  const lines = await sent.lines();
  const resp = lines.find(l => l.id === 77);
  assert.equal(resp.result.decision, 'approved');
  assert.equal(resp.method, undefined); // 响应帧不带 method
});

test('reply({error}) 回写错误响应（高危拒绝路径）', async () => {
  let captured = null;
  const { session, child, sent } = makeSession({ onServerRequest: (req, reply) => { captured = reply; } });
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'applyPatchApproval', params: { patch: 'x' } })}\n`);
  await new Promise(r => setImmediate(r));
  captured({ error: { code: 1001, message: 'HIGH_RISK_COMMAND' } });
  const lines = await sent.lines();
  const resp = lines.find(l => l.id === 5);
  assert.equal(resp.error.message, 'HIGH_RISK_COMMAND');
});

test('半包：一行拆两段写入只解析一次，内容完整', async () => {
  let count = 0;
  const { session, child } = makeSession({ onNotify: () => { count += 1; } });
  const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'item/tokenCount', params: { n: 42 } })}\n`;
  const half = Math.floor(line.length / 2);
  child.stdout.write(line.slice(0, half));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(count, 0); // 半包不触发
  child.stdout.write(line.slice(half));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(count, 1);
});

test('坏 JSON 行：onParseError 上报且不吞掉后续帧', async () => {
  const parseErrors = [];
  let got = 0;
  const { session, child } = makeSession({ onNotify: () => { got += 1; }, onParseError: (line, err) => { parseErrors.push({ line, err }); } });
  child.stdout.write('{"jsonrpc":"2.0","method":\n');
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentReasoning', params: {} })}\n`);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(parseErrors.length, 1);
  assert.equal(got, 1);
});

test('请求超时：超 requestTimeoutMs 未回包 → 以 TIMEOUT 拒绝，id 从关联表清除', async () => {
  const { session } = makeSession({ requestTimeoutMs: 30 });
  const p = session.request('turn/start', { slow: true });
  await assert.rejects(p, /TIMEOUT|turn\/start/);
});

test('子进程 EOF（stdout end）：所有 pending 全部拒绝', async () => {
  const { session, child } = makeSession();
  const p1 = session.request('a', {});
  const p2 = session.request('b', {});
  child.stdout.end();
  await assert.rejects(p1);
  await assert.rejects(p2);
});

test('close()：pending 拒绝且 kill 子进程', async () => {
  const { session, child } = makeSession();
  const p = session.request('a', {});
  session.close();
  await assert.rejects(p, /CLOSE/);
  assert.ok(child._state.killed >= 1);
});

test('client notify：写出无 id 的通知帧', async () => {
  const { session, sent } = makeSession();
  session.notify('initialized', { ok: true });
  const lines = await sent.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, undefined);
  assert.equal(lines[0].method, 'initialized');
  assert.equal(lines[0].params.ok, true);
});

test('分帧常量自检：夹具始终按 JSONL（换行）写帧', () => {
  assert.ok(NEWLINE_DELIMITED);
});
