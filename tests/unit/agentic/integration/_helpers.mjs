// S2D-W13 · 测试先行共享 helper（w13·测试先行 节点产出）。
//
// 本文件只是测试基础设施（W6 先例 `tests/unit/agentic/preview/_helpers.mjs`），
// 不含任何被测实现。被测实现归 M13–M19/M21（scripts/agentic/integration/**、
// build-web/serve-tango 接缝、tests/agentic/integration/harness.mjs）。
//
// 约定（与冻结契约对齐，contracts/agentic/README.md「错误码与 HTTP 建议」）：
//   - 统一错误信封 { error: { code, message, details?, requestId? } }，
//     code 必须是 api-error.schema.json 的枚举值；
//   - 所有响应 JSON: Content-Type application/json; charset=utf-8 + Cache-Control no-store。

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '../../../../');
export const contractDir = join(root, 'contracts/agentic');
export const apiErrorSchema = loadSchema('api-error.schema.json', contractDir);
export const blockSchema = loadSchema('block.schema.json', contractDir);

export function assertValidAgainst(value, schema, label) {
  const result = validate(value, schema, { schemaDir: contractDir });
  assert.equal(result.valid, true, `${label}: ${JSON.stringify(result.errors)}`);
  return value;
}

/** Deterministic clock: fixed start, manual tick. Mirrors W4's CLOCK helper pattern. */
export function makeClock(startIso = '2026-10-28T10:00:00.000Z', stepMs = 1000) {
  let current = Date.parse(startIso);
  if (Number.isNaN(current)) throw new TypeError(`bad clock start: ${startIso}`);
  return {
    now: () => new Date(current).toISOString(),
    tick: (times = 1) => {
      current += stepMs * times;
      return new Date(current).toISOString();
    },
  };
}

/** Fake node HTTP request with a readable JSON/bytes body. */
export function fakeReq({ method = 'POST', url = '/', headers = {}, body = null } = {}) {
  const stream = Readable.from(body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return stream;
}

/**
 * Fake node HTTP response. Captures writeHead/write/end; supports SSE-style
 * incremental frames and client `destroy()` (emits 'close' like a socket cut).
 */
export function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = null;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  const chunks = [];
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    // node 语义：header 名大小写不敏感（内部一律小写）；12 流路由全部
    // 小写 'content-type' 写法，此处按 node 行为归一化，读写两侧解耦。
    res.headers = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    res.headersSent = true;
    return res;
  };
  res.write = chunk => {
    if (!res.headersSent) { res.statusCode = 200; res.headers = {}; res.headersSent = true; }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  res.end = chunk => {
    if (chunk !== undefined) res.write(chunk);
    res.writableEnded = true;
    return res;
  };
  res.destroy = error => {
    res.destroyed = true;
    res.emit('close', error);
    return res;
  };
  res.body = () => Buffer.concat(chunks);
  res.text = () => res.body().toString('utf8');
  res.json = () => JSON.parse(res.text());
  /** SSE frames: every `data: {...}` payload parsed, ignoring comments/keepalives. */
  res.sseFrames = () => res.text().split('\n\n')
    .filter(block => block.startsWith('data:'))
    .map(block => {
      const payload = block.replace(/^data:\s?/mg, '').trim();
      try { return JSON.parse(payload); } catch { return payload; }
    });
  return res;
}

/** Envelope assertions against the FROZEN api-error schema. */
export function assertErrorEnvelope(res, { status, code } = {}) {
  assert.ok(res.headersSent, 'response must have headers');
  // status/code 仅在显式传入时断言（无参调用只校验信封合法性本身）。
  if (status !== undefined) {
    assert.equal(res.statusCode, status, `expected HTTP ${status}, got ${res.statusCode}: ${res.text?.() ?? ''}`);
  }
  assert.match(res.headers['content-type'] || '', /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assertValidAgainst(body, apiErrorSchema, 'error envelope');
  if (code !== undefined) assert.equal(body.error.code, code);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('sk-'), 'envelope must not contain key material');
  assert.ok(!serialized.includes('    at '), 'envelope must not contain stack traces');
  return body;
}

/**
 * Wrap a db so any write statement throws. Projections (M16) must operate
 * through this untouched — the projection seam may not write any flow's tables.
 */
export function writeForbiddenDb(db, label = 'projection') {
  const writeSql = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|ATTACH|DETACH)\b/i;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare' || property === 'exec') {
        return (...args) => {
          const sql = String(args[0] ?? '');
          if (writeSql.test(sql)) throw new Error(`${label}_WRITE_FORBIDDEN: ${sql.slice(0, 80)}`);
          return Reflect.get(target, property, target).apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Fresh temp directory; returns { path, cleanup }. */
export async function tempDir(prefix = 'w13-integration-') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Minimal integration-context stub for dispatcher tests (no M13 dependency). */
export function stubContext(overrides = {}) {
  const events = [];
  return {
    clock: makeClock(),
    auth: async () => null,
    idGen: { next: (prefix = 'id') => `${prefix}-${events.length + 1}-${Math.random().toString(36).slice(2, 8)}` },
    events: { emit: event => events.push(event), recorded: () => events.slice() },
    traceSink: { record: span => events.push({ type: 'trace', span }) },
    policyPort: { check: () => { throw new Error('POLICY_UNAVAILABLE'); } },
    ...overrides,
  };
}
