import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['web/index.html', 'web/collaboration-ui.js', 'web/collaboration-personal.js', 'web/collaboration-copy.js', 'web/collaboration.css', 'scripts/collaboration-store.mjs', 'scripts/collaboration-service.mjs', 'server/auth/demo.mjs', 'server/auth/service.mjs', 'server/auth/config.mjs', 'server/auth/email.mjs', 'scripts/production-readiness.mjs', 'server/urlguard.mjs', 'web/privacy.js', 'web/agreements.js', 'web/speech-capture.js', 'web/assistant-core.js', 'web/assistant-ui.js', 'web/assistant.css', 'scripts/serve-tango.mjs', 'scripts/tango-speech.mjs', 'scripts/tango-speech.ps1', 'scripts/ai-assistant.mjs', 'scripts/ai-discovery.mjs', 'scripts/assistant-config.mjs'];

export async function buildRelease({ outputParent = join(root, 'dist-web') } = {}) {
  async function brandFiles(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? brandFiles(directory + '/' + entry.name) : entry.isFile() && entry.name.endsWith('.png') ? [directory + '/' + entry.name] : []));
    return nested.flat().sort();
  }
  const assets = ['web/app-auth.js', 'web/app-auth.css', 'web/users-admin.js', 'web/users-admin.css', 'web/paper.css', 'web/appearance.css', 'web/appearance.js', 'web/locale-copy.js', ...await brandFiles('web/brand')];
  const sources = await Promise.all([...files, ...assets].map(async path => [path, await readFile(join(root, path))]));
  const html = sources[0][1].toString('utf8');
  if (!html.includes('Done&amp;Go') || !html.includes('tango-time-core')) throw new Error('Done&Go entry is missing');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=|application\/json/.test(match[1])) new vm.Script(match[2], { filename: 'web/index.html' });
  }
  for (const [path, source] of sources.filter(([path]) => path.startsWith('web/') && path.endsWith('.js'))) new vm.Script(source.toString('utf8'), { filename: path });
  await mkdir(outputParent, { recursive: true });
  const directory = await mkdtemp(join(outputParent, 'donego-2026.10.19-'));
  const manifest = { schema: 1, product: 'tango-donego', releaseDate: '2026.10.19', releaseId: html.match(/PRODUCT_VERSION\s*=\s*['"]([^'"]+)/)?.[1] || 'donego-web-2026.10.19', createdAt: new Date().toISOString(), scope: 'local-user-test', entry: 'web/index.html', files: {} };
  for (const [path, source] of sources) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), source, { flag: 'wx' });
    manifest.files[path] = createHash('sha256').update(source).digest('hex');
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'tango-donego', version: '0.1.0-local', private: true, type: 'module', engines: { node: '>=22.22' }, scripts: { start: 'node scripts/serve-tango.mjs', 'verify:production': 'node scripts/production-readiness.mjs' }, dependencies: { nodemailer: '10.0.9' } }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { directory, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = await buildRelease();
  process.stdout.write('Done&Go release: ' + release.directory + '\nSHA-256 manifest: ' + join(release.directory, 'manifest.json') + '\n');
}
