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
  assert.deepEqual(files.sort(), ['manifest.json', 'node_modules', 'package.json', 'scripts', 'server', 'web']);
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
  // relay v2（集成线）：boot.js 是 index.html 的运行时入口，其余 web/relay/*
  // 经它 dynamic import / fetch（scenes.zh.json 为场景库数据），metrics.mjs 由
  // serve-tango.mjs import——发布缺任何一个，打包后的 serve-tango 或前端即断。
  expected.push('web/relay/boot.js', 'web/relay/shell.js', 'web/relay/home.js', 'web/relay/flow.js', 'web/relay/passport.js', 'web/relay/discover.js', 'web/relay/matcher.js', 'web/relay/store.js', 'web/relay/i18n.js', 'web/relay/contracts.js', 'web/relay/baton.js', 'web/relay/external-apps.js', 'web/relay/scenes.zh.json', 'web/relay/relay.css', 'web/relay/slots.js', 'web/story/contracts.js', 'web/story/definitions.js', 'web/story/demo-data.js', 'web/story/narrative.js', 'web/story/player.js', 'web/story/soundtrack.js', 'web/story/store.js', 'web/story/shelf.js', 'web/story/poster.js', 'web/story/story.css', 'web/story/pages/cover.js', 'web/story/pages/count.js', 'web/story/pages/spectrum.js', 'web/story/pages/day.js', 'web/story/pages/learned.js', 'web/story/pages/freed.js', 'web/story/pages/rhythm.js', 'web/story/pages/four.js', 'web/story/pages/wish.js', 'web/story/pages/poster-page.js', 'web/social/contracts.js', 'web/social/home.js', 'web/social/social.css', 'web/social/features-client.js', 'web/voice/contracts.js', 'scripts/metrics.mjs', 'scripts/voice-gateway.mjs', 'scripts/intent.mjs', 'scripts/social-service.mjs', 'scripts/social-store.mjs', 'scripts/social-features.mjs');
  assert.deepEqual(Object.keys(manifest.files).sort(), expected.slice().sort());
  for (const path of expected) {
    const bytes = await readFile(join(release.directory, path));
    assert.equal(manifest.files[path], createHash('sha256').update(bytes).digest('hex'), path);
  }
  const pkg = JSON.parse(await readFile(join(release.directory, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node scripts/serve-tango.mjs');
  assert.equal(pkg.dependencies.nodemailer, '10.0.9');
  assert.equal(pkg.dependencies.ws, '8.22.0');
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
