// W9 M2 verifier-domain · 命令结果纯文本解析（plan G1-M2-3）。
// result 来自注入的 runCommand mock：{ rc, stdout, timedOut? }。引擎绝不
// spawn、不联网（红线5）。优先级钉死：
//   timedOut === true → UNKNOWN（超时，结果不可知，优先于退出码）
//   rc !== 0          → FAIL + HIGH
//   rc === 0 且 stdout 可解析为 TAP 摘要：含 'not ok' 行或 '# fail >0' → FAIL+HIGH；
//     全部通过 → PASS
//   rc === 0 且无法解析（含空输出）→ UNKNOWN（解析失败不得升级，brief 裁决④）
// TAP 子集钉死：'1..N' 计划行 + 'ok'/'not ok' 行 + '# pass'/'# fail' 摘要行。

import { contractInvalid, isPlainObject } from './shape.mjs';

const PLAN_LINE = /^1\.\.\d+$/;
const TEST_LINE = /^(not\s+)?ok(?:\s|$)/;
const PASS_SUMMARY = /^#\s*pass\s+(\d+)/i;
const FAIL_SUMMARY = /^#\s*fail\s+(\d+)/i;

/** 解析 TAP 子集；structured=false 表示输出不具备任何 TAP 结构。 */
function parseTap(stdout) {
  let plan = false;
  let tests = 0;
  let notOk = 0;
  let passCount = 0;
  let failCount = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (PLAN_LINE.test(line)) {
      plan = true;
      continue;
    }
    const test = TEST_LINE.exec(line);
    if (test) {
      tests += 1;
      if (test[1]) notOk += 1;
      continue;
    }
    const pass = PASS_SUMMARY.exec(line);
    if (pass) {
      passCount = Number(pass[1]);
      continue;
    }
    const fail = FAIL_SUMMARY.exec(line);
    if (fail) {
      failCount = Number(fail[1]);
    }
  }
  const structured = plan || tests > 0 || passCount > 0 || failCount > 0;
  return { structured, tests, notOk, passCount, failCount };
}

export function parseCommandResult(result, ref) {
  if (!isPlainObject(result)) throw contractInvalid('result must be an object { rc, stdout, timedOut? }');
  if (!Number.isInteger(result.rc)) throw contractInvalid('result.rc must be an integer');
  if (typeof result.stdout !== 'string') throw contractInvalid('result.stdout must be a string');
  if (result.timedOut !== undefined && typeof result.timedOut !== 'boolean') {
    throw contractInvalid('result.timedOut must be a boolean when present');
  }
  if (typeof ref !== 'string' || ref.length === 0) throw contractInvalid('ref must be a non-empty string');

  if (result.timedOut === true) {
    return { kind: 'command-result', ref, status: 'UNKNOWN', severity: 'MEDIUM', reason: 'command timed out; outcome unknowable' };
  }
  if (result.rc !== 0) {
    return { kind: 'command-result', ref, status: 'FAIL', severity: 'HIGH', reason: `exit code ${result.rc}` };
  }
  const tap = parseTap(result.stdout);
  if (!tap.structured) {
    return { kind: 'command-result', ref, status: 'UNKNOWN', severity: 'MEDIUM', reason: 'rc 0 but stdout has no parseable TAP structure' };
  }
  if (tap.notOk > 0 || tap.failCount > 0) {
    return {
      kind: 'command-result',
      ref,
      status: 'FAIL',
      severity: 'HIGH',
      reason: `TAP failures: not ok ${tap.notOk}, # fail ${tap.failCount}`,
    };
  }
  return {
    kind: 'command-result',
    ref,
    status: 'PASS',
    severity: 'LOW',
    reason: `TAP ok ${tap.tests - tap.notOk}, # pass ${tap.passCount}`,
  };
}
