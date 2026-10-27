#!/usr/bin/env node
// S2D-W13 · M26 发布门禁真实接线（scripts/agentic/integration/release-gate-cli.mjs）。
//
// 用法：node scripts/agentic/integration/release-gate-cli.mjs --report <path.json>
//
// 执行 brief §6 门禁 6 的真实动作（编排决策在 release-gate.mjs，单测已锁）：
//   1. `npm run build:web` → 上一候选；`npm run build` → 当前候选（真实子进程，
//      落地 worktree dist-web/——.gitignore 台账内，git status 不可见）；
//   2. 两候选经 M24 verifyReleaseCandidate 逐文件复算 manifest SHA-256 +
//      候选树围栏（树 === manifest ∪ {manifest.json, package.json}，禁入
//      node_modules/.env/.s2d/sqlite/历史 bundle/用户数据——isForbiddenReleasePath）；
//   3. 当前候选 server 启动（候选树自带的 scripts/serve-tango.mjs + M13 组合根
//      [临时 SQLite + 确定性时钟 + cookie principal] + M14 dispatcher + M17
//      health），端口段 17711-17719（占用段内顺延，绝不静默离段）：
//      GET /api/status（legacy 服务行为）+ GET /api/agentic/health（免登录探活）；
//   4. 上一候选回滚读取（manifest.json 字节稳定 + SHA 复验 + 服务行为复核）；
//   5. cleanup：只移除本门禁创建的两个候选目录（绝不碰外来目录），dist-web
//      恢复门禁前状态；**不部署**：零 git 远端操作、零真实上游、网络仅
//      127.0.0.1 已启动候选服务（红线 4/9，brief「不部署」）。
//
// 覆盖率口径：本文件仅由真实门禁执行（evidence/s2d-w13-release.md 记 rc+报告），
// 不被任何测试 import——同 M23 pw-server.mjs 的 node 覆盖率 N/A 先例。

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runReleaseGate, isForbiddenReleasePath } from './release-gate.mjs';
import { verifyReleaseCandidate } from './release.mjs';
import { createIntegrationContext } from './context.mjs';
import { createAgenticDispatcher } from './dispatcher.mjs';
import { createHealthHandler } from './health.mjs';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../'); // worktree 根（w13-integrate）
const distWeb = join(root, 'dist-web');
const SEGMENT = { min: 17711, max: 17719 }; // plan.md §2 端口台账：release 健康检查段
const OWNER = 'owner-release-gate';

// ---------------- 真实 deps ----------------

async function listCandidates() {
  try {
    const entries = await readdir(distWeb, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && entry.name.startsWith('donego-')).map(entry => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return []; // dist-web 尚不存在 = 空快照
    throw error;
  }
}

/** 真实执行 brief 钦点命令（label 形如 "npm run build:web"）。 */
async function runBuild(label) {
  const script = label.split(' ').pop(); // 'build:web' | 'build'
  try {
    const { stdout, stderr } = await execFile('npm', ['run', script], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return { rc: 0, tail: `${stdout}${stderr}`.slice(-2000) };
  } catch (error) {
    return { rc: typeof error.code === 'number' ? error.code : 1, tail: `${error.stdout ?? ''}${error.stderr ?? error.message}`.slice(-2000) };
  }
}

async function readManifestBytes(name) {
  return readFile(join(distWeb, name, 'manifest.json'));
}

async function walkDirectory(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkDirectory(join(directory, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** 候选树围栏：文件集 === manifest ∪ {manifest.json, package.json}；禁入路径逐条点名。 */
async function checkTree(name, manifestByteStash = null) {
  const directory = join(distWeb, name);
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  if (manifestByteStash) manifestByteStash.set(name, manifestBytes); // cleanup 后 meta 仍可复算 SHA
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const allowed = new Set([...Object.keys(manifest.files), 'manifest.json', 'package.json']);
  const onDisk = await walkDirectory(directory);
  return {
    extra: onDisk.filter(rel => !allowed.has(rel)),
    missing: [...allowed].filter(rel => !onDisk.includes(rel)),
    forbidden: onDisk.filter(rel => isForbiddenReleasePath(rel)),
  };
}

function canBind(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** 段内空闲端口：preferred 起探，占用则段内顺延；段满 = 抛错（绝不静默离段）。 */
async function freePort(preferred) {
  if (await canBind(preferred)) return preferred;
  for (let port = SEGMENT.min; port <= SEGMENT.max; port += 1) {
    if (port === preferred) continue;
    if (await canBind(port)) return port;
  }
  throw new Error(`no free port left in the release segment ${SEGMENT.min}-${SEGMENT.max}`);
}

/** 从候选树自带的 serve-tango 启动服务（M13 组合根 + M14 dispatcher + M17 health）。 */
async function startService(name, port) {
  const mod = await import(pathToFileURL(join(distWeb, name, 'scripts/serve-tango.mjs')).href);
  const scratch = await mkdtemp(join(tmpdir(), 'w13-release-gate-'));
  let tick = 0;
  const startMs = Date.parse('2026-10-28T12:00:00.000Z');
  const context = createIntegrationContext({
    dbFile: join(scratch, 'gate.sqlite'),
    now: () => new Date(startMs + tick++ * 1000).toISOString(),
    auth: req => (/tango-session=w13-release-gate/.test(String(req.headers?.cookie || ''))
      ? { ownerId: OWNER, id: OWNER, actor: 'w13.release-gate' }
      : null),
  });
  const dispatcher = createAgenticDispatcher({
    context,
    handlers: [createHealthHandler(context)],
  });
  const server = mod.createTangoServer({
    agentic: dispatcher,
    speechCapabilities: async () => ({ available: false, languages: [] }), // 无外部探测（M18/M23 同款注入）
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const bound = server.address().port;
  return {
    port: bound,
    baseUrl: `http://127.0.0.1:${bound}`,
    close: async () => {
      await new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      try {
        context.db.close?.();
      } catch { /* db 已关/未开按已清理处理 */ }
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

async function httpGet(baseUrl, path) {
  const response = await fetch(baseUrl + path);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function cleanup(names) {
  for (const name of names) {
    await rm(join(distWeb, name), { recursive: true, force: true });
  }
}

// ---------------- main ----------------

const reportArgIndex = process.argv.indexOf('--report');
const reportPath = reportArgIndex !== -1 ? process.argv[reportArgIndex + 1] : null;

// readManifestBytes 旁路留存原始字节——cleanup 之后 meta 仍可复算 manifest SHA
// （报告自洽，不依赖已删除的候选目录）。
const manifestByteStash = new Map();
const stashingReadManifestBytes = async name => {
  const bytes = await readManifestBytes(name);
  manifestByteStash.set(name, bytes);
  return bytes;
};

const report = await runReleaseGate({
  segment: SEGMENT,
  buildCommands: { previous: 'npm run build:web', current: 'npm run build' },
  preferredPorts: { current: 17711, rollback: 17712 },
  runBuild,
  listCandidates,
  verify: async name => verifyReleaseCandidate(join(distWeb, name)),
  readManifestBytes: stashingReadManifestBytes,
  checkTree: async name => checkTree(name, manifestByteStash),
  freePort,
  startService,
  httpGet,
  cleanup,
});

const payload = JSON.stringify({
  ...report,
  meta: {
    worktree: root,
    distWeb,
    candidateDirectories: {
      previous: report.candidates.previous ? join(distWeb, report.candidates.previous.name) : null,
      current: report.candidates.current ? join(distWeb, report.candidates.current.name) : null,
    },
    manifestSha256: {
      previous: manifestByteStash.has(report.candidates.previous?.name)
        ? createHash('sha256').update(manifestByteStash.get(report.candidates.previous.name)).digest('hex')
        : null,
      current: manifestByteStash.has(report.candidates.current?.name)
        ? createHash('sha256').update(manifestByteStash.get(report.candidates.current.name)).digest('hex')
        : null,
    },
    generatedBy: 'scripts/agentic/integration/release-gate-cli.mjs',
  },
}, null, 2) + '\n';

if (reportPath) {
  await writeFile(reportPath, payload, 'utf8');
}
process.stdout.write(payload);
for (const entry of report.steps) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} — ${entry.detail}\n`);
}
process.exit(report.ok ? 0 : 1);
