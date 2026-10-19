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
  assert.deepEqual(files.sort(), ['manifest.json', 'package.json', 'scripts', 'web']);
  const html = await readFile(join(release.directory, 'web/index.html'), 'utf8');
  assert.match(html, /探戈/);
  assert.match(html, /Done&amp;Go/);
  const manifest = JSON.parse(await readFile(join(release.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.product, 'tango-donego');
  assert.equal(manifest.entry, 'web/index.html');
  assert.equal(manifest.scope, 'local-user-test');
  assert.equal(manifest.releaseDate, '2026.10.19');
  const expected = ['web/index.html', 'web/privacy.js', 'web/agreements.js', 'web/speech-capture.js', 'web/assistant-core.js', 'web/assistant-ui.js', 'web/assistant.css', 'scripts/serve-tango.mjs', 'scripts/tango-speech.mjs', 'scripts/tango-speech.ps1', 'scripts/ai-assistant.mjs', 'scripts/ai-discovery.mjs', 'scripts/assistant-config.mjs'];
  assert.deepEqual(Object.keys(manifest.files).sort(), expected.slice().sort());
  for (const path of expected) {
    const bytes = await readFile(join(release.directory, path));
    assert.equal(manifest.files[path], createHash('sha256').update(bytes).digest('hex'), path);
  }
  const pkg = JSON.parse(await readFile(join(release.directory, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node scripts/serve-tango.mjs');
  assert.equal(pkg.dependencies, undefined);
  // Import the packaged entry itself so missing transitive modules fail here.
  const packaged = await import(pathToFileURL(join(release.directory, 'scripts/serve-tango.mjs')).href);
  const server = packaged.createTangoServer();
  assert.equal(server.listening, false);
  assert.deepEqual((await readdir(join(release.directory, 'web'))).sort(), expected.filter(path => path.startsWith('web/')).map(path => path.slice(4)).sort());
  assert.deepEqual((await readdir(join(release.directory, 'scripts'))).sort(), expected.filter(path => path.startsWith('scripts/')).map(path => path.slice(8)).sort());
  const next = await buildRelease({ outputParent: output });
  assert.notEqual(next.directory, release.directory);
  assert.equal(await readFile(join(release.directory, 'web/index.html'), 'utf8'), html);
});
