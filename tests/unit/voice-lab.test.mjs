// tests/unit/voice-lab.test.mjs — V8 · Lab 入口：路由/装配冒烟（RED → GREEN）
// 覆盖：服务器可起可关、tango 静态路由 (/voice/lab.html)、/api/voice/lab-status、
//       /api/voice/intent（demo/注入/校验/超时）、WS upgrade（demo 网关全链路走 contracts）、
//       loadVoiceModules 在 V6/V7 缺席时的降级。
// 唯一标准：design/voice-intent/SPEC.md §2.2（网关/协议/限额）、§2.3（intent 输入输出）。
import { test } from 'node:test';
const T = (name, fn) => test(name, { timeout: 15000 }, fn);
import assert from 'node:assert/strict';
import {
  createVoiceLabServer,
  createDemoVoiceGateway,
  createDemoIntentEngine,
  loadVoiceModules,
  VOICE_WS_PATH,
  VOICE_INTENT_PATH,
  VOICE_LAB_STATUS_PATH,
} from '../../scripts/voice-lab.mjs';
import {
  validateIntentOutput,
  validateServerMessage,
} from '../../web/voice/contracts.js';

// 每个测试新建 gateway/intent 实例（voiceLab.close() 会关闭注入的 gateway，不可跨测试共享）
function baseOptions(overrides = {}) {
  return { gateway: createDemoVoiceGateway({ paceMs: 0 }), intentEngine: createDemoIntentEngine({ delayMs: 0 }), ...overrides };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startLab(options = baseOptions()) {
  const server = createVoiceLabServer(options);
  const port = await listen(server);
  return { server, port, url: (path) => `http://127.0.0.1:${port}${path}` };
}

async function postJson(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true });
  });
}

// 队列式消费：常驻 message 监听器（同批多帧时 undici 会在同一 I/O 回调里同步连续 dispatch，
// 逐帧 once+await 的模式会丢第二帧；真实前端也是常驻监听器）。
function wsTap(ws) {
  const queue = []; const waiters = [];
  ws.addEventListener('message', (event) => {
    const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    const waiter = waiters.shift();
    if (waiter) waiter(msg); else queue.push(msg);
  });
  const next = () => new Promise((resolve, reject) => {
    if (queue.length) resolve(queue.shift());
    else {
      const timer = setTimeout(() => reject(new Error('ws message timeout')), 4000);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('ws closed before message')); }, { once: true });
    }
  });
  return { next };
}

function wsClose(ws) {
  return new Promise((resolve) => { ws.addEventListener('close', resolve, { once: true }); ws.close(); });
}

T('装配冒烟：createVoiceLabServer 返回可 listen 的 http server，tango 静态路由 /voice/lab.html 可达', async () => {
  const { server, url } = await startLab();
  assert.equal(typeof server.listen, 'function');
  const res = await fetch(url('/voice/lab.html'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const text = await res.text();
  assert.match(text, /voice/i);
  assert.match(text, /contracts\.js/); // 页面以 contracts 为唯一数据契约
  await server.voiceLab.close();
});

T('lab.html 内联 module 脚本可被引擎解析（b85ba5d ?? 与 || 未加括号混用导致整页死锁的回归钉）', async () => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const html = readFileSync(new URL('../../web/voice/lab.html', import.meta.url), 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'lab.html 应有内联 module 脚本');
  const dir = mkdtempSync(join(tmpdir(), 'vi-lab-inline-'));
  const file = join(dir, 'inline.mjs');
  writeFileSync(file, m[1]);
  try {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `内联脚本语法错误（整页将死锁）:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

T('服务器可起可关：close 后再请求连接被拒，重复 close 安全', async () => {
  const { server, port } = await startLab();
  assert.ok(port > 0);
  await server.voiceLab.close();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/voice/lab-status`));
  await server.voiceLab.close(); // 幂等
});

T('GET /api/voice/lab-status：200 且暴露端点路径与模块模式', async () => {
  const { server, url } = await startLab();
  const res = await fetch(url(VOICE_LAB_STATUS_PATH));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.app, 'voice-lab');
  assert.equal(body.wsPath, VOICE_WS_PATH);
  assert.equal(body.intentPath, VOICE_INTENT_PATH);
  assert.ok(['module', 'demo', 'unavailable'].includes(body.modules.gateway.mode));
  assert.ok(['module', 'demo', 'unavailable'].includes(body.modules.intent.mode));
  await server.voiceLab.close();
});

T('POST /api/voice/intent（demo 引擎）：演示句 → 200，输出过 contracts.validateIntentOutput，日期按 now/tz 相对计算', async () => {
  const { server, url } = await startLab();
  const now = '2026-10-25T10:12:00+08:00'; // 周日
  const res = await postJson(url(VOICE_INTENT_PATH), { transcript: '明天下午三点要跟导师开组会，必须把实验数据先整理好。还有周五前交课程报告，晚上有空的话去跑个步', now, tz: 'Asia/Shanghai' });
  assert.equal(res.status, 200);
  const body = await res.json();
  const checked = validateIntentOutput({ items: body.items, nonEvent: body.nonEvent });
  assert.ok(checked.ok, `intent 输出应过契约校验: ${checked.ok ? '' : checked.field + ' ' + checked.message}`);
  assert.equal(body.items.length, 4); // 原型 ③ 屏：一句话拆 4 件事
  assert.equal(body.items.find((i) => i.title === '跑步').priority, 5);
  const meeting = body.items.find((i) => i.title.includes('组会'));
  assert.equal(meeting.date, '2026-10-26'); // 「明天」相对 now 计算
  assert.equal(meeting.start, '15:00');
  assert.equal(typeof body.meta.engine, 'string');
  assert.ok(body.meta.elapsedMs >= 0);
  await server.voiceLab.close();
});

T('POST /api/voice/intent：非演示句 → 单事项默认优先级 3「一般」且无依据（SPEC §2.3-7）', async () => {
  const { server, url } = await startLab();
  const res = await postJson(url(VOICE_INTENT_PATH), { transcript: '随便记一件事', now: '2026-10-25T10:12:00+08:00', tz: 'Asia/Shanghai' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  assert.equal(item.priority, 3);
  assert.equal(item.priorityReason, null);
  assert.equal(item.vague, true); // 没说时间 → 宁缺勿编
  await server.voiceLab.close();
});

T('POST /api/voice/intent 输入校验：缺 tz / now 无时区 → 400；带合法 edit → 200', async () => {
  const { server, url } = await startLab();
  const bad1 = await postJson(url(VOICE_INTENT_PATH), { transcript: 'x', now: '2026-10-25T10:12:00+08:00' });
  assert.equal(bad1.status, 400);
  assert.equal((await bad1.json()).error, 'intent-input-invalid');
  const bad2 = await postJson(url(VOICE_INTENT_PATH), { transcript: 'x', now: '2026-10-25T10:12:00', tz: 'Asia/Shanghai' });
  assert.equal(bad2.status, 400);
  const editItem = { title: '跑步', kind: 'restore', date: null, start: null, end: null, durationMin: null, deadline: null, timeText: '晚上有空的话', vague: true, recurrence: null, priority: 5, priorityReason: '你说「有空的话」', confidence: 0.9, source: '晚上有空的话去跑个步' };
  const good = await postJson(url(VOICE_INTENT_PATH), { transcript: '把跑步改到八点', now: '2026-10-25T10:12:00+08:00', tz: 'Asia/Shanghai', edit: [editItem] });
  assert.equal(good.status, 200);
  await server.voiceLab.close();
});

T('POST /api/voice/intent 方法/类型守卫：GET → 405；非 JSON content-type → 415；超大体 → 413', async () => {
  const { server, url } = await startLab();
  assert.equal((await fetch(url(VOICE_INTENT_PATH))).status, 405);
  const wrongType = await fetch(url(VOICE_INTENT_PATH), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(wrongType.status, 415);
  const big = await fetch(url(VOICE_INTENT_PATH), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(70 * 1024) }, body: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  await server.voiceLab.close();
});

T('注入 intentEngine stub：响应来自 stub 且 meta.engine 透传 —— V7 intent.mjs 的接线点', async () => {
  const stubOutput = { items: [{ title: '写周报', kind: 'create', date: null, start: null, end: null, durationMin: 30, deadline: null, timeText: null, vague: false, recurrence: null, priority: 2, priorityReason: '你说「尽快」', confidence: 0.8, source: '尽快写周报' }], nonEvent: null };
  const { server, url } = await startLab({ gateway: createDemoVoiceGateway({ paceMs: 0 }), intentEngine: { name: 'stub-v7', parse: async () => stubOutput } });
  const res = await postJson(url(VOICE_INTENT_PATH), { transcript: '尽快写周报', now: '2026-10-25T10:12:00+08:00', tz: 'Asia/Shanghai' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.meta.engine, 'stub-v7');
  assert.deepEqual(body.items, stubOutput.items);
  await server.voiceLab.close();
});

T('intentEngine 输出不合法 → 502 intent-output-invalid；超时 → 504（intentTimeoutMs 注入）', async () => {
  const { server: s1, url: u1 } = await startLab({ gateway: createDemoVoiceGateway({ paceMs: 0 }), intentEngine: { name: 'bad', parse: async () => ({ items: [], nonEvent: null }) } });
  assert.equal((await postJson(u1(VOICE_INTENT_PATH), { transcript: 'x', now: '2026-10-25T10:12:00+08:00', tz: 'Asia/Shanghai' })).status, 502);
  await s1.voiceLab.close();
  const slow = { name: 'slow', parse: () => new Promise((resolve) => setTimeout(() => resolve({ items: [{ title: '迟到', kind: 'create', vague: false, priority: 3, confidence: 1 }], nonEvent: null }), 300)) };
  const { server: s2, url: u2 } = await startLab({ gateway: createDemoVoiceGateway({ paceMs: 0 }), intentEngine: slow, intentTimeoutMs: 60 });
  const res = await postJson(u2(VOICE_INTENT_PATH), { transcript: 'x', now: '2026-10-25T10:12:00+08:00', tz: 'Asia/Shanghai' });
  assert.equal(res.status, 504);
  await s2.voiceLab.close();
});

T('WS /api/voice/stream（demo 网关）：start → partial/final → stop → final(定稿) → end，全部帧过 contracts 校验', async () => {
  const { server, port } = await startLab({ gateway: createDemoVoiceGateway({ paceMs: 40 }), intentEngine: createDemoIntentEngine({ delayMs: 0 }) });
  let ws;
  try {
    ws = await wsOpen(`ws://127.0.0.1:${port}${VOICE_WS_PATH}`);
    const tap = wsTap(ws);
    const seen = [];
    const record = (msg) => { const r = validateServerMessage(msg); assert.ok(r.ok, `服务端帧必须过契约: ${r.field} ${r.message}`); seen.push(msg); };
    ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
    // 收第一条 partial（灰字出现）后手动「说完了」
    for (;;) {
      const msg = await tap.next();
      record(msg);
      if (msg.type === 'partial') break;
    }
    ws.send(JSON.stringify({ type: 'stop' }));
    for (;;) {
      const msg = await tap.next();
      if (msg.type === 'error') assert.fail(`不应报错: ${msg.code}`);
      record(msg);
      if (msg.type === 'end') break;
    }
    // stop 后必须有一条 final 把当前 seg 定稿（SPEC §3 定稿不回退）
    const finals = seen.filter((m) => m.type === 'final');
    assert.ok(finals.length >= 1, 'stop 后应有 final 定稿');
    assert.ok(finals.every((m) => m.text.length > 0));
    await wsClose(ws);
  } finally {
    try { ws?.close(); } catch { /* 已关 */ }
    await server.voiceLab.close();
  }
});

T('WS demo 网关：坏消息 → error bad-message；未知路径 upgrade 被拒', async () => {
  const { server, port } = await startLab({ gateway: createDemoVoiceGateway({ paceMs: 500 }) }); // 慢节奏：首帧后 pump 不会抢发第二帧
  let ws;
  try {
    ws = await wsOpen(`ws://127.0.0.1:${port}${VOICE_WS_PATH}`);
    const tap = wsTap(ws);
    ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
    const first = await tap.next();
    assert.equal(first.type, 'partial');
    ws.send('{"type":"哈哈"}');
    const err = await tap.next();
    assert.equal(err.type, 'error');
    assert.equal(err.code, 'bad-message');
    await wsClose(ws);
  } finally {
    try { ws?.close(); } catch { /* 已关 */ }
    await assert.rejects(wsOpen(`ws://127.0.0.1:${port}/api/voice/other`), /ws open failed/);
    await server.voiceLab.close();
  }
});

T('loadVoiceModules：V6/V7 缺席时自动降级（mode 枚举），gateway 与 intent 均可用', async () => {
  const modules = await loadVoiceModules();
  assert.ok(['module', 'demo', 'unavailable'].includes(modules.gateway.mode));
  assert.ok(['module', 'demo', 'unavailable'].includes(modules.intent.mode));
  // intent 引擎必须始终可用（demo 兜底），gateway 在 ws 包可用时也可用
  assert.equal(typeof modules.intent.engine.parse, 'function');
  if (modules.gateway.mode !== 'unavailable') assert.equal(typeof modules.gateway.gateway.handleUpgrade, 'function');
});
