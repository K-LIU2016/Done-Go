import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFile = promisify(execFileCallback);
const files = ['web/index.html', 'web/collaboration-ui.js', 'web/collaboration-personal.js', 'web/collaboration-copy.js', 'web/collaboration.css', 'scripts/collaboration-store.mjs', 'scripts/collaboration-service.mjs', 'server/auth/demo.mjs', 'server/auth/service.mjs', 'server/auth/config.mjs', 'server/auth/email.mjs', 'scripts/production-readiness.mjs', 'server/urlguard.mjs', 'web/privacy.js', 'web/agreements.js', 'web/speech-capture.js', 'web/assistant-core.js', 'web/assistant-ui.js', 'web/assistant.css', 'scripts/serve-tango.mjs', 'scripts/tango-speech.mjs', 'scripts/tango-speech.ps1', 'scripts/ai-assistant.mjs', 'scripts/ai-discovery.mjs', 'scripts/assistant-config.mjs', 'web/model-catalog-cn.js', 'web/demo-onboarding.js', 'web/ai-parse.js', 'web/ai-prompt.js', 'scripts/metrics.mjs'];

export async function buildRelease({ outputParent = join(root, 'dist-web') } = {}) {
  async function brandFiles(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? brandFiles(directory + '/' + entry.name) : entry.isFile() && entry.name.endsWith('.png') ? [directory + '/' + entry.name] : []));
    return nested.flat().sort();
  }
  // relay v2（集成线）：web/relay/* 全部随 release 发布——boot.js 是 index.html
  // 的运行时入口，其余模块经它 dynamic import（shell/home/flow/passport/discover/
  // matcher/store/i18n/baton/contracts/external-apps），scenes.zh.json 是按需
  // fetch 的场景库数据，relay.css 是外壳样式；scripts/metrics.mjs 由
  // serve-tango.mjs import（/api/metrics 计数端点）。
  const relayAssets = ['web/relay/boot.js', 'web/relay/shell.js', 'web/relay/home.js', 'web/relay/flow.js', 'web/relay/passport.js', 'web/relay/discover.js', 'web/relay/matcher.js', 'web/relay/store.js', 'web/relay/i18n.js', 'web/relay/contracts.js', 'web/relay/baton.js', 'web/relay/external-apps.js', 'web/relay/scenes.zh.json', 'web/relay/relay.css'];
  const assets = ['web/app-auth.js', 'web/app-auth.css', 'web/users-admin.js', 'web/users-admin.css', 'web/paper.css', 'web/appearance.css', 'web/appearance.js', 'web/locale-copy.js', 'web/ai-relay.js', ...relayAssets, ...await brandFiles('web/brand')];
  const sources = await Promise.all([...files, ...assets].map(async path => [path, await readFile(join(root, path))]));
  const html = sources[0][1].toString('utf8');
  if (!html.includes('Done&amp;Go') || !html.includes('tango-time-core')) throw new Error('Done&Go entry is missing');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=|application\/json/.test(match[1])) new vm.Script(match[2], { filename: 'web/index.html' });
  }
  // web/ai-parse.js is an ES module that index.html import()s at runtime; classic
  // vm.Script rejects export statements, so module assets get the same
  // node --check ESM syntax validation the verify:web chain runs instead.
  // web/relay/*.js are the same kind of ES modules (boot.js import()s them).
  const isModuleAsset = path => path === 'web/ai-parse.js' || (path.startsWith('web/relay/') && path.endsWith('.js'));
  for (const [path, source] of sources.filter(([path]) => path.startsWith('web/') && path.endsWith('.js') && !isModuleAsset(path))) new vm.Script(source.toString('utf8'), { filename: path });
  for (const [path] of sources.filter(([path]) => isModuleAsset(path))) await execFile(process.execPath, ['--check', join(root, path)]);
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
