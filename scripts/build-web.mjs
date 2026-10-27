import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFile = promisify(execFileCallback);
const files = ['web/index.html', 'web/collaboration-ui.js', 'web/collaboration-personal.js', 'web/collaboration-copy.js', 'web/collaboration.css', 'scripts/collaboration-store.mjs', 'scripts/collaboration-service.mjs', 'server/auth/service.mjs', 'server/auth/config.mjs', 'server/auth/email.mjs', 'scripts/production-readiness.mjs', 'server/urlguard.mjs', 'web/privacy.js', 'web/agreements.js', 'web/speech-capture.js', 'web/assistant-core.js', 'web/assistant-ui.js', 'web/assistant.css', 'scripts/serve-tango.mjs', 'scripts/version-switch.mjs', 'scripts/voice-pipeline/asr.mjs', 'scripts/voice-pipeline/asr-worker.mjs', 'scripts/voice-pipeline/clean.mjs', 'scripts/voice-pipeline/gateway.mjs', 'scripts/voice-pipeline/llm.mjs', 'scripts/voice-pipeline/time.mjs', 'scripts/voice-pipeline/timeline.mjs', 'scripts/intent.mjs', 'web/voice/contracts.js', 'web/voice/capture.js', 'web/voice/pcm-worklet.js', 'web/voice/v3-panel.js', 'web/voice/v3-panel.css', 'scripts/tango-speech.mjs', 'scripts/tango-speech.ps1', 'scripts/ai-assistant.mjs', 'scripts/ai-discovery.mjs', 'scripts/assistant-config.mjs', 'web/model-catalog-cn.js', 'web/ai-parse.js', 'web/ai-prompt.js', 'web/agentic/sync.js'];

// W13 M19: web/agentic/** joins the candidate — W1 sync client (index.html 动态
// import，W1 终报 TA2 落地项)、W5 UI 全量（ui/ 组件 + assets/ + css + 页面）、
// W11 reel 三件。目录递归收集（brandFiles 同构），点文件不入包。
export function packagableFile(entry) {
  return entry.isFile() && !entry.name.startsWith('.');
}
async function treeFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? treeFiles(directory + '/' + entry.name) : packagableFile(entry) ? [directory + '/' + entry.name] : []));
  return nested.flat().sort();
}

export async function buildRelease({ outputParent = join(root, 'dist-web') } = {}) {
  async function brandFiles(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? brandFiles(directory + '/' + entry.name) : entry.isFile() && entry.name.endsWith('.png') ? [directory + '/' + entry.name] : []));
    return nested.flat().sort();
  }
  const assets = ['web/app-auth.js', 'web/app-auth.css', 'web/users-admin.js', 'web/users-admin.css', 'web/paper.css', 'web/appearance.css', 'web/appearance.js', 'web/locale-copy.js', ...await brandFiles('web/brand'), ...await treeFiles('web/agentic')];
  const sources = await Promise.all([...new Set([...files, ...assets])].map(async path => [path, await readFile(join(root, path))]));
  const html = sources[0][1].toString('utf8');
  if (!html.includes('Done&amp;Go') || !html.includes('tango-time-core')) throw new Error('Done&Go entry is missing');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=|application\/json/.test(match[1])) new vm.Script(match[2], { filename: 'web/index.html' });
  }
  // web/ai-parse.js is an ES module that index.html import()s at runtime; classic
  // vm.Script rejects export statements, so module assets get the same
  // node --check ESM syntax validation the verify:web chain runs instead.
  // web/agentic/**.js（W1 sync / W5 ui 组件 / W11 reel player）同样是浏览器原生
  // ES 模块（免构建），一律走 node --check（W13 M19）。
  const moduleAssets = sources.map(([path]) => path).filter(path => path === 'web/ai-parse.js' || ((path.startsWith('web/voice/') || path.startsWith('web/agentic/')) && path.endsWith('.js'))); // web/voice/、web/agentic/ 下的 .js 都是 ES 模块
  for (const [path, source] of sources.filter(([path]) => path.startsWith('web/') && path.endsWith('.js') && !moduleAssets.includes(path))) new vm.Script(source.toString('utf8'), { filename: path });
  for (const path of moduleAssets) await execFile(process.execPath, ['--check', join(root, path)]);
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
