// S2D-W13 · M19 发布清单规格测试（scripts/build-web.mjs files/assets 数组扩展）。
// 依据：brief §3「把 W5 UI、W1 sync、W11 reel 等加入发布候选」、W1 终报 TA2
// 落地项（build-web.mjs:11 files 数组补 'web/agentic/sync.js'）、plan.md M19。
//
// 本文件只 import 既有 scripts/build-web.mjs（W0 已存在），因此当前树即可执行：
// W0 基线的 manifest 不含任何 web/agentic/** → 断言失败（RED）。M19 落地 +
// W1/W5/W11 合入后转 GREEN；TA2（tango-release 该项失败豁免）随之关闭。
//
// 注意：tests/unit/tango-release.test.mjs 钉死了旧文件的精确清单，M19 必须同步
// 更新该清单（允许域「必要 tango-release 测试」）；本文件钉的是 agentic 侧增量。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRelease } from '../../../../scripts/build-web.mjs';
import { tempDir } from './_helpers.mjs';

test('release manifest packages the W1 sync client (TA2 close-out)', async () => {
  const output = await tempDir('w13-release-manifest-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const manifest = release.manifest;
    assert.ok('web/agentic/sync.js' in manifest.files, 'W1 sync client must ship in the candidate');
    const bytes = await readFile(join(release.directory, 'web/agentic/sync.js'));
    assert.equal(manifest.files['web/agentic/sync.js'], createHash('sha256').update(bytes).digest('hex'));
  } finally {
    await output.cleanup();
  }
});

test('release manifest packages the W5 agentic UI seam assets', async () => {
  const output = await tempDir('w13-release-manifest-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const agenticFiles = Object.keys(release.manifest.files).filter(path => path.startsWith('web/agentic/'));
    assert.ok(agenticFiles.length >= 5, `expected the W5 UI asset set under web/agentic/, got: ${agenticFiles.join(', ')}`);
    assert.ok(agenticFiles.some(path => path.endsWith('.css')), 'agentic UI css must ship');
  } finally {
    await output.cleanup();
  }
});

test('release manifest packages the W11 reel player seam', async () => {
  const output = await tempDir('w13-release-manifest-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    assert.ok('web/agentic/reel/player.js' in release.manifest.files, 'W11 reel player must ship in the candidate');
  } finally {
    await output.cleanup();
  }
});

test('every manifest entry matches the packaged bytes (SHA-256) — no lying manifests', async () => {
  const output = await tempDir('w13-release-manifest-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    for (const [path, expectedSha] of Object.entries(release.manifest.files)) {
      const bytes = await readFile(join(release.directory, path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha, path);
    }
  } finally {
    await output.cleanup();
  }
});

test('candidate excludes historical bundles, user data, secrets and node_modules', async () => {
  const output = await tempDir('w13-release-manifest-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const paths = Object.keys(release.manifest.files);
    for (const forbidden of [/^dist-web/, /\.data\//, /^node_modules\//, /^\.env/, /\.env$/, /cookie/i, /^\.s2d\//]) {
      const hit = paths.find(path => forbidden.test(path));
      assert.equal(hit, undefined, `candidate must not package ${forbidden}`);
    }
    async function walk(directory, prefix = '') {
      const entries = await readdir(directory, { withFileTypes: true });
      const all = [];
      for (const entry of entries) all.push(...(entry.isDirectory() ? await walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
      return all;
    }
    const onDisk = await walk(release.directory);
    assert.deepEqual(onDisk.sort(), [...paths, 'manifest.json', 'package.json'].sort(), 'no stray unmanifested files');
  } finally {
    await output.cleanup();
  }
});

test('the packaged server entry stays importable with its factory (candidate is service-reviewable)', async () => {
  const output = await tempDir('w13-release-manifest-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const packaged = await import(pathToFileURL(join(release.directory, 'scripts/serve-tango.mjs')).href);
    assert.equal(typeof packaged.createTangoServer, 'function');
    const server = packaged.createTangoServer();
    assert.equal(server.listening, false);
    server.close();
  } finally {
    await output.cleanup();
  }
});
