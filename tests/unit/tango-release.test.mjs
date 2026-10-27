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
  
  expected.push('scripts/production-readiness.mjs');
  expected.push('scripts/version-switch.mjs');
  expected.push('scripts/voice-pipeline/asr.mjs', 'scripts/voice-pipeline/asr-worker.mjs', 'scripts/voice-pipeline/clean.mjs', 'scripts/voice-pipeline/gateway.mjs', 'scripts/voice-pipeline/llm.mjs', 'scripts/voice-pipeline/time.mjs', 'scripts/voice-pipeline/timeline.mjs', 'scripts/intent.mjs', 'web/voice/contracts.js', 'web/voice/capture.js', 'web/voice/pcm-worklet.js', 'web/voice/v3-panel.js', 'web/voice/v3-panel.css');
  expected.push('web/collaboration-ui.js', 'web/collaboration-personal.js', 'web/collaboration-copy.js', 'web/collaboration.css', 'scripts/collaboration-store.mjs', 'scripts/collaboration-service.mjs', 'server/auth/service.mjs', 'server/auth/config.mjs', 'server/auth/email.mjs', 'server/urlguard.mjs');
  expected.push('web/model-catalog-cn.js', 'web/ai-parse.js', 'web/ai-prompt.js');
  // W13 M19: web/agentic/**（W1 sync.js〔TA2 由豁免转必须过〕+ W5 UI 全量 + W11 reel）进入发布候选。
  expected.push('web/agentic/sync.js', 'web/agentic/agentic.css', 'web/agentic/component.html', 'web/agentic/demo.html');
  expected.push('web/agentic/assets/bookshelf-done.jpg', 'web/agentic/assets/illus-lesson.jpg', 'web/agentic/assets/photo-craft.jpg', 'web/agentic/assets/photo-whiteboard.jpg', 'web/agentic/assets/scene-classroom-poster.jpg', 'web/agentic/assets/scene-classroom.mp4', 'web/agentic/assets/slide-qwen.jpg');
  expected.push('web/agentic/reel/README.md', 'web/agentic/reel/player.js', 'web/agentic/reel/reel.css');
  expected.push('web/agentic/ui/acceptance.js', 'web/agentic/ui/activity-feed.js', 'web/agentic/ui/app.js', 'web/agentic/ui/block-card.js', 'web/agentic/ui/board.js', 'web/agentic/ui/boundaries.js', 'web/agentic/ui/capture-card.js', 'web/agentic/ui/discuss.js', 'web/agentic/ui/drawer.js', 'web/agentic/ui/fixtures.js', 'web/agentic/ui/gallery.js', 'web/agentic/ui/inbox.js', 'web/agentic/ui/reel-player.js', 'web/agentic/ui/scene-card.js', 'web/agentic/ui/storyboard.js', 'web/agentic/ui/tiers.js', 'web/agentic/ui/trace-view.js', 'web/agentic/ui/utils.js');
  expected.push('web/agentic/ui/shape/registry.js', 'web/agentic/ui/shape/rich-shapes.js', 'web/agentic/ui/shape/text-shapes.js');
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
  assert.deepEqual((await readdir(join(release.directory, 'scripts'))).sort(), [...new Set(expected.filter(path => path.startsWith('scripts/')).map(path => path.slice(8).split('/')[0]))].sort()); // 子目录（voice-pipeline/）按顶层名比较
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
