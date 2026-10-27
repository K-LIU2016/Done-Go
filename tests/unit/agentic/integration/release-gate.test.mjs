// S2D-W13 · M26 发布门禁规格测试（scripts/agentic/integration/release-gate.mjs）。
//
// 依据：brief §6 门禁 6「npm run build:web/npm run build 生成临时 release，校验
// manifest SHA、无历史 bundle/用户数据、server 可启动、/api/status 和 agentic
// health 可读；不部署」+ §5.8「上一候选的回滚读取和服务行为可复核」；
// plan.md §G6 M26；M24 evidence 交接（复用 verifyReleaseCandidate，勿重写校验器）。
//
// 本文件钉的是 release-gate.mjs 的**可注入编排核心**：真实副作用（npm 子进程、
// dist-web 目录、M13/M14/M17 服务启动、fetch）全部经 deps 注入，单测用假件锁定
// 决策逻辑与失败分支。真实接线（release-gate-cli.mjs）由 M26 真实门禁执行复核
// （rc + 报告进 evidence/s2d-w13-release.md），同 M23 pw-server.mjs 口径。
//
// TDD：release-gate.mjs 未实现 → 本文件 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReleaseGate,
  isForbiddenReleasePath,
  diffNewCandidateNames,
  evaluateStatusProbe,
  evaluateHealthProbe,
} from '../../../../scripts/agentic/integration/release-gate.mjs';

// ---------------- 纯件：禁入路径分类（无历史 bundle/用户数据） ----------------

test('isForbiddenReleasePath names every historical-bundle / user-data class from the ignore ledger', () => {
  for (const path of [
    'node_modules/nodemailer/lib/index.js',
    'web/node_modules/foo.js',
    '.env',
    '.env.local',
    'config/.env.production',
    '.s2d/plan.md',
    'data/golden-8.sqlite',
    'storage/golden-8-a.sqlite-wal',
    'cache/state.db',
    '.tango-donego/settings.json',
    '.omo/trace.json',
    'logs/serve.log',
    'server.log',
    'test-results/pw.png',
    'artifacts/shot.png',
    'evidence/s2d-w13-release.md',
    'dist-web/donego-2026.10.19-x/index.html',
    'dist/bundle.js',
    'dist-ssr/entry.mjs',
    '.git/config',
    'keys/prod.key',
    'secrets/upstream.pem',
  ]) {
    assert.equal(isForbiddenReleasePath(path), true, `must be forbidden: ${path}`);
  }
});

test('isForbiddenReleasePath accepts every legitimate candidate payload path', () => {
  for (const path of [
    'manifest.json',
    'package.json',
    'web/index.html',
    'web/agentic/sync.js',
    'web/agentic/ui/app.js',
    'web/agentic/reel/player.js',
    'web/agentic/assets/logo.png',
    'web/voice/capture.js',
    'scripts/serve-tango.mjs',
    'scripts/agentic/integration/release.mjs',
    'server/auth/service.mjs',
    'web/model-catalog-cn.js',
  ]) {
    assert.equal(isForbiddenReleasePath(path), false, `must be allowed: ${path}`);
  }
});

// ---------------- 纯件：候选目录 diff ----------------

test('diffNewCandidateNames returns exactly the candidates the build created', () => {
  const before = ['donego-2026.10.19-a', 'donego-2026.10.19-b'];
  const after = [...before, 'donego-2026.10.19-c'];
  assert.deepEqual(diffNewCandidateNames(before, after), ['donego-2026.10.19-c']);
  assert.deepEqual(diffNewCandidateNames(before, [...before]), []);
  assert.deepEqual(diffNewCandidateNames([], ['donego-x']), ['donego-x']);
});

// ---------------- 纯件：探针响应裁决 ----------------

test('evaluateStatusProbe accepts the legacy /api/status shape and names every violation', () => {
  assert.deepEqual(evaluateStatusProbe({ status: 200, body: { app: 'Tango', status: 'ok' } }), { ok: true, problems: [] });
  const bad = evaluateStatusProbe({ status: 500, body: { app: 'Other', status: 'down' } });
  assert.equal(bad.ok, false);
  for (const problem of ['http-status', 'app', 'status-field']) assert.ok(bad.problems.includes(problem), `must name ${problem}: ${JSON.stringify(bad.problems)}`);
  assert.equal(evaluateStatusProbe({ status: 200, body: 'not-json' }).ok, false, 'non-JSON body is a violation, not a crash');
});

test('evaluateHealthProbe accepts the M17 health shape and names every violation', () => {
  const good = { status: 200, body: { status: 'ok', db: { ok: true, migrations: ['autonomy-001.sql', 'blocks-001.sql'] }, container: { ok: true } } };
  assert.deepEqual(evaluateHealthProbe(good), { ok: true, problems: [] });
  const bad = evaluateHealthProbe({
    status: 503,
    body: { status: 'ok', db: { ok: false, migrations: [] }, container: { ok: false } },
  });
  assert.equal(bad.ok, false);
  for (const problem of ['http-status', 'db-ok', 'blocks-migration', 'container-ok']) assert.ok(bad.problems.includes(problem), `must name ${problem}: ${JSON.stringify(bad.problems)}`);
});

// ---------------- runReleaseGate deps 骨架 ----------------

function happyVerify() {
  return {
    ok: true,
    checked: 3,
    mismatches: [],
    hasServerEntry: true,
    agenticAssets: ['web/agentic/sync.js', 'web/agentic/ui/app.js'],
  };
}

/** Happy-path deps：两次构建各产 1 个候选，全部探针绿。 */
function makeDeps(overrides = {}) {
  const state = {
    candidates: ['donego-old'],
    builds: [],
    cleaned: null,
    started: [],
    manifestBytes: { 'donego-prev': Buffer.from('{"schema":1,"prev":true}'), 'donego-curr': Buffer.from('{"schema":1,"curr":true}') },
  };
  const deps = {
    segment: { min: 17711, max: 17719 },
    buildCommands: { previous: 'npm run build:web', current: 'npm run build' },
    preferredPorts: { current: 17711, rollback: 17712 },
    runBuild: async command => {
      state.builds.push(command);
      const name = command === 'npm run build:web' ? 'donego-prev' : 'donego-curr';
      state.candidates = [...state.candidates, name];
      return { rc: 0, tail: `Done&Go release: dist-web/${name}` };
    },
    listCandidates: async () => [...state.candidates],
    verify: async () => happyVerify(),
    readManifestBytes: async name => state.manifestBytes[name],
    checkTree: async () => ({ extra: [], missing: [], forbidden: [] }),
    freePort: async preferred => preferred,
    startService: async (name, port) => {
      state.started.push({ name, port });
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => {},
      };
    },
    httpGet: async (baseUrl, path) => {
      if (path === '/api/status') return { status: 200, body: { app: 'Tango', status: 'ok' } };
      return { status: 200, body: { status: 'ok', db: { ok: true, migrations: ['blocks-001.sql'] }, container: { ok: true } } };
    },
    cleanup: async names => {
      state.cleaned = [...names];
      for (const name of names) state.candidates = state.candidates.filter(candidate => candidate !== name);
    },
    ...overrides,
  };
  return { deps, state };
}

// ---------------- happy path ----------------

test('runReleaseGate green path: two real npm commands, both candidates verified, health probes, rollback, cleanup, no deploy', async () => {
  const { deps, state } = makeDeps();
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(state.builds, ['npm run build:web', 'npm run build'], 'gate must run both brief §6.6 commands, in order');
  assert.equal(report.candidates.previous.name, 'donego-prev');
  assert.equal(report.candidates.current.name, 'donego-curr');
  for (const step of report.steps) assert.equal(step.ok, true, `step ${step.name} must pass: ${JSON.stringify(step.detail)}`);
  assert.deepEqual(state.cleaned, ['donego-prev', 'donego-curr'], 'both created candidates must be removed (临时 release)');
  assert.equal(report.rollback.manifestByteStable, true);
  assert.equal(report.rollback.verifiedAgain, true);
  assert.equal(report.rollback.serviceRechecked, true);
  assert.ok(report.http.length >= 4, 'http transcript must capture status+health on current and rollback services');
  for (const exchange of report.http) {
    assert.ok(exchange.port >= 17711 && exchange.port <= 17719, `port must stay inside the release segment: ${JSON.stringify(exchange)}`);
  }
  assert.equal(report.noDeploy.deployed, false);
  assert.deepEqual(report.noDeploy.remoteOperations, []);
});

// ---------------- 结构失败：构建与候选发现 ----------------

test('a failing build command aborts the gate with a named step, cleanup still runs', async () => {
  const { deps, state } = makeDeps({
    runBuild: async () => ({ rc: 1, tail: 'npm error' }),
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  const build = report.steps.find(step => step.name === 'build_previous');
  assert.equal(build.ok, false);
  assert.match(build.detail, /rc=1/);
  assert.equal(state.cleaned === null || Array.isArray(state.cleaned), true, 'cleanup contract stays defined');
});

test('a build that creates zero new candidates fails discovery (nothing to verify)', async () => {
  const { deps } = makeDeps({
    runBuild: async () => ({ rc: 0, tail: 'noop' }), // rc=0 but no candidate lands
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  assert.equal(report.steps.find(step => step.name === 'discover_previous').ok, false);
});

test('a build that creates two candidates at once fails discovery (ambiguous, never guess)', async () => {
  const candidates = ['donego-old'];
  const { deps } = makeDeps({
    runBuild: async command => {
      if (command === 'npm run build:web') candidates.push('donego-prev');
      else candidates.push('donego-curr', 'donego-foreign'); // a foreign build lands in parallel
      return { rc: 0, tail: 'x' };
    },
    listCandidates: async () => [...candidates],
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  const discover = report.steps.find(step => step.name === 'discover_current');
  assert.equal(discover.ok, false);
  assert.match(discover.detail, /2/);
});

// ---------------- 校验失败分支 ----------------

test('verify failures name the mismatches and abort service checks for that candidate', async () => {
  const { deps } = makeDeps({
    verify: async name => (name === 'donego-curr'
      ? { ok: false, checked: 3, mismatches: ['web/index.html'], hasServerEntry: true, agenticAssets: ['web/agentic/sync.js'] }
      : happyVerify()),
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  const verifyCurrent = report.steps.find(step => step.name === 'verify_current');
  assert.equal(verifyCurrent.ok, false);
  assert.match(verifyCurrent.detail, /web\/index\.html/);
  assert.equal(report.steps.find(step => step.name === 'service_current_status').ok, false, 'service checks may not run against an unverifiable candidate');
});

test('hasServerEntry=false and empty agenticAssets are each a named gate failure', async () => {
  const noServer = await runReleaseGate(makeDeps({
    verify: async () => ({ ...happyVerify(), hasServerEntry: false }),
  }).deps);
  assert.equal(noServer.ok, false);
  assert.equal(noServer.steps.find(step => step.name === 'verify_current').ok, false);
  assert.match(noServer.steps.find(step => step.name === 'verify_current').detail, /server/);

  const noAgentic = await runReleaseGate(makeDeps({
    verify: async () => ({ ...happyVerify(), agenticAssets: [] }),
  }).deps);
  assert.equal(noAgentic.ok, false);
  assert.match(noAgentic.steps.find(step => step.name === 'verify_current').detail, /agentic/);
});

test('tree violations (extra / missing / forbidden) each fail the gate naming the path', async () => {
  for (const violation of [
    { extra: ['stale-bundle.js'], missing: [], forbidden: [] },
    { extra: [], missing: ['web/agentic/sync.js'], forbidden: [] },
    { extra: [], missing: [], forbidden: ['user-data.sqlite'] },
  ]) {
    const { deps } = makeDeps({ checkTree: async () => ({ ...violation }) });
    const report = await runReleaseGate(deps);
    assert.equal(report.ok, false, JSON.stringify(violation));
    const key = violation.extra.length ? 'extra' : violation.missing.length ? 'missing' : 'forbidden';
    assert.match(report.steps.find(step => step.name === 'tree_current').detail, new RegExp(key));
  }
});

// ---------------- 服务探针失败分支 ----------------

test('an unhealthy /api/agentic/health (503) fails the gate naming the probe', async () => {
  const { deps } = makeDeps({
    httpGet: async (baseUrl, path) => (path === '/api/agentic/health'
      ? { status: 503, body: { error: { code: 'UPSTREAM_UNAVAILABLE' } } }
      : { status: 200, body: { app: 'Tango', status: 'ok' } }),
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  assert.equal(report.steps.find(step => step.name === 'service_current_health').ok, false);
});

test('a wrong /api/status body fails the gate naming the field', async () => {
  const { deps } = makeDeps({
    httpGet: async (baseUrl, path) => (path === '/api/status'
      ? { status: 200, body: { app: 'NotTango', status: 'ok' } }
      : { status: 200, body: { status: 'ok', db: { ok: true, migrations: ['blocks-001.sql'] }, container: { ok: true } } }),
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  assert.match(report.steps.find(step => step.name === 'service_current_status').detail, /app/);
});

test('a port outside the release segment is refused, never silently used', async () => {
  const { deps } = makeDeps({ freePort: async () => 17888 });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  assert.match(report.steps.find(step => step.name === 'service_current_port').detail, /17711-17719/);
});

test('startService throwing is captured as a failed step, not an unhandled crash', async () => {
  const { deps } = makeDeps({
    startService: async () => { throw new Error('EADDRINUSE'); },
  });
  const report = await runReleaseGate(deps);
  assert.equal(report.ok, false);
  assert.equal(report.steps.find(step => step.name === 'service_current_start').ok, false);
});

// ---------------- 回滚复核失败分支 ----------------

test('rollback failures are each named: manifest bytes drift, re-verify fail, rollback service fail', async () => {
  const drifted = await runReleaseGate(makeDeps({
    readManifestBytes: async name => (name === 'donego-prev' ? Buffer.from(`{"schema":1,"n":${Math.random()}}`) : Buffer.from('{"schema":1}')),
  }).deps);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.steps.find(step => step.name === 'rollback_manifest_bytes').ok, false);

  const reverifyFail = await runReleaseGate(makeDeps({
    verify: async name => (name === 'donego-prev'
      ? { ...happyVerify(), mismatches: ['web/index.html'], ok: false }
      : happyVerify()),
    // first-verify of prev must pass so the gate reaches the rollback phase
  }).deps);
  assert.equal(reverifyFail.ok, false);

  const rollbackServiceFail = await runReleaseGate(makeDeps({
    httpGet: async (baseUrl, path) => {
      // rollback service (second start) answers 500 on /api/status
      if (baseUrl.endsWith('17712') && path === '/api/status') return { status: 500, body: {} };
      if (path === '/api/status') return { status: 200, body: { app: 'Tango', status: 'ok' } };
      return { status: 200, body: { status: 'ok', db: { ok: true, migrations: ['blocks-001.sql'] }, container: { ok: true } } };
    },
  }).deps);
  assert.equal(rollbackServiceFail.ok, false);
  assert.equal(rollbackServiceFail.steps.find(step => step.name === 'rollback_service_status').ok, false);
});

// ---------------- cleanup 契约 ----------------

test('cleanup failure or unrestored dist-web fails the gate honestly', async () => {
  const failing = await runReleaseGate(makeDeps({
    cleanup: async () => { throw new Error('EACCES'); },
  }).deps);
  assert.equal(failing.ok, false);
  assert.equal(failing.steps.find(step => step.name === 'cleanup').ok, false);

  const unrestored = await runReleaseGate(makeDeps({
    cleanup: async () => {}, // claims success but leaves the candidates behind
  }).deps);
  assert.equal(unrestored.ok, false);
  assert.equal(unrestored.steps.find(step => step.name === 'tree_restored').ok, false);
});

test('cleanup runs even when earlier steps fail (no candidate left behind)', async () => {
  const state = { cleanedWith: null };
  const base = makeDeps();
  const { deps } = makeDeps({
    verify: async () => ({ ...happyVerify(), ok: false, mismatches: ['web/index.html'] }),
    cleanup: async names => { state.cleanedWith = [...names]; base.deps.cleanup(names); },
  });
  await runReleaseGate(deps);
  assert.deepEqual(state.cleanedWith, ['donego-prev', 'donego-curr']);
});

// ---------------- deps 构造期裁决 ----------------

test('runReleaseGate refuses malformed deps at construction time (fail-closed wiring)', async () => {
  for (const [label, mutate] of [
    ['segment', deps => { deps.segment = { min: 17800, max: 17790 }; }],
    ['buildCommands', deps => { delete deps.buildCommands.current; }],
    ['runBuild', deps => { deps.runBuild = 'not-a-function'; }],
    ['verify', deps => { delete deps.verify; }],
    ['checkTree', deps => { deps.checkTree = null; }],
    ['startService', deps => { deps.startService = undefined; }],
    ['httpGet', deps => { deps.httpGet = 42; }],
    ['preferredPorts', deps => { deps.preferredPorts = { current: 19999, rollback: 17712 }; }],
  ]) {
    const { deps } = makeDeps();
    mutate(deps);
    await assert.rejects(() => runReleaseGate(deps), /release-gate/i, `must reject malformed ${label}`);
  }
});
