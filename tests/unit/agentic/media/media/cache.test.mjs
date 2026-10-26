// W11 media-gen · 按 Mission 版本的媒体缓存先行单测（RED 契约）。
// 依据：BUILD-PLAN §3 W11.1 + DAG 组1(2)：cache key = missionId+version+model+prompt
// 归一化哈希；新版本不命中旧缓存；缓存条目记来源与元数据。
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMediaCache, normalizePrompt } from '../../../../../scripts/agentic/media/cache.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'w11-cache-'));

test('normalizePrompt collapses whitespace so equivalent prompts share one cache entry', () => {
  assert.equal(normalizePrompt('  老师 在\n教室   用平板备课 '), '老师 在 教室 用平板备课');
  assert.equal(normalizePrompt('老师在教室用平板备课'), normalizePrompt('  老师\n在教室 用平板备课  '));
});

test('cache key is a sha256 hex of missionId+version+model+normalized prompt', () => {
  const c = createMediaCache({ dir: dir() });
  const key = c.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: '教室场景' });
  assert.match(key, /^[0-9a-f]{64}$/);
  // 归一化等价 → 同键
  assert.equal(key, c.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: ' 教室\n场景 ' }));
});

test('changing any key component produces a different cache key', () => {
  const c = createMediaCache({ dir: dir() });
  const base = c.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: '教室场景' });
  assert.notEqual(base, c.key({ missionId: 'm2', version: 4, model: 'z-image-turbo', prompt: '教室场景' }));
  assert.notEqual(base, c.key({ missionId: 'm1', version: 5, model: 'z-image-turbo', prompt: '教室场景' }), '新版本不命中旧缓存');
  assert.notEqual(base, c.key({ missionId: 'm1', version: 4, model: 'qwen-image-2.0', prompt: '教室场景' }));
  assert.notEqual(base, c.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: '课堂场景' }));
});

test('put then get round-trips bytes and records source metadata', () => {
  const c = createMediaCache({ dir: dir() });
  const key = c.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: '教室场景' });
  const bytes = Buffer.from('fake-png');
  const { file } = c.put(key, bytes, { source: 'url', model: 'z-image-turbo', prompt: '教室场景', missionId: 'm1', version: 4 });
  const hit = c.get(key);
  assert.ok(hit, '写入后必须命中');
  assert.equal(hit.file, file);
  assert.equal(Buffer.compare(Buffer.from(hit.bytes), bytes), 0);
  assert.equal(hit.meta.source, 'url');
  assert.equal(hit.meta.model, 'z-image-turbo');
  assert.equal(hit.meta.version, 4);
  assert.ok(hit.meta.createdAt, '元数据记录写入时间');
});

test('get on a miss returns null', () => {
  const c = createMediaCache({ dir: dir() });
  assert.equal(c.get(c.key({ missionId: 'zzz', version: 9, model: 'm', prompt: 'p' })), null);
});

test('cache state survives a fresh instance on the same directory (cross-process safety)', () => {
  const d = dir();
  const a = createMediaCache({ dir: d });
  const key = a.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: '教室场景' });
  a.put(key, Buffer.from('png'), { source: 'b64', model: 'z-image-turbo', prompt: '教室场景', missionId: 'm1', version: 4 });
  const b = createMediaCache({ dir: d });
  const hit = b.get(key);
  assert.ok(hit, '新实例（= 另一进程）必须读到已落盘的缓存');
  assert.equal(hit.meta.source, 'b64');
  assert.equal(readdirSync(d).length > 0, true);
});

test('cache directories are isolated from each other', async () => {
  const d1 = dir(), d2 = dir();
  const a = createMediaCache({ dir: d1 });
  const key = a.key({ missionId: 'm1', version: 4, model: 'z-image-turbo', prompt: '教室场景' });
  a.put(key, Buffer.from('png'), { source: 'url', model: 'z-image-turbo', prompt: '教室场景', missionId: 'm1', version: 4 });
  assert.equal(createMediaCache({ dir: d2 }).get(key), null);
  rmSync(d1, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
});
