import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// T10示例与lab 线（story-lab）— SPEC §7 lab 独立入口 + D4 润色代理：
//   scripts/story-lab.mjs 静态服务 web/，并提供 POST /api/story/polish —
//   key 只在服务端经 .env 符号链接读取，前端永远拿不到；输入只有统计
//   数字与模板基线；输出逐条 ≤24 字（SPEC §5）；失败回错码由前端落回模板。
// 网关不真连（夜窗纪律）：assistant 全部注入假件；网关解析用临时 fixture。

import {
  parsePolishBody, buildPolishPrompt, parsePolishText,
  createStoryLabServer, POLISH_TEXT_MAX,
  resolveGatewayConfig, GATEWAY_LIGHT_MODEL_DEFAULT,
} from '../../scripts/story-lab.mjs';
import { createAssistant } from '../../scripts/ai-assistant.mjs';

// ---------------------------------------------------------------------------
// 请求体清洗 — parsePolishBody
// ---------------------------------------------------------------------------
test('parsePolishBody：合法批量请求（1–8 条，kind/fallback/context 上限内）', () => {
  const clean = parsePolishBody({
    items: [
      { kind: 'title', fallback: '十月，你把 6 小时还给了自己', context: '省时 360 分钟 · 事件 86 · 接力 23' },
      { kind: 'panel', fallback: '开学第一周，论文还没头绪', context: '第 1 周 14 件事' },
    ],
  });
  assert.deepEqual(clean, {
    items: [
      { kind: 'title', fallback: '十月，你把 6 小时还给了自己', context: '省时 360 分钟 · 事件 86 · 接力 23' },
      { kind: 'panel', fallback: '开学第一周，论文还没头绪', context: '第 1 周 14 件事' },
    ],
  });
  assert.equal(parsePolishBody({ items: [{ kind: 'closing', fallback: 'x' }] }).items[0].context, '');
});

test('parsePolishBody：拒绝一切非法形状（未知键/空 items/超 8 条/坏 kind/超长）', () => {
  assert.equal(parsePolishBody(null), null);
  assert.equal(parsePolishBody({}), null);
  assert.equal(parsePolishBody({ items: [] }), null);
  assert.equal(parsePolishBody({ items: 'x' }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'title', fallback: 'a' }], extra: 1 }), null);
  assert.equal(parsePolishBody({ items: Array.from({ length: 9 }, () => ({ kind: 'title', fallback: 'a' })) }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'poem', fallback: 'a' }] }), null);
  assert.equal(parsePolishBody({ items: [{ fallback: 'a' }] }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'title' }] }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'title', fallback: 'a', context: 7 }] }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'title', fallback: 'a', context: 'c'.repeat(201) }] }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'title', fallback: 'a'.repeat(61) }] }), null);
  assert.equal(parsePolishBody({ items: [{ kind: 'title', fallback: '  \n ' }] }), null);
});

// ---------------------------------------------------------------------------
// 提示词与响应解析 — buildPolishPrompt / parsePolishText
// ---------------------------------------------------------------------------
test('buildPolishPrompt：含全部基线与统计行、写明 N 行与 24 字上限、无任何密钥字段', () => {
  const prompt = buildPolishPrompt([
    { kind: 'title', fallback: '十月，你把 6 小时还给了自己', context: '省时 360 分钟' },
    { kind: 'panel', fallback: '开学第一周', context: '第 1 周 14 件事' },
  ]);
  assert.ok(prompt.includes('十月，你把 6 小时还给了自己'));
  assert.ok(prompt.includes('省时 360 分钟'));
  assert.ok(prompt.includes('24'));
  assert.ok(prompt.includes('2 行'));
  assert.ok(!/key|Bearer|sk-/i.test(prompt));
});

test('parsePolishText：行数一致且每行 ≤24 字 → 通过；防御性剥掉编号前缀', () => {
  const lines = parsePolishText('1. 十月，把时间还给自己\n2. 开学第一周，论文没头绪', 2);
  assert.deepEqual(lines, ['十月，把时间还给自己', '开学第一周，论文没头绪']);
  assert.deepEqual(parsePolishText('标题\n\n旁白', 2), ['标题', '旁白']);
});

test('parsePolishText：行数不符 / 空行剔除后不符 / 超 24 字 / 出现「留白」→ null', () => {
  assert.equal(parsePolishText('只有一行', 2), null);
  assert.equal(parsePolishText('', 1), null);
  assert.equal(parsePolishText('a\nb\nc', 2), null);
  assert.equal(parsePolishText('字'.repeat(25), 1), null); // 25 字 > 24
  assert.deepEqual(parsePolishText('字'.repeat(24), 1), ['字'.repeat(24)]); // 24 字恰好合法
  assert.equal(parsePolishText('给时间一点留白', 1), null); // JC 红线词
  assert.equal(parsePolishText('   \n  ', 1), null);
});

// ---------------------------------------------------------------------------
// 服务器 — 注入假 assistant 的端到端 HTTP（127.0.0.1:0）
// ---------------------------------------------------------------------------
function fakeAssistant(behavior) {
  const calls = [];
  return {
    calls,
    configuration: () => ({ available: true, provider: 'openai', model: 'demo-light', destination: 'https://gw.invalid/v1' }),
    async chat(input, signal) {
      calls.push(input);
      return behavior(input, signal);
    },
  };
}

function post(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function get(port, path) {
  return new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end();
  });
}

async function withServer(assistant, fn) {
  const server = createStoryLabServer({ assistant });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/story/polish：把基线交给 light 档（mode test），返回逐行文本', async () => {
  const assistant = fakeAssistant(() => ({ content: [{ type: 'text', text: '十月，把时间还给自己\n开学第一周，论文没头绪' }] }));
  await withServer(assistant, async (port) => {
    const res = await post(port, '/api/story/polish', JSON.stringify({
      items: [
        { kind: 'title', fallback: '十月，你把 6 小时还给了自己', context: '省时 360 分钟 · 事件 86 · 接力 23' },
        { kind: 'panel', fallback: '开学第一周，论文还没头绪', context: '第 1 周 14 件事' },
      ],
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { texts: ['十月，把时间还给自己', '开学第一周，论文没头绪'] });
    assert.equal(assistant.calls.length, 1);
    const call = assistant.calls[0];
    assert.equal(call.mode, 'test'); // MODE_TIERS: test → light 档快速模型
    assert.ok(call.prompt.includes('开学第一周，论文还没头绪'));
  });
});

test('POST /api/story/polish：上游行数/字数不合格 → 502；网关未配置 → 503；坏请求体 → 400', async () => {
  await withServer(fakeAssistant(() => ({ content: [{ type: 'text', text: '只有一行' }] })), async (port) => {
    const bad = await post(port, '/api/story/polish', JSON.stringify({ items: [{ kind: 'title', fallback: 'x' }, { kind: 'panel', fallback: 'y' }] }));
    assert.equal(bad.status, 502);
  });
  const notConfigured = Object.assign(new Error('TANGO_AI_NOT_CONFIGURED'), { code: 'TANGO_AI_NOT_CONFIGURED' });
  await withServer(fakeAssistant(() => { throw notConfigured; }), async (port) => {
    const res = await post(port, '/api/story/polish', JSON.stringify({ items: [{ kind: 'title', fallback: 'x' }] }));
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.body).error, 'tango-ai-not-configured');
  });
  await withServer(fakeAssistant(() => ({ content: [{ type: 'text', text: '一句' }] })), async (port) => {
    assert.equal((await post(port, '/api/story/polish', 'not json')).status, 400);
    assert.equal((await post(port, '/api/story/polish', JSON.stringify({ items: [] }))).status, 400);
    assert.equal((await post(port, '/api/story/polish', JSON.stringify({ items: [{ kind: 'title', fallback: 'x' }] }))).status, 200);
  });
});

test('GET /api/story/polish：只报 configured 布尔，响应里绝无 key/Bearer 字样', async () => {
  await withServer(fakeAssistant(), async (port) => {
    const res = await get(port, '/api/story/polish');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(Object.keys(payload).sort(), ['configured']);
    assert.equal(payload.configured, true);
    assert.ok(!/key|bearer|sk-/i.test(res.body));
  });
  await withServer(null, async (port) => {
    const res = await get(port, '/api/story/polish');
    assert.equal(JSON.parse(res.body).configured, false);
  });
});

test('静态服务：/story/lab.html 200 且为 html；路径穿越与未知文件 403/404', async () => {
  await withServer(fakeAssistant(), async (port) => {
    const page = await get(port, '/story/lab.html');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('时光故事书'));
    assert.match(page.body, /<!doctype html>/i);
    const traversal = await get(port, '/../package.json');
    assert.ok(traversal.status === 403 || traversal.status === 404);
    const missing = await get(port, '/story/nope.js');
    assert.equal(missing.status, 404);
    const contract = await get(port, '/story/contracts.js');
    assert.equal(contract.status, 200);
  });
});

test('createAssistant（light 配置装配）：假 env 造出的 assistant 不在 configuration() 里暴露 key', () => {
  const assistant = createAssistant({
    env: {},
    config: { provider: 'openai', url: 'https://gw.invalid/v1', model: 'demo-light', key: 'sk-secret-never-show' },
  });
  const info = assistant.configuration();
  assert.equal(info.available, true);
  assert.equal(JSON.stringify(info).includes('sk-secret-never-show'), false);
});

// ---------------------------------------------------------------------------
// 网关解析 — resolveGatewayConfig（临时 fixture；绝不触碰真实 .env）
// ---------------------------------------------------------------------------
test('resolveGatewayConfig：显式 TANGO_AI_* 全量 env 优先（原样透传）', async () => {
  const config = await resolveGatewayConfig({
    env: { TANGO_AI_PROVIDER: 'anthropic', TANGO_AI_URL: 'https://gw.invalid/v1/messages', TANGO_AI_MODEL: 'm1', TANGO_AI_KEY: 'k1' },
    endpointPath: '/nonexistent.json',
  });
  assert.deepEqual(config, { provider: 'anthropic', url: 'https://gw.invalid/v1/messages', model: 'm1', key: 'k1' });
});

test('resolveGatewayConfig：本机网关 fixture — openai_base_url 补 /chat/completions，light 模型可覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-lab-gw-'));
  const endpointPath = join(dir, 'endpoint.json');
  await writeFile(endpointPath, JSON.stringify({ openai_base_url: 'http://127.0.0.1:4000/v1/' }), 'utf8');
  const base = await resolveGatewayConfig({ env: { TANGO_AI_KEY: 'k1' }, endpointPath });
  assert.deepEqual(base, {
    provider: 'openai',
    url: 'http://127.0.0.1:4000/v1/chat/completions',
    model: GATEWAY_LIGHT_MODEL_DEFAULT,
    key: 'k1',
  });
  const overridden = await resolveGatewayConfig({ env: { TANGO_AI_KEY: 'k1', TANGO_AI_MODEL_LIGHT: 'alicloud-set-2/glm-5.2-fast-preview' }, endpointPath });
  assert.equal(overridden.model, 'alicloud-set-2/glm-5.2-fast-preview');
  // 解析出的配置可直接造 assistant（configuration() 不含 key）
  const assistant = createAssistant({ env: {}, config: base });
  assert.equal(assistant.configuration().available, true);
  assert.equal(JSON.stringify(assistant.configuration()).includes('k1'), false);
});

test('resolveGatewayConfig：没有 key 或没有 endpoint → null（不配置，前端走模板）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'story-lab-gw-'));
  const endpointPath = join(dir, 'endpoint.json');
  await writeFile(endpointPath, JSON.stringify({ openai_base_url: 'http://127.0.0.1:4000/v1' }), 'utf8');
  assert.equal(await resolveGatewayConfig({ env: {}, endpointPath }), null);
  assert.equal(await resolveGatewayConfig({ env: { TANGO_AI_KEY: 'k1' }, endpointPath: '/nonexistent.json' }), null);
  assert.equal(await resolveGatewayConfig({ env: { TANGO_AI_KEY: 'k1' } }), null); // 无 HOME 无法定位 endpoint
});
