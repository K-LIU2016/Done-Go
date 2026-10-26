// W11 tts · 模型下载器先行单测（RED 契约）。
// 依据：DAG 组1b(1)：中文离线模型下载到 asr-lab/models/tts/<模型名>/，models.md 记
// 来源 URL 与 SHA256；download-model.mjs 校验和不过即删。mock fetch，不真实下载。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { downloadModel } from '../../../../../scripts/agentic/tts/download-model.mjs';

const URL_SRC = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/fake-zh-vits.tar.bz2';
const tmp = () => mkdtempSync(join(tmpdir(), 'w11-dl-'));
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

test('a good checksum writes the model file and records its sha256', async () => {
  const bytes = Buffer.from('model-bytes-假');
  const dir = tmp();
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) });
  const out = await downloadModel({ url: URL_SRC, sha256: sha256(bytes), dir, name: 'vits-zh', fetch });
  assert.equal(out.file, join(dir, 'vits-zh'));
  assert.equal(out.sha256, sha256(bytes));
  assert.ok(existsSync(out.file));
  rmSync(dir, { recursive: true, force: true });
});

test('a bad checksum deletes the file and throws CHECKSUM_MISMATCH', async () => {
  const dir = tmp();
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered').buffer.slice(0) });
  await assert.rejects(
    () => downloadModel({ url: URL_SRC, sha256: '0'.repeat(64), dir, name: 'vits-zh', fetch }),
    err => err.code === 'CHECKSUM_MISMATCH',
  );
  assert.equal(readdirSync(dir).length, 0, '校验失败的半成品必须删掉');
  rmSync(dir, { recursive: true, force: true });
});

test('downloads above maxBytes are refused and cleaned up (DOWNLOAD_TOO_LARGE)', async () => {
  const bytes = Buffer.alloc(4096);
  const dir = tmp();
  const fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) });
  await assert.rejects(
    () => downloadModel({ url: URL_SRC, sha256: sha256(bytes), dir, name: 'big', fetch, maxBytes: 1024 }),
    err => err.code === 'DOWNLOAD_TOO_LARGE',
  );
  assert.equal(readdirSync(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a non-ok response is a typed http error, nothing is written', async () => {
  const dir = tmp();
  const fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(
    () => downloadModel({ url: URL_SRC, sha256: '0'.repeat(64), dir, name: 'x', fetch }),
    err => /http-?404/i.test(err.code ?? err.message),
  );
  assert.equal(readdirSync(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});
