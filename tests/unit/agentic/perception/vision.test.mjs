// vision-clients 契约：OpenAI 兼容 chat/completions + image base64 content parts；
// 快 qwen3.5-omni-flash（timeout≈4s）/ 深 qwen3-vl-plus（timeout≈15s）；结构化 JSON 提示词；
// 容错解析仿 voice-pipeline/llm.mjs:100（slice 首尾大括号）；key 可注入 getter（默认 env DONEGO_GATEWAY_KEY），
// 绝不打印/落盘；本地 minicpm-v 留桩。单测全 mock fetch。对应实现：
// scripts/agentic/perception/vision.mjs + prompts.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVisionClient,
  createFastVisionClient,
  createDeepVisionClient,
  createLocalVisionAdapter,
} from '../../../../scripts/agentic/perception/vision.mjs';
import { fastPrompt, deepPrompt } from '../../../../scripts/agentic/perception/prompts.mjs';

const KEY = 'sk-gateway-secret-DO-NOT-LEAK';
const ok = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

function recorder(response) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response() : response; };
  return { calls, fetchImpl };
}

test('analyze posts an OpenAI-compatible chat/completions request with image content parts', async () => {
  const { calls, fetchImpl } = recorder(ok('{"seen":"白板写着 Q4 目标"}'));
  const client = createVisionClient({ baseUrl: 'https://gw.example/v4', model: 'qwen3.5-omni-flash', timeoutMs: 500, getKey: () => KEY, fetchImpl });
  const out = await client.analyze({ imageBase64: 'QUJD', mimeType: 'image/jpeg', system: '你是感知器', prompt: '看到了什么' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gw.example/v4/chat/completions');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'qwen3.5-omni-flash');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, '你是感知器');
  const parts = body.messages[1].content;
  assert.equal(body.messages[1].role, 'user');
  assert.deepEqual(parts.map(p => p.type).sort(), ['image_url', 'text']);
  assert.equal(parts.find(p => p.type === 'text').text, '看到了什么');
  assert.equal(parts.find(p => p.type === 'image_url').image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.equal(out.seen, '白板写着 Q4 目标');
});

test('analyze accepts an images array (video frames → one deep call)', async () => {
  const { calls, fetchImpl } = recorder(ok('{"seen":"连续画面：正在涂胶"}'));
  const client = createVisionClient({ baseUrl: 'https://gw.example/v4', model: 'qwen3-vl-plus', timeoutMs: 500, getKey: () => KEY, fetchImpl });
  await client.analyze({ images: [{ imageBase64: 'QQ', mimeType: 'image/jpeg' }, { imageBase64: 'Qg', mimeType: 'image/jpeg' }, { imageBase64: 'Qw', mimeType: 'image/jpeg' }], prompt: '帧序列' });
  const parts = JSON.parse(calls[0].init.body).messages[0].content;
  assert.equal(parts.filter(p => p.type === 'image_url').length, 3, '三帧全部进 content parts');
  assert.equal(parts.find(p => p.type === 'text').text, '帧序列');
});

test('tolerant JSON parsing: fenced, prefixed and suffixed model output all parse (仿 llm.mjs:100)', async () => {
  const fenced = '```json\n{"seen":"隔板已涂胶","change":"胶水溢出","suggestion":"擦掉余胶","actions":["夹固 15 分钟"]}\n```';
  const noSys = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, getKey: () => KEY, fetchImpl: async () => ok(fenced) });
  assert.deepEqual(await noSys.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }), { seen: '隔板已涂胶', change: '胶水溢出', suggestion: '擦掉余胶', actions: ['夹固 15 分钟'] });
  const chatty = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, getKey: () => KEY, fetchImpl: async () => ok('好的，分析结果：{"seen":"延误屏显示 25 分钟"} 以上仅供参考。') });
  assert.deepEqual(await chatty.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }), { seen: '延误屏显示 25 分钟', change: null, suggestion: null, actions: [] }, '缺失字段补 null/[]');
  const strAction = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, getKey: () => KEY, fetchImpl: async () => ok('{"seen":"s","actions":"记下来"}') });
  assert.deepEqual((await strAction.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' })).actions, ['记下来'], '单个 action 字符串归一为数组');
});

test('errors are opaque codes: http status, empty and bad-json never leak the key', async () => {
  const httpFail = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, getKey: () => KEY, fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  await assert.rejects(httpFail.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }), err => /502/.test(err.message) && !err.message.includes(KEY) && !JSON.stringify(err).includes(KEY));
  const noChoices = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, getKey: () => KEY, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(noChoices.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }), /empty/i);
  const bad = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, getKey: () => KEY, fetchImpl: async () => ok('这不是 JSON') });
  await assert.rejects(bad.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }), /json|parse/i);
});

test('timeout: a hanging upstream rejects within timeoutMs', async () => {
  const client = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 25, getKey: () => KEY, fetchImpl: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(client.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }));
  assert.ok(Date.now() - started < 2000, '不能等到默认超时才失败');
});

test('factories bind the PRD models and budgets: flash≈4s fast lane, vl-plus≈15s deep lane', async () => {
  const fast = createFastVisionClient({ baseUrl: 'https://gw.example/v4', getKey: () => KEY, fetchImpl: async () => ok('{"seen":"即时卡"}') });
  assert.equal(fast.model, 'qwen3.5-omni-flash');
  assert.equal(fast.timeoutMs, 4000);
  const fastOut = await fast.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' });
  assert.equal(fastOut.seen, '即时卡');
  const deep = createDeepVisionClient({ baseUrl: 'https://gw.example/v4', getKey: () => KEY, fetchImpl: async () => ok('{"seen":"深度"}') });
  assert.equal(deep.model, 'qwen3-vl-plus');
  assert.equal(deep.timeoutMs, 15000);
  await deep.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' });
});

test('default key getter reads DONEGO_GATEWAY_KEY at call time, never at construction', async () => {
  const { calls, fetchImpl } = recorder(ok('{"seen":"x"}'));
  const client = createVisionClient({ baseUrl: 'u', model: 'm', timeoutMs: 500, fetchImpl });
  process.env.DONEGO_GATEWAY_KEY = 'env-key-1';
  try {
    await client.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' });
    assert.equal(calls[0].init.headers.authorization, 'Bearer env-key-1');
    process.env.DONEGO_GATEWAY_KEY = 'env-key-2';
    await client.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' });
    assert.equal(calls[1].init.headers.authorization, 'Bearer env-key-2', '运行时读取，环境变了跟着变');
  } finally {
    delete process.env.DONEGO_GATEWAY_KEY;
  }
});

test('local minicpm-v adapter: refuses without a configured endpoint, posts when given one', async () => {
  const stub = createLocalVisionAdapter({});
  await assert.rejects(stub.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' }), /local.*not.*configured|minicpm/i);
  const { calls, fetchImpl } = recorder(ok('{"seen":"本地识别"}'));
  const local = createLocalVisionAdapter({ url: 'http://127.0.0.1:9100/v1', fetchImpl });
  const out = await local.analyze({ imageBase64: 'QQ', mimeType: 'image/jpeg', prompt: 'p' });
  assert.equal(calls[0].url, 'http://127.0.0.1:9100/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].init.body).model, 'minicpm-v');
  assert.equal(out.seen, '本地识别');
});

// ---------- prompts.mjs（CTO 实测结构化 JSON：seen/change/suggestion/actions，BUILD-PLAN L143）----------

test('fastPrompt: 即时卡提示词只索要 seen，并带上块上下文与只输出 JSON 的约束', () => {
  const prompt = fastPrompt({ blockTitle: '做木书架', blockKind: 'craft', nowText: '2026-10-26 19:05（周一）' });
  assert.ok(prompt.includes('做木书架'), '包含当前块标题');
  assert.ok(prompt.includes('craft'), '包含块类型');
  assert.ok(prompt.includes('seen'), '要求 seen 字段');
  assert.ok(prompt.includes('JSON'), '要求结构化 JSON 输出');
  assert.ok(prompt.length > 50);
});

test('deepPrompt: 深感知提示词索要 seen/change/suggestion/actions 四件套', () => {
  const prompt = deepPrompt({ blockTitle: '产品周会', blockKind: 'meeting', planSummary: 'Q4 三项目标评审' });
  for (const key of ['seen', 'change', 'suggestion', 'actions']) assert.ok(prompt.includes(key), `包含 ${key}`);
  assert.ok(prompt.includes('产品周会'));
  assert.ok(prompt.includes('Q4 三项目标评审'), '带计划上下文好对比变化');
  assert.ok(prompt.includes('JSON'));
});
