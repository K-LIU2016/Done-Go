// S2D-W13 · 发布门禁编排核心（scripts/agentic/integration/release-gate.mjs）。
//
// 依据：brief §6 门禁 6「npm run build:web / npm run build 生成临时 release，校验
// manifest SHA、无历史 bundle/用户数据、server 可启动、/api/status 和 agentic
// health 可读；不部署」+ §5.8「上一候选的回滚读取和服务行为可复核」；
// plan.md §G6 M26-release；M24 evidence 交接（复用 verifyReleaseCandidate，
// 勿重写校验器）。
//
// 本模块是**可注入编排核心**：所有真实副作用（npm 子进程、dist-web 目录、
// M13/M14/M17 服务启动、HTTP 探针）经 deps 注入，单测（release-gate.test.mjs）
// 用假件锁定决策逻辑与失败分支。真实接线在 release-gate-cli.mjs（由 M26 真实
// 门禁执行复核，rc+报告进 evidence/s2d-w13-release.md；同 M23 pw-server.mjs
// 的 node 覆盖率 N/A 口径）。
//
// runReleaseGate(deps) 契约：
//   deps.segment {min,max}                  发布健康检查端口段（17711-17719）
//   deps.buildCommands {previous,current}   两条 brief 钦点命令标签（按序执行）
//   deps.preferredPorts {current,rollback}  段内首选端口（占用则 deps.freePort 顺延）
//   deps.runBuild(label) → {rc, tail}       执行真实构建（副作用：落地一个候选）
//   deps.listCandidates() → string[]        dist-web 内候选目录名快照
//   deps.verify(name) → verifyReleaseCandidate 形状（M24 校验器，manifest SHA）
//   deps.readManifestBytes(name) → Buffer   候选 manifest.json 原始字节（回滚稳定性）
//   deps.checkTree(name) → {extra,missing,forbidden}  候选树 vs 清单 + 禁入路径
//   deps.freePort(preferred) → port         段内空闲端口探测
//   deps.startService(name, port) → {baseUrl, port, close}  从候选树启动服务
//   deps.httpGet(baseUrl, path) → {status, body}           127.0.0.1 探针
//   deps.cleanup(names)                     移除本门禁创建的候选（临时 release）
//
// 返回 report {ok, segment, commands, candidates, steps[], http[], rollback,
// noDeploy, warnings[]}；ok=steps 全绿。任何失败=具名 step 失败，不崩溃、
// 不虚构通过；cleanup 对已创建候选 finally 必达（不留候选在 dist-web）。
//
// 红线自守（红线 4/9）：本核心无 Date/环境变量/fetch/子进程/文件 IO——
// 一切时间与副作用由注入方提供；不部署（noDeploy 为本门禁的结构性承诺：
// 零 git 远端操作、网络仅限已启动候选的 127.0.0.1 服务）。

// ---------------- 纯件：禁入路径分类（无历史 bundle/用户数据） ----------------

/**
 * 候选树内禁入路径分类器。基线=候选树文件集必须严格等于 manifest ∪
 * {manifest.json, package.json}（checkTree）；本分类器在此之上为每类
 * 历史 bundle / 用户数据 / 本地产物给出可点名的原因（来自 .gitignore 台账
 * 与 W13 证据目录约定的类别，非逐字复制）。
 */
const FORBIDDEN_SEGMENTS = new Set([
  'node_modules', '.git', '.s2d', '.tango-donego', '.omo',
  'test-results', 'artifacts', 'evidence',
  'dist', 'dist-web', 'dist-ssr', 'logs',
]);
const FORBIDDEN_SUFFIXES = ['.log', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.key', '.pem'];

export function isForbiddenReleasePath(path) {
  if (typeof path !== 'string' || path === '') return true; // 非法输入按禁入处理（fail-closed）
  for (const segment of path.split('/')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return true;
    if (segment.startsWith('.env')) return true;
    if (FORBIDDEN_SUFFIXES.some(suffix => segment.endsWith(suffix))) return true;
  }
  return false;
}

// ---------------- 纯件：候选目录 diff ----------------

/** after 相对 before 新增的候选目录名（保序）——构建必须恰好产 1 个。 */
export function diffNewCandidateNames(before, after) {
  const seen = new Set(Array.isArray(before) ? before : []);
  return (Array.isArray(after) ? after : []).filter(name => !seen.has(name));
}

// ---------------- 纯件：探针响应裁决 ----------------

/** /api/status（legacy 服务行为）：200 + app 'Tango' + status 'ok'。 */
export function evaluateStatusProbe(response) {
  const problems = [];
  if (!response || response.status !== 200) problems.push('http-status');
  const body = response && typeof response.body === 'object' && response.body !== null ? response.body : null;
  if (!body) {
    problems.push('body');
    return { ok: false, problems };
  }
  if (body.app !== 'Tango') problems.push('app');
  if (body.status !== 'ok') problems.push('status-field');
  return { ok: problems.length === 0, problems };
}

/** /api/agentic/health（M17）：200 + status ok + db.ok + blocks-* 迁移 + container.ok。 */
export function evaluateHealthProbe(response) {
  const problems = [];
  if (!response || response.status !== 200) problems.push('http-status');
  const body = response && typeof response.body === 'object' && response.body !== null ? response.body : null;
  if (!body) {
    problems.push('body');
    return { ok: false, problems };
  }
  if (body.status !== 'ok') problems.push('status-field');
  const db = typeof body.db === 'object' && body.db !== null ? body.db : null;
  if (!db || db.ok !== true) problems.push('db-ok');
  if (!Array.isArray(db?.migrations) || !db.migrations.some(name => String(name).startsWith('blocks-'))) {
    problems.push('blocks-migration');
  }
  if (!body.container || body.container.ok !== true) problems.push('container-ok');
  return { ok: problems.length === 0, problems };
}

// ---------------- 编排核心 ----------------

function gateError(code, message) {
  const error = new Error(`release-gate: ${message}`);
  error.name = 'ReleaseGateError';
  error.code = code;
  return error;
}

function isPlainFunction(value) {
  return typeof value === 'function';
}

function assertDeps(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw gateError('RELEASE_GATE_DEPS_INVALID', 'an injected deps object is required (runBuild/listCandidates/verify/...)');
  }
  const { segment, buildCommands, preferredPorts } = deps;
  if (!segment || !Number.isInteger(segment.min) || !Number.isInteger(segment.max) || segment.min > segment.max) {
    throw gateError('RELEASE_GATE_SEGMENT_INVALID', 'deps.segment must be {min,max} integers with min<=max (release port ledger 17711-17719)');
  }
  for (const key of ['previous', 'current']) {
    if (typeof buildCommands?.[key] !== 'string' || buildCommands[key] === '') {
      throw gateError('RELEASE_GATE_COMMANDS_INVALID', `deps.buildCommands.${key} must be a non-empty command label`);
    }
  }
  for (const key of ['current', 'rollback']) {
    const port = preferredPorts?.[key];
    if (!Number.isInteger(port) || port < segment.min || port > segment.max) {
      throw gateError('RELEASE_GATE_PORTS_INVALID', `deps.preferredPorts.${key} must be an integer inside ${segment.min}-${segment.max}`);
    }
  }
  for (const key of ['runBuild', 'listCandidates', 'verify', 'readManifestBytes', 'checkTree', 'freePort', 'startService', 'httpGet', 'cleanup']) {
    if (!isPlainFunction(deps[key])) {
      throw gateError('RELEASE_GATE_DEPS_INVALID', `deps.${key} must be an injected function`);
    }
  }
}

/**
 * 执行 M26 发布门禁（全注入编排）。返回 report（ok=steps 全绿）；构造期
 * deps 不合法即抛 ReleaseGateError；运行期任何失败=具名 step 失败。
 */
export async function runReleaseGate(deps) {
  assertDeps(deps);
  const { segment, buildCommands, preferredPorts } = deps;
  const steps = [];
  const http = [];
  const warnings = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok: ok === true, detail });
    return ok === true;
  };
  const probe = async (candidate, service, path, evaluate, stepName) => {
    let response;
    try {
      response = await deps.httpGet(service.baseUrl, path);
    } catch (error) {
      response = null;
      warnings.push(`httpGet ${path} threw: ${error?.message ?? String(error)}`);
    }
    http.push({ candidate, port: service.port, path, status: response ? response.status : null });
    const verdict = evaluate(response);
    return step(stepName, verdict.ok, verdict.ok ? `200 ${path}` : `${path} problems: ${verdict.problems.join(', ')}`);
  };

  const report = {
    ok: false,
    segment,
    commands: { ...buildCommands },
    candidates: { previous: null, current: null },
    steps,
    http,
    rollback: { manifestByteStable: null, verifiedAgain: null, serviceRechecked: null },
    noDeploy: {
      deployed: false,
      remoteOperations: [], // 本门禁结构性承诺：零 git push/远端/部署操作
      networkScope: '127.0.0.1 candidate services only',
    },
    warnings,
  };

  const created = []; // 本门禁创建、cleanup 必达的候选名
  try {
    // —— 1. 构建上一候选（npm run build:web）——
    const before = await deps.listCandidates();
    const previousBuild = await deps.runBuild(buildCommands.previous);
    if (!step('build_previous', previousBuild.rc === 0, `command "${buildCommands.previous}" rc=${previousBuild.rc}; tail: ${String(previousBuild.tail ?? '').slice(-400)}`)) return report;
    const afterPrevious = await deps.listCandidates();
    const newPrevious = diffNewCandidateNames(before, afterPrevious);
    if (!step('discover_previous', newPrevious.length === 1, `expected exactly 1 new candidate, got ${newPrevious.length}: ${JSON.stringify(newPrevious)}`)) return report;
    const previous = newPrevious[0];
    created.push(previous);
    const previousManifestBytes = await deps.readManifestBytes(previous);
    report.candidates.previous = { name: previous };

    // —— 2. 构建当前候选（npm run build）——
    const previousBuild2 = await deps.runBuild(buildCommands.current);
    if (!step('build_current', previousBuild2.rc === 0, `command "${buildCommands.current}" rc=${previousBuild2.rc}; tail: ${String(previousBuild2.tail ?? '').slice(-400)}`)) return report;
    const afterCurrent = await deps.listCandidates();
    const newCurrent = diffNewCandidateNames(afterPrevious, afterCurrent);
    if (!step('discover_current', newCurrent.length === 1, `expected exactly 1 new candidate, got ${newCurrent.length}: ${JSON.stringify(newCurrent)}`)) return report;
    const current = newCurrent[0];
    created.push(current);
    report.candidates.current = { name: current };

    // —— 3. manifest SHA 校验（M24 verifyReleaseCandidate 形状）+ 候选树围栏 ——
    const verifyCandidate = async (label, name) => {
      let verdict;
      try {
        verdict = await deps.verify(name);
      } catch (error) {
        return step(`verify_${label}`, false, `verify threw: ${error?.message ?? String(error)}`);
      }
      // 单一 step 聚合三类失败（SHA 不一致 / server 入口不可复核 / agentic 接缝缺席）
      const problems = [];
      if (verdict.ok !== true || (Array.isArray(verdict.mismatches) && verdict.mismatches.length > 0)) {
        problems.push(`mismatches: ${JSON.stringify(verdict.mismatches ?? [])}`);
      }
      if (verdict.hasServerEntry !== true) {
        problems.push('server entry not reviewable (scripts/serve-tango.mjs missing from manifest, or packaged package.json start points elsewhere)');
      }
      if (!Array.isArray(verdict.agenticAssets) || verdict.agenticAssets.length === 0) {
        problems.push('agentic assets empty (W13 web/agentic/** seam absent — pre-W13 candidate, not acceptable as the release candidate)');
      }
      const ok = problems.length === 0;
      step(`verify_${label}`, ok, ok
        ? `manifest SHA recompute clean (${verdict.checked} files, ${verdict.agenticAssets.length} agentic assets)`
        : problems.join('; '));
      if (ok) {
        report.candidates[label] = { ...report.candidates[label], verified: true, files: verdict.checked, agenticAssets: verdict.agenticAssets.length };
      }
      return ok;
    };
    const treeCandidate = async (label, name) => {
      let tree;
      try {
        tree = await deps.checkTree(name);
      } catch (error) {
        return step(`tree_${label}`, false, `checkTree threw: ${error?.message ?? String(error)}`);
      }
      for (const key of ['forbidden', 'extra', 'missing']) {
        const paths = Array.isArray(tree[key]) ? tree[key] : [];
        if (paths.length > 0) {
          return step(`tree_${label}`, false, `tree ${key}: ${JSON.stringify(paths)}`);
        }
      }
      return step(`tree_${label}`, true, 'candidate tree === manifest ∪ {manifest.json, package.json}, zero forbidden paths');
    };

    const previousVerified = await verifyCandidate('previous', previous);
    const currentVerified = await verifyCandidate('current', current);
    const previousTreeOk = await treeCandidate('previous', previous);
    const currentTreeOk = await treeCandidate('current', current);

    // —— 4. 当前候选：server 启动 + /api/status + /api/agentic/health（段内端口）——
    if (currentVerified && currentTreeOk) {
      const port = await deps.freePort(preferredPorts.current);
      const portInRange = Number.isInteger(port) && port >= segment.min && port <= segment.max;
      if (!step('service_current_port', portInRange, portInRange
        ? `release probe port ${port} inside ${segment.min}-${segment.max}`
        : `port ${String(port)} outside release segment ${segment.min}-${segment.max}`)) {
        step('service_current_start', false, 'no legal port — service not started');
        step('service_current_status', false, 'service not started');
        step('service_current_health', false, 'service not started');
      } else {
        let service = null;
        try {
          service = await deps.startService(current, port);
        } catch (error) {
          step('service_current_start', false, `startService threw: ${error?.message ?? String(error)}`);
        }
        if (service) {
          step('service_current_start', true, `candidate server listening on 127.0.0.1:${service.port}`);
          await probe('current', service, '/api/status', evaluateStatusProbe, 'service_current_status');
          await probe('current', service, '/api/agentic/health', evaluateHealthProbe, 'service_current_health');
          try {
            await service.close();
          } catch (error) {
            warnings.push(`current service close threw: ${error?.message ?? String(error)}`);
          }
        } else {
          step('service_current_status', false, 'service not started');
          step('service_current_health', false, 'service not started');
        }
      }
    } else {
      step('service_current_port', false, 'current candidate not verified — probes not run');
      step('service_current_start', false, 'current candidate not verified — probes not run');
      step('service_current_status', false, 'current candidate not verified — probes not run');
      step('service_current_health', false, 'current candidate not verified — probes not run');
    }

    // —— 5. 上一候选：回滚读取 + 服务行为复核 ——
    let rollbackBytes = null;
    try {
      rollbackBytes = await deps.readManifestBytes(previous);
    } catch (error) {
      warnings.push(`rollback manifest read threw: ${error?.message ?? String(error)}`);
    }
    report.rollback.manifestByteStable = rollbackBytes !== null && previousManifestBytes !== null
      && Buffer.compare(rollbackBytes, previousManifestBytes) === 0;
    step('rollback_manifest_bytes', report.rollback.manifestByteStable === true, report.rollback.manifestByteStable === true
      ? 'previous candidate manifest.json byte-stable across the newer build (rollback read-back)'
      : 'previous candidate manifest.json drifted after the newer build — rollback read-back broken');

    report.rollback.verifiedAgain = await verifyCandidate('previous_rollback', previous) && previousVerified;
    step('rollback_verify_previous', report.rollback.verifiedAgain === true, report.rollback.verifiedAgain === true
      ? 'previous candidate re-verifies (SHA + server entry + agentic seam)'
      : 'previous candidate failed re-verification');

    if (report.rollback.verifiedAgain === true && previousTreeOk) {
      const rollbackPort = await deps.freePort(preferredPorts.rollback);
      const rollbackPortInRange = Number.isInteger(rollbackPort) && rollbackPort >= segment.min && rollbackPort <= segment.max;
      if (!step('rollback_service_port', rollbackPortInRange, rollbackPortInRange
        ? `rollback probe port ${rollbackPort} inside ${segment.min}-${segment.max}`
        : `port ${String(rollbackPort)} outside release segment ${segment.min}-${segment.max}`)) {
        step('rollback_service_start', false, 'no legal port — rollback service not started');
        step('rollback_service_status', false, 'rollback service not started');
        step('rollback_service_health', false, 'rollback service not started');
      } else {
        let rollbackService = null;
        try {
          rollbackService = await deps.startService(previous, rollbackPort);
        } catch (error) {
          step('rollback_service_start', false, `startService threw: ${error?.message ?? String(error)}`);
        }
        if (rollbackService) {
          step('rollback_service_start', true, `rolled-back candidate server listening on 127.0.0.1:${rollbackService.port}`);
          const statusOk = await probe('previous-rollback', rollbackService, '/api/status', evaluateStatusProbe, 'rollback_service_status');
          const healthOk = await probe('previous-rollback', rollbackService, '/api/agentic/health', evaluateHealthProbe, 'rollback_service_health');
          report.rollback.serviceRechecked = statusOk && healthOk;
          try {
            await rollbackService.close();
          } catch (error) {
            warnings.push(`rollback service close threw: ${error?.message ?? String(error)}`);
          }
        } else {
          report.rollback.serviceRechecked = false;
          step('rollback_service_status', false, 'rollback service not started');
          step('rollback_service_health', false, 'rollback service not started');
        }
      }
    } else {
      report.rollback.serviceRechecked = false;
      step('rollback_service_port', false, 'previous candidate not re-verifiable — rollback service not started');
      step('rollback_service_start', false, 'previous candidate not re-verifiable — rollback service not started');
      step('rollback_service_status', false, 'previous candidate not re-verifiable — rollback service not started');
      step('rollback_service_health', false, 'previous candidate not re-verifiable — rollback service not started');
    }

    return report; // ok 在 finally 后统一裁决
  } finally {
    // —— 6. cleanup 必达：临时 release 不留候选（仅本门禁创建者，绝不碰外来目录）——
    if (created.length > 0) {
      try {
        await deps.cleanup([...created]);
        step('cleanup', true, `removed gate-created candidates: ${JSON.stringify(created)}`);
      } catch (error) {
        step('cleanup', false, `cleanup threw: ${error?.message ?? String(error)}`);
      }
      try {
        const restored = await deps.listCandidates();
        const beforeSet = JSON.stringify([...restored].sort());
        step('tree_restored', created.every(name => !restored.includes(name)), `dist-web candidate set after cleanup: ${beforeSet}`);
      } catch (error) {
        step('tree_restored', false, `listCandidates after cleanup threw: ${error?.message ?? String(error)}`);
      }
    }
    report.ok = steps.length > 0 && steps.every(entry => entry.ok === true);
  }
}
