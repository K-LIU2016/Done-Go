import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('a Done&Go release contains the actual web app and verifiable files without historical bundles or user data', async () => {
  const { buildRelease } = await import('../../scripts/build-web.mjs');
  const output = await mkdtemp(join(tmpdir(), 'tango-release-test-'));
  const release = await buildRelease({ outputParent: output });
  const files = await readdir(release.directory);
  assert.deepEqual(files.sort(), ['manifest.json', 'package.json', 'scripts', 'server', 'web']);
  const html = await readFile(join(release.directory, 'web/index.html'), 'utf8');
  assert.match(html, /探戈/);
  assert.match(html, /Done&amp;Go/);
  const manifest = JSON.parse(await readFile(join(release.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.product, 'tango-donego');
  assert.equal(manifest.entry, 'web/index.html');
  assert.equal(manifest.scope, 'local-user-test');
  assert.equal(manifest.releaseDate, '2026.10.19');
  const expected = ['web/index.html', 'web/privacy.js', 'web/agreements.js', 'web/speech-capture.js', 'web/assistant-core.js', 'web/assistant-ui.js', 'web/assistant.css', 'scripts/serve-tango.mjs', 'scripts/tango-speech.mjs', 'scripts/tango-speech.ps1', 'scripts/ai-assistant.mjs', 'scripts/ai-discovery.mjs', 'scripts/assistant-config.mjs'];
  expected.push('web/paper.css', 'web/appearance.css', 'web/appearance.js', 'web/locale-copy.js', 'web/brand/robot-logo.png', 'web/brand/robot-reference.png');
  expected.push('web/app-auth.js','web/app-auth.css');
  expected.push('web/users-admin.js','web/users-admin.css');
  expected.push('server/auth/demo.mjs');
  expected.push('scripts/production-readiness.mjs');
  expected.push('web/collaboration-ui.js', 'web/collaboration-personal.js', 'web/collaboration-copy.js', 'web/collaboration.css', 'scripts/collaboration-store.mjs', 'scripts/collaboration-service.mjs', 'server/auth/service.mjs', 'server/auth/config.mjs', 'server/auth/email.mjs', 'server/urlguard.mjs');
  expected.push('web/model-catalog-cn.js', 'web/demo-onboarding.js', 'web/ai-relay.js', 'web/ai-parse.js', 'web/ai-prompt.js');
  assert.deepEqual(Object.keys(manifest.files).sort(), expected.slice().sort());
  for (const path of expected) {
    const bytes = await readFile(join(release.directory, path));
    assert.equal(manifest.files[path], createHash('sha256').update(bytes).digest('hex'), path);
  }
  const pkg = JSON.parse(await readFile(join(release.directory, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node scripts/serve-tango.mjs');
  assert.equal(pkg.dependencies.nodemailer, '10.0.9');
  // Import the packaged entry itself so missing transitive modules fail here.
  const packaged = await import(pathToFileURL(join(release.directory, 'scripts/serve-tango.mjs')).href);
  const server = packaged.createTangoServer();
  assert.equal(server.listening, false);
  const { createCollaborationService } = await import(pathToFileURL(join(release.directory, 'scripts/collaboration-service.mjs')).href);
  const collaboration = await createCollaborationService({ databaseFile: ':memory:' });
  assert.equal(collaboration.store.list({ id: 'synthetic-user' }).length, 0);
  collaboration.close();
  async function recursiveFiles(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? recursiveFiles(join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name]))).flat().sort();
  }
  assert.deepEqual(await recursiveFiles(join(release.directory, 'web')), expected.filter(path => path.startsWith('web/')).map(path => path.slice(4)).sort());
  assert.deepEqual((await readdir(join(release.directory, 'scripts'))).sort(), expected.filter(path => path.startsWith('scripts/')).map(path => path.slice(8)).sort());
  const next = await buildRelease({ outputParent: output });
  assert.notEqual(next.directory, release.directory);
  assert.equal(await readFile(join(release.directory, 'web/index.html'), 'utf8'), html);
});

test('the release packages every web asset index.html references at runtime', async () => {
  const { buildRelease } = await import('../../scripts/build-web.mjs');
  const output = await mkdtemp(join(tmpdir(), 'tango-release-assets-'));
  const release = await buildRelease({ outputParent: output });
  const manifest = JSON.parse(await readFile(join(release.directory, 'manifest.json'), 'utf8'));
  const html = await readFile(join(release.directory, 'web/index.html'), 'utf8');
  const referenced = new Set();
  for (const match of html.matchAll(/<script[^>]+src="\/([^"]+\.js)"/g)) referenced.add(match[1]);
  for (const match of html.matchAll(/(?:import\('|\.src = ')\/([^']+\.js)'/g)) referenced.add(match[1]);
  assert.ok(referenced.size >= 14, 'expected index.html to reference at least 14 scripts, found ' + referenced.size);
  const missing = [...referenced].filter(name => !manifest.files['web/' + name]);
  assert.deepEqual(missing, []);
});
