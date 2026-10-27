// S2D-W13 · M26 回滚回读规格测试（scripts/agentic/integration/release.mjs）。
// 依据：brief §5.8「发布候选 build 的 manifest 包含所有已批准的 web/server 文件
// ……上一候选的回滚读取和服务行为可复核」、§6 门禁 6（校验 manifest SHA……
// server 可启动、/api/status 与 agentic health 可读；不部署）。
//
// verifyReleaseCandidate(directory) 契约：
//   重读候选目录的 manifest.json，逐文件复算 SHA-256，并回答
//   { ok, checked, mismatches[], hasServerEntry, agenticAssets } 。
//   - 上一候选（更早的 donego-* 目录）在任何时候回读都必须 ok:true
//     （回滚读取可复核）；
//   - 篡改任一文件必须令 ok:false 且 mismatches 指名该文件（校验器真的在咬）；
//   - 缺 web/agentic/** 的候选不算合格候选（agenticAssets 计数）。
//
// TDD：release.mjs 未实现 → 本文件 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises'; // rm: M24 补强用例（清单在而文件缺）
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRelease } from '../../../../scripts/build-web.mjs';
import { verifyReleaseCandidate } from '../../../../scripts/agentic/integration/release.mjs';
import { tempDir } from './_helpers.mjs';

test('a fresh candidate verifies clean and reports the agentic asset seam', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const report = await verifyReleaseCandidate(release.directory);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.ok(report.checked >= 1);
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.hasServerEntry, true, 'candidate must keep scripts/serve-tango.mjs + package.json start');
    const agentic = report.agenticAssets.filter(path => path.startsWith('web/agentic/'));
    assert.ok(agentic.includes('web/agentic/sync.js'), `agentic assets must include the W1 sync client: ${JSON.stringify(report.agenticAssets)}`);
  } finally {
    await output.cleanup();
  }
});

test('the previous candidate still verifies after a newer one is built (rollback read-back)', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const previous = await buildRelease({ outputParent: output.path });
    await buildRelease({ outputParent: output.path }); // a newer candidate lands
    const report = await verifyReleaseCandidate(previous.directory);
    assert.equal(report.ok, true, `rollback target must stay verifiable: ${JSON.stringify(report.mismatches)}`);
    // service behavior stays reviewable from the rolled-back candidate
    const packaged = await import(pathToFileURL(join(previous.directory, 'scripts/serve-tango.mjs')).href);
    const server = packaged.createTangoServer();
    assert.equal(server.listening, false);
    server.close();
    const manifest = JSON.parse(await readFile(join(previous.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.entry, 'web/index.html');
  } finally {
    await output.cleanup();
  }
});

test('tampering with a candidate file flips verification to failure naming the file', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const target = join(release.directory, 'web/index.html');
    const original = await readFile(target, 'utf8');
    await writeFile(target, original.replace('</html>', '<!-- tampered --></html>'));
    const report = await verifyReleaseCandidate(release.directory);
    assert.equal(report.ok, false);
    assert.ok(report.mismatches.includes('web/index.html'), `mismatches must name the tampered file: ${JSON.stringify(report.mismatches)}`);
  } finally {
    await output.cleanup();
  }
});

test('a candidate without the agentic seam is flagged, not silently accepted', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    // Simulate a pre-W13 candidate by checking a manifest-stripped view.
    const manifestPath = join(release.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const stripped = {};
    for (const [path, sha] of Object.entries(manifest.files)) if (!path.startsWith('web/agentic/')) stripped[path] = sha;
    manifest.files = stripped;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const report = await verifyReleaseCandidate(release.directory);
    assert.equal(report.ok, true, 'files present still verify');
    assert.deepEqual(report.agenticAssets, [], 'a candidate without web/agentic/** must report zero agentic assets');
  } finally {
    await output.cleanup();
  }
});

// ---------------------------------------------------------------------------
// M24-coverage 补强：verifyReleaseCandidate 防御分支（清单在而文件缺、
// server entry 缺席、package.json 缺席/指向他处）。全部为新增断言，
// 不改上方任一既有断言（RED→GREEN 不删测试不放宽校验）。
// ---------------------------------------------------------------------------

test('a manifest entry whose file is missing on disk is a named mismatch, not a crash', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const manifest = JSON.parse(await readFile(join(release.directory, 'manifest.json'), 'utf8'));
    await rm(join(release.directory, 'web/agentic/sync.js'));
    const report = await verifyReleaseCandidate(release.directory);
    assert.equal(report.ok, false);
    assert.equal(report.checked, Object.keys(manifest.files).length, 'every manifest entry is still checked');
    assert.ok(report.mismatches.includes('web/agentic/sync.js'), `absent file must be named: ${JSON.stringify(report.mismatches)}`);
    assert.ok(report.agenticAssets.includes('web/agentic/sync.js'), 'agentic projection reads the manifest, not the disk');
  } finally {
    await output.cleanup();
  }
});

test('hasServerEntry is false when the manifest strips the server entry (files intact)', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    const manifestPath = join(release.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.files['scripts/serve-tango.mjs'];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const report = await verifyReleaseCandidate(release.directory);
    assert.equal(report.ok, true, 'remaining files still verify');
    assert.equal(report.hasServerEntry, false, 'no server entry in manifest → not service-reviewable');
  } finally {
    await output.cleanup();
  }
});

test('hasServerEntry is false when the packaged package.json is absent or points elsewhere', async () => {
  const output = await tempDir('w13-release-rollback-');
  try {
    const release = await buildRelease({ outputParent: output.path });
    await rm(join(release.directory, 'package.json'));
    const missing = await verifyReleaseCandidate(release.directory);
    assert.equal(missing.ok, true, 'package.json is not a manifest entry; files still verify');
    assert.equal(missing.hasServerEntry, false, 'absent package.json → no start script to review');

    const again = await buildRelease({ outputParent: output.path });
    const packagePath = join(again.directory, 'package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    pkg.scripts.start = 'node legacy-server.mjs';
    await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    const redirected = await verifyReleaseCandidate(again.directory);
    assert.equal(redirected.ok, true);
    assert.equal(redirected.hasServerEntry, false, 'start pointing elsewhere → candidate is not the reviewed server');
  } finally {
    await output.cleanup();
  }
});
