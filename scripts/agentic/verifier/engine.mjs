// W9 M2 verifier-domain · 核验引擎（plan G1-M2-2）。
// verify(artifact, dod, { checkers?, runCommand, clock }) → Promise<verdict>
// - 检查器全部可注入：checkers = { dod?, citation?, command?, injection? }，
//   每个为 (artifact, dod, ctx) => Check[]；提供某键则整体覆盖内置实现。
// - runCommand 是注入的 mock（{ rc, stdout, timedOut }）；引擎绝不 spawn、
//   不联网、不读 key（红线5）。clock 必须显式注入，缺失即拒绝（红线6）。
// - overall 钉死：任一 FAIL → FAILED；否则任一 UNKNOWN → UNKNOWN；
//   否则全部 PASS 且 checks 非空且至少有一条 dod-item check → VERIFIED；
//   其余（checks 为空、或没有任何 DoD 核验发生）→ UNKNOWN——没有 DoD 核验
//   就没有免费 VERIFIED（brief 裁决④、engine 测试 'no free VERIFIED'）。
// - checker 抛异常或返回坏形状 → 该 check 记 UNKNOWN，绝不升级、不崩溃。

import { checkDod } from './dod-checker.mjs';
import { checkCitations } from './citation-checker.mjs';
import { parseCommandResult } from './command-result.mjs';
import { checkInjection } from './injection-marker.mjs';
import {
  CHECK_KINDS,
  contractInvalid,
  evidenceOf,
  isIsoDateTime,
  isPlainObject,
  isValidCheck,
} from './shape.mjs';

const KIND_FOR_CHECKER = {
  dod: 'dod-item',
  citation: 'citation',
  command: 'command-result',
  injection: 'injection-marker',
};

function unknownCheck(kind, ref, reason) {
  return { kind, ref, status: 'UNKNOWN', severity: 'HIGH', reason };
}

/** checker 产物逐条守护：坏形状的 check 就地降级为 UNKNOWN（fail-closed）。 */
function coerceChecks(kind, produced) {
  if (!Array.isArray(produced)) {
    return [unknownCheck(kind, `checker:${kind}`, `checker "${kind}" did not return an array`)];
  }
  return produced.map((check) => {
    if (isValidCheck(check)) return check;
    const keptKind = isPlainObject(check) && CHECK_KINDS.includes(check.kind) ? check.kind : kind;
    const keptRef = isPlainObject(check) && typeof check.ref === 'string' && check.ref.length > 0 ? check.ref : `checker:${kind}`;
    return { kind: keptKind, ref: keptRef, status: 'UNKNOWN', severity: 'HIGH', reason: `checker "${kind}" returned a malformed check` };
  });
}

/** 内置命令检查：evidence 中 type='test-run' 的条目，每条跑一次注入的 runner。 */
async function builtinCommandChecks(artifact, ctx) {
  const evidence = evidenceOf(artifact);
  const checks = [];
  for (const entry of evidence) {
    if (!entry || entry.type !== 'test-run') continue;
    const uri = typeof entry.uri === 'string' ? entry.uri : null;
    const ref = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : 'test-run';
    if (!uri || uri.length === 0) {
      checks.push({
        kind: 'command-result',
        ref,
        status: 'UNKNOWN',
        severity: 'HIGH',
        reason: 'test-run evidence has no runnable command uri',
      });
      continue;
    }
    if (typeof ctx.runCommand !== 'function') {
      checks.push(unknownCheck('command-result', uri, 'no command runner injected; cannot execute test-run evidence'));
      continue;
    }
    try {
      const result = await ctx.runCommand(uri);
      checks.push(parseCommandResult(result, uri));
    } catch (error) {
      checks.push(unknownCheck('command-result', uri, `command runner failed: ${error?.message ?? error}`));
    }
  }
  return checks;
}

/** 内置注入扫描：artifact.title 与每条 evidence 的 title/detail，聚合为一个 check
 *  （任一命中即 FAIL+HIGH，ref 指向首个命中的来源；全部干净 → PASS；
 *  无任何可扫文本 → UNKNOWN，不送免费 PASS）。 */
function builtinInjectionChecks(artifact) {
  const sources = [{ ref: 'title', text: artifact?.title }];
  evidenceOf(artifact).forEach((entry, index) => {
    if (!entry) return;
    sources.push({ ref: `evidence[${index}].title`, text: entry.title });
    sources.push({ ref: `evidence[${index}].detail`, text: entry.detail });
  });
  const scanned = sources.filter((source) => typeof source.text === 'string');
  if (scanned.length === 0) {
    return [unknownCheck('injection-marker', 'artifact-scan', 'no text was available to scan for injection markers')];
  }
  const checks = scanned.map((source) => checkInjection(source.text, source.ref));
  const hit = checks.find((check) => check.status === 'FAIL');
  if (hit) return [hit];
  return [{
    kind: 'injection-marker',
    ref: 'artifact-scan',
    status: 'PASS',
    severity: 'LOW',
    reason: `no instruction-style injection pattern found across ${scanned.length} scanned text(s)`,
  }];
}

export async function verify(artifact, dod, options = {}) {
  if (!isPlainObject(artifact)) throw contractInvalid('artifact must be an object');
  if (typeof artifact.id !== 'string' || artifact.id.length === 0) {
    throw contractInvalid('artifact.id must be a non-empty string');
  }
  if (!Number.isInteger(artifact.version) || artifact.version < 1) {
    throw contractInvalid('artifact.version must be an integer >= 1');
  }
  if (!Array.isArray(dod) || dod.some((item) => typeof item !== 'string')) {
    throw contractInvalid('dod must be an array of strings');
  }
  const { checkers = {}, runCommand, clock } = options;
  if (!clock || typeof clock.now !== 'function') {
    throw contractInvalid('clock must be injected ({ now() }); business paths must not read the wall clock');
  }
  const ctx = { runCommand, clock };

  const builtins = {
    dod: (a, d) => checkDod(a, d),
    citation: (a) => checkCitations(a),
    command: (a, _d, c) => builtinCommandChecks(a, c),
    injection: (a) => builtinInjectionChecks(a),
  };
  const checks = [];
  for (const name of ['dod', 'citation', 'command', 'injection']) {
    const fn = typeof checkers[name] === 'function' ? checkers[name] : builtins[name];
    let produced;
    try {
      produced = await fn(artifact, dod, ctx);
    } catch (error) {
      checks.push(unknownCheck(KIND_FOR_CHECKER[name], `checker:${name}`, `checker "${name}" threw: ${error?.message ?? error}`));
      continue;
    }
    checks.push(...coerceChecks(KIND_FOR_CHECKER[name], produced));
  }

  const ranAt = clock.now();
  if (!isIsoDateTime(ranAt)) throw contractInvalid('clock.now() must return an ISO date-time string');

  const hasFail = checks.some((check) => check.status === 'FAIL');
  const hasUnknown = checks.some((check) => check.status === 'UNKNOWN');
  const hasDodCheck = checks.some((check) => check.kind === 'dod-item');
  const overall = hasFail
    ? 'FAILED'
    : (hasUnknown || checks.length === 0 || !hasDodCheck) ? 'UNKNOWN' : 'VERIFIED';
  return { artifactId: artifact.id, version: artifact.version, overall, checks, ranAt };
}
