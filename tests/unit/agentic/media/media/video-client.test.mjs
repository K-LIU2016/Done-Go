// W11 media-gen · 生视频客户端先行单测（RED 契约）。
// 依据：DAG 组1(4)：POST /v1/videos → 轮询 GET /v1/videos/{id}（可注入时钟+退避）
// → 就绪后拉 /content 落盘；超时、失败、取消三路径显式测试。PRD §5.2（场景片异步、
// 默认 ≤3 段/天）。全程 mock fetch/sleep，绝不真实外呼。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createVideoClient } from '../../../../../scripts/agentic/media/video-client.mjs';
import { createDailyQuota } from '../../../../../scripts/agentic/media/quota.mjs';

const BASE = 'https://gw.example.com';
const KEY = 'test-key-000';
const MP4 = Buffer.from('ftypisom-fake-mp4-bytes', 'utf8');

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; }, elapsed: () => t };
}

function harness({ statuses = ['succeeded'], content = MP4, poll = null } = {}) {
  const clock = fakeClock();
  const calls = [];
  let i = 0;
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url === BASE + '/v1/videos') return { ok: true, status: 200, json: async () => ({ id: 'vid_1' }) };
    if (url === BASE + '/v1/videos/vid_1') {
      const body = poll ? poll(i, calls) : { status: statuses[Math.min(i, statuses.length - 1)] };
      i += 1;
      return { ok: true, status: 200, json: async () => body };
    }
    if (url === BASE + '/v1/videos/vid_1/content') return { ok: true, status: 200, arrayBuffer: async () => content.buffer.slice(0) };
    throw new Error('unexpected url ' + url);
  };
  return { clock, fetch, calls };
}

function makeClient({ fetch, clock, ...rest }) {
  return createVideoClient({ baseUrl: BASE, key: KEY, fetch, now: clock.now, sleep: clock.sleep, pollIntervalMs: 1000, ...rest });
}

test('generateVideo POSTs the job, polls with backoff until ready, then pulls /content bytes', async () => {
  const { fetch, clock, calls } = harness({ statuses: ['queued', 'running', 'succeeded'] });
  const client = makeClient({ fetch, clock, timeoutMs: 60_000 });
  const out = await client.generateVideo({ model: 'happyhorse-1.1-t2v', prompt: '课堂现场氛围，温暖光线' });

  assert.equal(out.videoId, 'vid_1');
  assert.equal(out.model, 'happyhorse-1.1-t2v');
  assert.equal(Buffer.compare(Buffer.from(out.bytes), MP4), 0, '拉回的 /content 字节必须原样交付');

  const post = calls[0];
  assert.equal(post.url, BASE + '/v1/videos');
  assert.equal(post.method, 'POST');
  assert.ok(calls.some(c => c.url === BASE + '/v1/videos/vid_1'), '必须轮询任务状态');
  assert.ok(calls.some(c => c.url === BASE + '/v1/videos/vid_1/content'), '就绪后必须拉取 /content');
});

test('polling waits between requests with non-decreasing backoff (injectable sleep)', async () => {
  const { fetch, clock } = harness({ statuses: ['queued', 'running', 'running', 'succeeded'] });
  const delays = [];
  const wrapped = { now: clock.now, sleep: async ms => { delays.push(ms); await clock.sleep(ms); } };
  const client = makeClient({ fetch, clock: wrapped, timeoutMs: 60_000 });
  await client.generateVideo({ model: 'happyhorse-1.1-t2v', prompt: 'p' });

  assert.equal(delays.length, 3, '4 次轮询之间 sleep 3 次，绝不忙轮询');
  assert.ok(delays.every(d => d >= 1000), '每次等待至少一个轮询间隔');
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] >= delays[i - 1], '退避不递减');
});

test('a failed job rejects with VIDEO_FAILED carrying the upstream error', async () => {
  const { fetch, clock } = harness({ poll: () => ({ status: 'failed', error: 'content policy violation' }) });
  const client = makeClient({ fetch, clock, timeoutMs: 60_000 });
  await assert.rejects(
    () => client.generateVideo({ model: 'happyhorse-1.1-t2v', prompt: 'p' }),
    err => err.code === 'VIDEO_FAILED' && /content policy/.test(err.message),
  );
});

test('exceeding timeoutMs rejects with VIDEO_TIMEOUT (injectable clock)', async () => {
  const { fetch, clock } = harness({ poll: () => ({ status: 'running' }) });
  const client = makeClient({ fetch, clock, timeoutMs: 5000 });
  await assert.rejects(
    () => client.generateVideo({ model: 'happyhorse-1.1-t2v', prompt: 'p' }),
    err => err.code === 'VIDEO_TIMEOUT',
  );
});

test('aborting the signal rejects with VIDEO_CANCELLED', async () => {
  const controller = new AbortController();
  const { fetch, clock } = harness({
    poll: (i) => { if (i === 1) controller.abort(); return { status: 'queued' }; },
  });
  const client = makeClient({ fetch, clock, timeoutMs: 120_000 });
  await assert.rejects(
    () => client.generateVideo({ model: 'happyhorse-1.1-t2v', prompt: 'p', signal: controller.signal }),
    err => err.code === 'VIDEO_CANCELLED',
  );
});

test('video downloads above maxVideoBytes reject with DOWNLOAD_TOO_LARGE', async () => {
  const big = Buffer.alloc(1024);
  const { fetch, clock } = harness({ statuses: ['succeeded'], content: big });
  const client = makeClient({ fetch, clock, timeoutMs: 60_000, maxVideoBytes: 256 });
  await assert.rejects(
    () => client.generateVideo({ model: 'happyhorse-1.1-t2v', prompt: 'p' }),
    err => err.code === 'DOWNLOAD_TOO_LARGE',
  );
});

test('an optional daily video quota is spent once per accepted job, not on POST failure', async () => {
  const d = mkdtempSync(join(tmpdir(), 'w11-vq-'));
  const quota = createDailyQuota({ file: join(d, 'q.json'), limit: 1, now: () => new Date('2026-10-26T10:00:00+08:00') });

  let failFirst = true;
  const clock = fakeClock();
  const fetch = async url => {
    if (url === BASE + '/v1/videos') {
      if (failFirst) { failFirst = false; return { ok: false, status: 502, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ id: 'vid_2' }) };
    }
    if (url === BASE + '/v1/videos/vid_2') return { ok: true, status: 200, json: async () => ({ status: 'succeeded' }) };
    if (url === BASE + '/v1/videos/vid_2/content') return { ok: true, status: 200, arrayBuffer: async () => MP4.buffer.slice(0) };
    throw new Error('unexpected ' + url);
  };
  const client = createVideoClient({ baseUrl: BASE, key: KEY, fetch, now: clock.now, sleep: clock.sleep, pollIntervalMs: 100, timeoutMs: 60_000, quota });

  await assert.rejects(() => client.generateVideo({ model: 'm', prompt: 'p' }), err => /http-?502/i.test(err.code ?? err.message));
  assert.equal(quota.used(), 0, 'POST 被拒不记账');

  const out = await client.generateVideo({ model: 'm', prompt: 'p' });
  assert.equal(out.videoId, 'vid_2');
  assert.equal(quota.used(), 1, '成功受理一次记一次');

  await assert.rejects(
    () => client.generateVideo({ model: 'm', prompt: 'p2' }),
    err => err.code === 'QUOTA_EXCEEDED',
    '超每日场景片配额直接拒绝',
  );
  rmSync(d, { recursive: true, force: true });
});

test('video requests carry the Bearer key from DONEGO_GATEWAY_KEY when not injected', async () => {
  const { fetch, clock } = harness({ statuses: ['succeeded'] });
  const d = mkdtempSync(join(tmpdir(), 'w11-vk-'));
  process.env.DONEGO_GATEWAY_KEY = 'env-key-7';
  let auth = null;
  const spying = async (url, init) => { if (url === BASE + '/v1/videos') auth = init.headers.authorization; return fetch(url, init); };
  try {
    const client = createVideoClient({ baseUrl: BASE, fetch: spying, now: clock.now, sleep: clock.sleep, pollIntervalMs: 100, timeoutMs: 60_000 });
    await client.generateVideo({ model: 'm', prompt: 'p' });
    assert.equal(auth, 'Bearer env-key-7');
  } finally {
    delete process.env.DONEGO_GATEWAY_KEY;
    rmSync(d, { recursive: true, force: true });
  }
});
