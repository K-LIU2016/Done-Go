// W11 tts · 模型安装器先行单测（RED 契约补全）：downloadModel → installTarball → installModels 全链路。
// 用注入 fetch + 本地小 tarball（tar -cjf 打的 3KB 假包），不真实外呼。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { downloadModel, installTarball, installModels } from '../../../../../scripts/agentic/tts/download-model.mjs';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'w11-inst-'));

// 打一个结构同真实模型包的小 tar.bz2：顶层目录 <name>/ 内含 .onnx 与 tokens.txt。
function makeTarball(dir, name, onnxName = 'model.int8.onnx') {
  const staging = join(dir, 'staging');
  mkdirSync(join(staging, name), { recursive: true });
  writeFileSync(join(staging, name, onnxName), 'fake-onnx-bytes');
  writeFileSync(join(staging, name, 'tokens.txt'), 'a 0\n');
  const tarball = join(dir, `${name}.tar.bz2`);
  const r = spawnSync('tar', ['-cjf', tarball, '-C', staging, name], { stdio: 'pipe' });
  assert.equal(r.status, 0, 'fixture tarball 必须打得出来');
  return tarball;
}

test('installTarball extracts a tar.bz2, verifies .onnx inside, returns the top dir', () => {
  const dir = tmp();
  const tarball = makeTarball(dir, 'fake-zh-vits');
  const out = installTarball({ file: tarball, into: dir });
  assert.equal(out, join(dir, 'fake-zh-vits'));
  assert.ok(existsSync(join(out, 'model.int8.onnx')));
  rmSync(dir, { recursive: true, force: true });
});

test('installTarball refuses a package with no .onnx (MODEL_PACKAGE_INVALID, nothing kept)', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'staging', 'empty-model'), { recursive: true });
  writeFileSync(join(dir, 'staging', 'empty-model', 'readme.txt'), 'no model here');
  const tarball = join(dir, 'empty-model.tar.bz2');
  assert.equal(spawnSync('tar', ['-cjf', tarball, '-C', join(dir, 'staging'), 'empty-model'], { stdio: 'pipe' }).status, 0);
  assert.throws(() => installTarball({ file: tarball, into: dir }), err => err.code === 'MODEL_PACKAGE_INVALID');
  assert.ok(!existsSync(join(dir, 'empty-model')), '无效包解出的目录必须清掉');
  rmSync(dir, { recursive: true, force: true });
});

test('installModels downloads, checksums, extracts under the ledger name and drops the tarball', async () => {
  const dir = tmp();
  const name = 'fake-zh-vits';
  const tarball = makeTarball(dir, name);
  const bytes = (await import('node:fs')).readFileSync(tarball);
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const root = join(dir, 'asr-lab', 'models', 'tts');
  const installed = await installModels({
    root,
    models: [{ name, url: 'https://example.invalid/fake-zh-vits.tar.bz2', sha256: sha256(bytes) }],
    fetch: fetchImpl,
  });
  assert.equal(installed[0], join(root, name));
  assert.ok(existsSync(join(root, name, 'model.int8.onnx')));
  assert.ok(!existsSync(join(root, '.downloads', `${name}.tar.bz2`)), '安装完删 tarball');
  // 幂等：已安装时不再下载
  let refetched = 0;
  const counting = async () => { refetched += 1; throw new Error('should not fetch'); };
  const again = await installModels({ root, models: [{ name, url: 'x', sha256: '0'.repeat(64) }], fetch: counting });
  assert.equal(again[0], join(root, name));
  assert.equal(refetched, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('installModels refuses a tarball whose top dir is not the ledger name (MODEL_PACKAGE_INVALID)', async () => {
  const dir = tmp();
  const tarball = makeTarball(dir, 'other-name');
  const bytes = (await import('node:fs')).readFileSync(tarball);
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const root = join(dir, 'tts');
  await assert.rejects(
    () => installModels({ root, models: [{ name: 'ledger-name', url: 'https://example.invalid/x.tar.bz2', sha256: sha256(bytes) }], fetch: fetchImpl }),
    err => err.code === 'MODEL_PACKAGE_INVALID',
  );
  rmSync(dir, { recursive: true, force: true });
});
