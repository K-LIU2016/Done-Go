// W11 media-gen · 生图客户端先行单测（RED 契约）。
// 依据：BUILD-PLAN §3 W11.1（POST /v1/images/generations；纯画面 z-image-turbo、
// 图中文字 qwen-image-2.0；url/b64 皆支持+落本地缓存；按 Mission 版本缓存；每日配额；
// 安全：allowlist/大小上限/key 只经 scripts/agentic/gateway-key.mjs，BUILD-PLAN §2.3 红线2）；PRD §2.4（turbo 中文
// 错字 → 纯画面）、§10.3 字段约束（prompt 必须声明"不要出现任何文字"）。
// 风格：注入 fetch、Bearer 头、类型化错误（照 scripts/voice-pipeline/llm.mjs:51-99）。
// 全程 mock fetch，绝不真实外呼。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PURE_IMAGE_MODEL,
  TEXT_IMAGE_MODEL,
  chooseImageModel,
  buildImagePrompt,
  createImageClient,
} from '../../../../../scripts/agentic/media/image-client.mjs';
import { createMediaCache } from '../../../../../scripts/agentic/media/cache.mjs';
import { createDailyQuota } from '../../../../../scripts/agentic/media/quota.mjs';

const BASE = 'https://gw.example.com';
const KEY = 'test-key-000';
const PNG = Buffer.from('89504e470d0a1a0a-fake-png-bytes', 'utf8');

function resJson(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function makeClient({ fetch, ...rest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w11-img-'));
  const cache = createMediaCache({ dir });
  const quota = createDailyQuota({ file: join(dir, 'quota.json'), now: () => new Date('2026-10-26T10:00:00+08:00') });
  const client = createImageClient({ baseUrl: BASE, key: KEY, fetch, cache, quota, ...rest });
  return { client, cache, quota, dir };
}

test('chooseImageModel maps textInImage to the two PRD §2.4 models', () => {
  assert.equal(chooseImageModel({ textInImage: false }), PURE_IMAGE_MODEL);
  assert.equal(PURE_IMAGE_MODEL, 'z-image-turbo');
  assert.equal(chooseImageModel({ textInImage: true }), TEXT_IMAGE_MODEL);
  assert.equal(TEXT_IMAGE_MODEL, 'qwen-image-2.0');
  // 缺省即纯画面（默认路径是"文字由代码排版"）
  assert.equal(chooseImageModel({}), PURE_IMAGE_MODEL);
});

test('buildImagePrompt forces the no-text declaration for pure-visual prompts (PRD §10.3)', () => {
  const pure = buildImagePrompt({ prompt: '老师在教室用平板备课，清新鼠尾草绿，扁平插画', textInImage: false });
  assert.ok(pure.includes('不要出现任何文字'), '纯画面 prompt 必须声明"不要出现任何文字"');
  assert.ok(pure.includes('老师在教室用平板备课'), '原始画面描述必须保留');

  const withText = buildImagePrompt({ prompt: '标题为"AI 进课堂"的幻灯片版式', textInImage: true });
  assert.equal(withText, '标题为"AI 进课堂"的幻灯片版式', '图中文字模式不加无文字声明');
});

test('generateImage POSTs /v1/images/generations with Bearer key and chosen model', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return resJson({ data: [{ b64_json: PNG.toString('base64') }] });
  };
  const { client, dir } = makeClient({ fetch });
  const out = await client.generateImage({ missionId: 'm1', version: 4, prompt: '教室场景，扁平插画', textInImage: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE + '/v1/images/generations');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + KEY);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'z-image-turbo');
  assert.ok(body.prompt.includes('不要出现任何文字'));
  assert.equal(out.model, 'z-image-turbo');
  assert.equal(out.source, 'b64');
  assert.equal(out.bytes, PNG.length);
  assert.equal(out.cached, false);
  assert.ok(typeof out.file === 'string' && out.file.length > 0, 'b64 响应也要落本地缓存文件');
  rmSync(dir, { recursive: true, force: true });
});

test('generateImage supports url responses and downloads from allowlisted gateway host', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    if (url === BASE + '/v1/images/generations') return resJson({ data: [{ url: 'https://gw.example.com/files/img1.png' }] });
    // 精确切片：PNG.buffer 是 8KiB 共享池，slice(0) 会带出 8192 字节而非 PNG 本体
    return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
  };
  const { client, dir } = makeClient({ fetch });
  const out = await client.generateImage({ missionId: 'm1', version: 4, prompt: '教室场景', textInImage: false });

  assert.deepEqual(calls, [BASE + '/v1/images/generations', 'https://gw.example.com/files/img1.png']);
  assert.equal(out.source, 'url');
  assert.equal(out.bytes, PNG.length);
  rmSync(dir, { recursive: true, force: true });
});

test('cache hit serves the same Mission version without any network call and without spending quota', async () => {
  let posts = 0;
  const fetch = async url => {
    if (url === BASE + '/v1/images/generations') { posts += 1; return resJson({ data: [{ b64_json: PNG.toString('base64') }] }); }
    throw new Error('unexpected download');
  };
  const { client, quota, dir } = makeClient({ fetch });
  const req = { missionId: 'm1', version: 4, prompt: '教室场景', textInImage: false };
  const first = await client.generateImage(req);
  const second = await client.generateImage(req);

  assert.equal(posts, 1, '同一 Mission 版本+模型+prompt 只允许一次真实生成');
  assert.equal(second.cached, true);
  assert.equal(second.file, first.file);
  assert.equal(quota.used(), 1, '缓存命中不消耗每日配额');
  rmSync(dir, { recursive: true, force: true });
});

test('a new Mission version must not hit the previous version cache', async () => {
  let posts = 0;
  const fetch = async () => { posts += 1; return resJson({ data: [{ b64_json: PNG.toString('base64') }] }); };
  const { client, dir } = makeClient({ fetch });
  await client.generateImage({ missionId: 'm1', version: 4, prompt: '教室场景', textInImage: false });
  await client.generateImage({ missionId: 'm1', version: 5, prompt: '教室场景', textInImage: false });

  assert.equal(posts, 2, '版本号参与缓存键，新版本必须重新生成');
  rmSync(dir, { recursive: true, force: true });
});

test('daily quota over-limit throws a typed QUOTA_EXCEEDED before any HTTP call', async () => {
  // 修正（实现期发现 mock bug）：原 mock 对任何调用都抛错，但首笔必须成功生成并记账
  // （否则配额永远到不了上限）。改为首次 POST 成功、之后一律拒绝——超额路径仍零外呼。
  let posts = 0;
  const fetch = async (url, init) => {
    posts += 1;
    if (posts > 1) throw new Error('must not be called');
    return resJson({ data: [{ b64_json: PNG.toString('base64') }] });
  };
  const { client, dir } = makeClient({ fetch });
  const file = join(dir, 'q1.json');
  const limited = createDailyQuota({ file, limit: 1, now: () => new Date('2026-10-26T10:00:00+08:00') });
  const c1 = createImageClient({ baseUrl: BASE, key: KEY, fetch, cache: createMediaCache({ dir: join(dir, 'c1') }), quota: limited });
  await c1.generateImage({ missionId: 'm1', version: 1, prompt: 'p1', textInImage: false });
  await assert.rejects(
    () => c1.generateImage({ missionId: 'm1', version: 2, prompt: 'p2', textInImage: false }),
    err => err.code === 'QUOTA_EXCEEDED' && /1/.test(err.message),
  );
  assert.equal(posts, 1, '超额那次没有发生任何 HTTP 调用');
  rmSync(dir, { recursive: true, force: true });
});

test('remote image URL outside the allowlist is refused before download', async () => {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    if (url === BASE + '/v1/images/generations') return resJson({ data: [{ url: 'https://evil.example.net/x.png' }] });
    throw new Error('download must not happen');
  };
  const { client, dir } = makeClient({ fetch, allowDomains: ['gw.example.com'] });
  await assert.rejects(
    () => client.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false }),
    err => err.code === 'DISALLOWED_HOST',
  );
  assert.equal(calls.length, 1, '只发生了一次 POST，未下载外域文件');
  rmSync(dir, { recursive: true, force: true });
});

test('image download above maxImageBytes is refused with a typed error and never cached', async () => {
  const big = Buffer.alloc(64);
  const fetch = async url => {
    if (url === BASE + '/v1/images/generations') return resJson({ data: [{ url: 'https://gw.example.com/files/big.png' }] });
    return { ok: true, status: 200, arrayBuffer: async () => big.buffer.slice(0) };
  };
  const { client, dir } = makeClient({ fetch, maxImageBytes: 16 });
  await assert.rejects(
    () => client.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false }),
    err => err.code === 'DOWNLOAD_TOO_LARGE',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('non-ok gateway responses surface as typed http errors that never leak the key', async () => {
  const fetch = async () => resJson({ error: 'boom' }, 500);
  const { client, dir } = makeClient({ fetch });
  await assert.rejects(
    () => client.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false }),
    err => /http-?500/i.test(err.code ?? err.message) && !String(err.message).includes(KEY),
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a malformed gateway image url is rejected with BAD_IMAGE_URL before download', async () => {
  const fetch = async url => {
    if (url === BASE + '/v1/images/generations') return resJson({ data: [{ url: '::not-a-url::' }] });
    throw new Error('download must not happen');
  };
  const { client, dir } = makeClient({ fetch });
  await assert.rejects(
    () => client.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false }),
    err => err.code === 'BAD_IMAGE_URL',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a response carrying neither url nor b64_json is a typed bad-shape error', async () => {
  const fetch = async () => resJson({ data: [{}] });
  const { client, dir } = makeClient({ fetch });
  await assert.rejects(
    () => client.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false }),
    err => /bad-shape|empty/i.test(err.code ?? err.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test('the gateway key comes from gateway-key.mjs (endpoint.json) when not injected; env is not a channel, and its absence is typed', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push(init.headers.authorization); return resJson({ data: [{ b64_json: PNG.toString('base64') }] }); };
  const dir = mkdtempSync(join(tmpdir(), 'w11-key-'));
  const home = mkdtempSync(join(tmpdir(), 'w11-key-home-'));
  const configDir = join(home, '.config', 'llm-gateway');
  mkdirSync(configDir, { recursive: true });
  const endpoint = join(configDir, 'endpoint.json');
  writeFileSync(endpoint, JSON.stringify({ keys: { donego: 'endpoint-key-42' } }));
  const savedHome = process.env.HOME;
  const savedEnvKey = process.env.DONEGO_GATEWAY_KEY;
  process.env.HOME = home;
  process.env.DONEGO_GATEWAY_KEY = 'env-must-be-ignored'; // 红线2：env 不再是密钥通道
  const quotaNow = () => new Date('2026-10-26T10:00:00+08:00');
  try {
    const keyClient = createImageClient({
      baseUrl: BASE, fetch, cache: createMediaCache({ dir: join(dir, 'a') }),
      quota: createDailyQuota({ file: join(dir, 'qa.json'), now: quotaNow }),
    });
    await keyClient.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false });
    assert.equal(calls[0], 'Bearer endpoint-key-42', 'Bearer 用 endpoint.json 的 keys.donego，而非 env');

    rmSync(endpoint, { force: true });
    const noKey = createImageClient({
      baseUrl: BASE, fetch, cache: createMediaCache({ dir: join(dir, 'b') }),
      quota: createDailyQuota({ file: join(dir, 'qb.json'), now: quotaNow }),
    });
    await assert.rejects(
      () => noKey.generateImage({ missionId: 'm1', version: 1, prompt: 'p', textInImage: false }),
      err => err.code === 'GATEWAY_KEY_MISSING' && !String(err.message).includes('endpoint-key'),
    );
    assert.equal(calls.length, 1, '缺 key 时不发请求');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedEnvKey === undefined) delete process.env.DONEGO_GATEWAY_KEY; else process.env.DONEGO_GATEWAY_KEY = savedEnvKey;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
