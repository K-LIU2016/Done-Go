// M7 bridge-client · CLI（pair/start/status）与 config 单测（TDD RED 先行）。
// 契约来源：PRD §6.5 L400、§10.1 A15（CLI donego-bridge pair <code>）、BUILD-PLAN §3 W8-1
// （pair 落 0600 设备配置、start 出站连接、status 本机不出网、绝不暴露上游 key）、.s2d/plan.md §2 M7。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../../../packages/donego-bridge/src/cli.mjs';
import { saveDeviceConfig, loadDeviceConfig, deviceConfigPath } from '../../../../packages/donego-bridge/src/config.mjs';

// ── config.mjs ──────────────────────────────────────────────
test('saveDeviceConfig：落 <dir>/device.json，权限 0600，load 往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'donego-cli-'));
  try {
    const cfg = { hubUrl: 'https://hub.example', deviceId: 'd1', token: 'tok_x'.repeat(8), pairedAt: 1_000 };
    saveDeviceConfig(dir, cfg);
    const p = deviceConfigPath(dir);
    assert.equal(p, join(dir, 'device.json'));
    assert.ok(existsSync(p));
    assert.equal(statSync(p).mode & 0o777, 0o600, '设备令牌文件必须 0600');
    assert.deepEqual(loadDeviceConfig(dir), cfg);
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['deviceId', 'hubUrl', 'pairedAt', 'token'], '配置只含桥自身字段');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadDeviceConfig：无文件 → null；损坏 → CONFIG_CORRUPT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'donego-cli-'));
  try {
    assert.equal(loadDeviceConfig(dir), null);
    writeFileSync(join(dir, 'device.json'), '{oops');
    assert.throws(() => loadDeviceConfig(dir), /CONFIG_CORRUPT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── cli.mjs ─────────────────────────────────────────────────
class FakeWebSocket extends EventEmitter {
  static created = [];
  constructor(url) { super(); this.url = url; FakeWebSocket.created.push(this); }
  send() {} ping() {} close() { this.emit('close', 1000, ''); } terminate() {}
}

function deps(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'donego-cli-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'donego-state-'));
  const lines = [];
  const calls = [];
  FakeWebSocket.created = [];
  return {
    dir, stateDir, lines,
    deps: {
      configDir: dir,
      stateDir,
      fetchImpl: async (url, opts) => { calls.push({ url, opts }); return over.fetchResult ?? { status: 200, body: { deviceId: 'd1', token: 't'.repeat(48) } }; },
      WebSocket: FakeWebSocket,
      now: () => 1_000,
      heartbeatMs: 60_000,
      io: { print: l => lines.push(l) },
    },
    calls,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); },
  };
}

test('pair <code>：POST 配对端点换取设备令牌并落 0600 配置', async () => {
  const t = deps();
  try {
    const r = await runCli(['pair', 'AB12CD', '--hub-url', 'https://hub.example'], t.deps);
    assert.equal(r.code, 0, t.lines.join('\n'));
    assert.equal(t.calls.length, 1);
    assert.ok(t.calls[0].url.includes('https://hub.example/api/bridge/pair'));
    assert.equal(JSON.parse(t.calls[0].opts.body).code, 'AB12CD');
    const cfg = loadDeviceConfig(t.dir);
    assert.ok(cfg?.token, '配对成功必须落设备令牌');
    assert.equal(statSync(deviceConfigPath(t.dir)).mode & 0o777, 0o600);
  } finally { t.cleanup(); }
});

test('pair 负例：hub 拒绝（400）→ 退出码非 0、不落任何配置', async () => {
  const t = deps({ fetchResult: { status: 400, body: { error: 'PAIRING_CODE_UNKNOWN' } } });
  try {
    const r = await runCli(['pair', '000000'], t.deps);
    assert.notEqual(r.code, 0);
    assert.equal(loadDeviceConfig(t.dir), null, '失败不得写配置');
    assert.ok(t.lines.join('\n').length > 0, '给人看的错误信息');
  } finally { t.cleanup(); }
});

test('start 负例：未配对 → 非零退出并提示先 pair，且不出网', async () => {
  const t = deps();
  try {
    const r = await runCli(['start'], t.deps);
    assert.notEqual(r.code, 0);
    assert.match(t.lines.join('\n'), /pair/, '提示重新配对');
    assert.equal(t.calls.length, 0, '未配对时不得请求 hub');
    assert.equal(FakeWebSocket.created.length, 0, '未配对不得建连');
  } finally { t.cleanup(); }
});

test('start：已配对 → 用存的 token/hubUrl 发起出站 WSS（不读密钥、不监听端口）', async () => {
  const t = deps();
  try {
    saveDeviceConfig(t.dir, { hubUrl: 'https://hub.example', deviceId: 'd1', token: 'tok'.repeat(20), pairedAt: 1 });
    const r = await runCli(['start'], t.deps);
    assert.equal(r.code, 0, t.lines.join('\n'));
    assert.equal(FakeWebSocket.created.length, 1, '恰一条出站连接');
    const url = FakeWebSocket.created[0].url;
    assert.ok(url.startsWith('wss://hub.example/api/bridge'), url);
    assert.ok(url.includes('tok'.repeat(20)), '带设备令牌');
  } finally { t.cleanup(); }
});

test('status：只读本机状态，绝不出网（fetch/WebSocket 都不得被碰）', async () => {
  const t = deps();
  try {
    writeFileSync(join(t.stateDir, 'state.json'), JSON.stringify({ connected: false, missionId: 'm1', worktree: '/wt/m1', lastError: 'ECONNRESET' }));
    const r = await runCli(['status'], t.deps);
    assert.equal(r.code, 0);
    const out = t.lines.join('\n');
    assert.match(out, /m1/);
    assert.match(out, /ECONNRESET/);
    assert.equal(t.calls.length, 0, 'status 不出网');
    assert.equal(FakeWebSocket.created.length, 0);
  } finally { t.cleanup(); }
});

test('参数校验：未知命令/无参数 → usage + 退出码 2；--help 同样给 usage', async () => {
  const t = deps();
  try {
    for (const argv of [[], ['bogus'], ['--help']]) {
      const r = await runCli(argv, t.deps);
      assert.equal(r.code, 2, `${argv.join(' ')} → 2`);
      assert.match(t.lines.join('\n'), /usage|pair|start|status/i);
    }
  } finally { t.cleanup(); }
});
