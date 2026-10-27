// S2D-W13 · M23 golden-8（brief §5.8 / plan.md §G5 M23）：发布候选黄金场景（node 侧）。
//
// 「发布候选 build 的 manifest 包含所有已批准的 web/server 文件，启动健康检查
// 通过；上一候选的回滚读取和服务行为可复核。」
//
// 与 M26-release 的分工（plan.md §G6）：本场景是黄金场景验收——临时目录内
// build 两个候选、从候选树自身启动服务、健康检查、上一候选回滚回读，全部
// localhost + 临时 SQLite + 确定性时钟，零部署、零真实上游。M26 才做
// npm run build:web 的门禁与 release.mjs 校验器（release-rollback.test.mjs
// 的预期 RED 归 M26，本文件不实现 release.mjs、不复用其断言）。
//
// 阶段（期望值全部来自 fixtures/golden-8-release.json）：
//   A. build 候选 A → manifest 完整性：必备路径（entry/W1 sync/W5 UI 页+组件/
//      W11 reel/server 侧）、前缀计数、逐文件 SHA-256 复算全等、候选树文件集
//      === manifest ∪ {manifest.json, package.json}（无历史 bundle/用户数据/
//      node_modules/.env/.s2d——forbiddenPathPatterns 逐条拒绝）。
//   B. 启动健康检查：import 候选 A 树内的 scripts/serve-tango.mjs（不是工作树
//      的）→ createTangoServer({agentic: M14 dispatcher(M13 context + M17 health)})
//      → 127.0.0.1:17711（段 17711–17719 内，占用段内顺延）→
//      GET /api/status 200（legacy 服务行为）+ GET /api/agentic/health 200
//      （status ok / db.ok / 单台账含 blocks-001 / container ok / 免登录可读）。
//   C. 回滚：build 候选 B（更新者落地）→ 候选 A manifest.json 字节不变、全部
//      文件仍在且 SHA 复算全等（回滚读取）、候选 A 服务再次可启动且
//      /api/status + /api/agentic/health 照常应答（服务行为可复核）。
//   D. 证据：{scenario, ports, http, manifestChecks, finalState} 写入
//      W13_GOLDEN_EVIDENCE_DIR（设置时；未设置仅回传不落盘——测试保持密闭）。
//
// 红线：不部署、不推远端、无真实 gateway/model/email；唯一时间源=注入时钟；
// 网络=127.0.0.1 两个段内端口；不读 key。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

import { buildRelease } from '../../../scripts/build-web.mjs';
import { createIntegrationContext } from '../../../scripts/agentic/integration/context.mjs';
import { createAgenticDispatcher } from '../../../scripts/agentic/integration/dispatcher.mjs';
import { createHealthHandler } from '../../../scripts/agentic/integration/health.mjs';

const SPEC = JSON.parse(await readFile(new URL('./fixtures/golden-8-release.json', import.meta.url), 'utf8'));
const SCENARIO = SPEC.scenario;
const EXPECT = SPEC.expect;

// ---------------- release 段端口（17711–17719；绝不静默离段） ----------------

function canBind(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function pickReleasePort(preferred) {
  const { min, max } = SCENARIO.portRange;
  if (!Number.isInteger(preferred) || preferred < min || preferred > max) {
    throw new Error(`golden-8: preferred port must be an integer inside the release range ${min}-${max} (got ${String(preferred)})`);
  }
  if (await canBind(preferred)) return preferred;
  for (let port = min; port <= max; port++) {
    if (port === preferred) continue;
    if (await canBind(port)) return port;
  }
  throw new Error(`golden-8: no free port left in the release range ${min}-${max}`);
}

// ---------------- 候选装配（M13 组合根 + M14 dispatcher + M17 health → 候选树 serve-tango） ----------------

/** 临时 sqlite + 确定性时钟 + cookie principal；返回 M13 组合根。 */
function goldenContext(dbFile) {
  let tick = 0;
  const startMs = Date.parse('2026-10-28T12:00:00.000Z');
  return createIntegrationContext({
    dbFile,
    now: () => new Date(startMs + tick++ * 1000).toISOString(),
    auth: req => (/tango-session=golden-8/.test(String(req.headers?.cookie || ''))
      ? { ownerId: SCENARIO.owner, id: SCENARIO.owner, actor: 'golden-8.release' }
      : null),
  });
}

/** 从候选目录 import 其自带的 serve-tango.mjs，挂 agentic dispatcher 后监听 release 段端口。 */
async function startCandidateServer(candidateDir, context, preferredPort) {
  const mod = await import(pathToFileURL(join(candidateDir, 'scripts/serve-tango.mjs')).href);
  assert.equal(typeof mod.createTangoServer, 'function', 'candidate must ship a mountable scripts/serve-tango.mjs');
  const dispatcher = createAgenticDispatcher({
    context,
    handlers: [createHealthHandler(context)],
  });
  const server = mod.createTangoServer({
    agentic: dispatcher,
    speechCapabilities: async () => ({ available: false, languages: [] }), // 无外部探测（M18 serve-mount 测试同款注入）
  });
  const port = await pickReleasePort(preferredPort);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, port, baseUrl: `http://127.0.0.1:${port}` };
}

async function getJson(baseUrl, path, headers = {}) {
  const response = await fetch(baseUrl + path, { headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

// ---------------- manifest 校验（golden-8 自有；M26 的 release.mjs 校验器另立） ----------------

async function walk(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** 逐文件复算 SHA-256；并校验候选树文件集与 manifest 严格一致（无多余/缺失）。 */
async function verifyCandidate(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entry, EXPECT.manifestEntry, 'manifest entry must stay web/index.html');
  const mismatches = [];
  for (const [rel, expectedSha] of Object.entries(manifest.files)) {
    const buf = await readFile(join(directory, rel));
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== expectedSha) mismatches.push(rel);
  }
  const onDisk = await walk(directory);
  const allowed = new Set([...Object.keys(manifest.files), ...EXPECT.allowedExtraFiles]);
  const extra = onDisk.filter(rel => !allowed.has(rel));
  const missing = [...allowed].filter(rel => !onDisk.includes(rel));
  return { manifest, mismatches, onDisk, extra, missing };
}

// ---------------- 场景主体 ----------------

test('golden-8 (§5.8): candidate manifest carries every approved web/server file, SHA-verified, nothing historical', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'w13-golden-8-'));
  const checks = { requiredPaths: 0, shaVerified: 0, prefixCounts: {} };
  const evidence = {
    scenario: SCENARIO.id,
    brief: SCENARIO.brief,
    owner: SCENARIO.owner,
    outputParent: parent,
    ports: {},
    http: [],
    manifestChecks: checks,
    finalState: {},
  };
  try {
    // —— A. 候选 A 构建 + manifest 完整性 ——
    const candidateA = await buildRelease({ outputParent: parent });
    evidence.candidateA = candidateA.directory;
    const reportA = await verifyCandidate(candidateA.directory);
    assert.deepEqual(reportA.mismatches, [], 'every manifest SHA-256 must recompute equal');
    assert.deepEqual(reportA.extra, [], `candidate tree must contain only manifest+server files (extra: ${JSON.stringify(reportA.extra)})`);
    assert.deepEqual(reportA.missing, [], 'no manifest file may be missing on disk');
    checks.shaVerified = Object.keys(reportA.manifest.files).length;

    for (const rel of EXPECT.requiredPaths) {
      assert.ok(reportA.manifest.files[rel] !== undefined, `manifest must include approved file ${rel}`);
    }
    checks.requiredPaths = EXPECT.requiredPaths.length;
    for (const { prefix, minCount } of EXPECT.requiredPrefixes) {
      const count = Object.keys(reportA.manifest.files).filter(rel => rel.startsWith(prefix)).length;
      assert.ok(count >= minCount, `manifest must carry >=${minCount} files under ${prefix} (got ${count})`);
      checks.prefixCounts[prefix] = count;
    }
    // server 入口在位（package.json start → node scripts/serve-tango.mjs）
    const pkg = JSON.parse(await readFile(join(candidateA.directory, EXPECT.serverEntry), 'utf8'));
    assert.equal(pkg.scripts.start, 'node scripts/serve-tango.mjs', 'server entry must start the packaged serve-tango');
    // 候选树禁入项（历史 bundle / 用户数据 / node_modules / .env / .s2d / sqlite）
    const forbidden = EXPECT.forbiddenPathPatterns.map(pattern => new RegExp(pattern));
    for (const rel of reportA.onDisk) {
      for (const re of forbidden) {
        assert.ok(!re.test(rel), `candidate must not ship forbidden path "${rel}" (pattern ${re})`);
      }
    }
    // manifest.json 字节快照（C 阶段回滚读取的对照基准）
    const manifestBytesA = await readFile(join(candidateA.directory, 'manifest.json'));

    // —— B. 启动健康检查（候选 A 树自身 + M13/M14/M17 集成挂载） ——
    const dbA = join(parent, 'golden-8-a.sqlite');
    const ctxA = goldenContext(dbA);
    const serverA = await startCandidateServer(candidateA.directory, ctxA, SCENARIO.portPreferred.candidateA);
    evidence.ports.candidateA = serverA.port;
    try {
      const status = await getJson(serverA.baseUrl, '/api/status');
      evidence.http.push({ port: serverA.port, path: '/api/status', status: status.status });
      assert.equal(status.status, EXPECT.legacyStatus.status, '/api/status must answer from the candidate server');
      assert.equal(status.body.app, EXPECT.legacyStatus.app);
      assert.equal(status.body.status, EXPECT.legacyStatus.bodyStatus);

      const health = await getJson(serverA.baseUrl, '/api/agentic/health');
      evidence.http.push({ port: serverA.port, path: '/api/agentic/health', status: health.status });
      assert.equal(health.status, EXPECT.health.unauthenticatedStatus, 'agentic health must be readable without login (release probe path)');
      assert.equal(health.body.status, EXPECT.health.statusField);
      assert.equal(health.body.db.ok, EXPECT.health.dbOk);
      assert.ok(
        health.body.db.migrations.some(name => name.startsWith(EXPECT.health.migrationsInclude)),
        `agentic db must have applied ${EXPECT.health.migrationsInclude}* via the W0 single ledger (got ${JSON.stringify(health.body.db.migrations)})`,
      );
      assert.equal(health.body.container.ok, EXPECT.health.containerOk);
      assert.equal(ctxA.appliedMigrations.some(name => name.startsWith('blocks-')), true, 'context applied the W1 blocks migration once');
    } finally {
      await new Promise(resolve => serverA.server.close(resolve));
      ctxA.db.close?.();
    }

    // —— C. 候选 B 落地 → 候选 A 回滚读取 + 服务行为复核 ——
    const candidateB = await buildRelease({ outputParent: parent });
    evidence.candidateB = candidateB.directory;
    assert.notEqual(candidateB.directory, candidateA.directory, 'a newer candidate must land in its own directory');
    const manifestBytesAAfter = await readFile(join(candidateA.directory, 'manifest.json'));
    if (EXPECT.rollback.manifestByteStable) {
      assert.ok(manifestBytesA.equals(manifestBytesAAfter), 'previous candidate manifest.json must stay byte-stable after a newer build');
    }
    const reportA2 = await verifyCandidate(candidateA.directory);
    if (EXPECT.rollback.filesStillVerify) {
      assert.deepEqual(reportA2.mismatches, [], 'rollback read-back: every previous-candidate file must still verify');
      assert.deepEqual(reportA2.extra, []);
      assert.deepEqual(reportA2.missing, []);
    }
    if (EXPECT.rollback.serviceStillServes) {
      const dbA2 = join(parent, 'golden-8-a-rollback.sqlite');
      const ctxA2 = goldenContext(dbA2);
      const serverA2 = await startCandidateServer(candidateA.directory, ctxA2, SCENARIO.portPreferred.candidateARollback);
      evidence.ports.candidateARollback = serverA2.port;
      try {
        const status = await getJson(serverA2.baseUrl, '/api/status');
        evidence.http.push({ port: serverA2.port, path: '/api/status', status: status.status });
        assert.equal(status.status, 200, 'rolled-back candidate service behavior stays reviewable (/api/status)');
        const health = await getJson(serverA2.baseUrl, '/api/agentic/health');
        evidence.http.push({ port: serverA2.port, path: '/api/agentic/health', status: health.status });
        assert.equal(health.status, 200, 'rolled-back candidate agentic health stays readable');
        assert.equal(health.body.status, 'ok');
      } finally {
        await new Promise(resolve => serverA2.server.close(resolve));
        ctxA2.db.close?.();
      }
    }

    evidence.finalState = {
      candidateAFiles: Object.keys(reportA2.manifest.files).length,
      candidateBFiles: Object.keys(candidateB.manifest.files).length,
      rollbackVerified: reportA2.mismatches.length === 0 && reportA2.extra.length === 0 && reportA2.missing.length === 0,
      httpExchangeCount: evidence.http.length,
    };
    assert.ok(evidence.finalState.rollbackVerified);
  } finally {
    // —— D. 证据（opt-in 落盘；测试自身保持密闭） ——
    if (process.env.W13_GOLDEN_EVIDENCE_DIR) {
      await writeFile(
        join(process.env.W13_GOLDEN_EVIDENCE_DIR, 'golden-8-evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test('golden-8 fixture self-check: ports stay in the release segment 17711-17719', async () => {
  const { min, max } = SCENARIO.portRange;
  assert.ok(min === 17711 && max === 17719, 'golden-8 must keep the plan.md §2 release port ledger (17711-17719)');
  for (const key of ['candidateA', 'candidateARollback']) {
    const port = SCENARIO.portPreferred[key];
    assert.ok(Number.isInteger(port) && port >= min && port <= max, `preferred port ${key} must sit inside ${min}-${max}`);
  }
  // allowedExtraFiles 必须恰好覆盖 server 入口与清单自身
  assert.deepEqual([...EXPECT.allowedExtraFiles].sort(), ['manifest.json', 'package.json']);
});
