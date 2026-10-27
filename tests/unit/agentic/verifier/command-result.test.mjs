// W9 M2 verifier-domain · command-result 单测（TDD RED 先行）
//
// 本文件是 `scripts/agentic/verifier/command-result.mjs` 的接口规约：
//   parseCommandResult(result, ref) → check
//   - result: { rc: number, stdout: string, timedOut?: boolean }（来自注入的 runCommand mock，引擎绝不 spawn）。
//   - 返回 { kind: 'command-result', ref, status, severity, reason }，优先级钉死：
//       timedOut === true            → UNKNOWN（超时，结果不可知）
//       rc !== 0                     → FAIL + severity HIGH
//       rc === 0 且 stdout 可解析为 TAP 摘要：
//         含 'not ok' 行 或 '# fail >0' → FAIL + HIGH
//         全部通过（'# pass N' / 'ok' 行且无失败） → PASS
//       rc === 0 且 stdout 无法解析（含空输出）→ UNKNOWN（解析失败不得升级，brief 裁决④）
//   - TAP 子集钉死：'1..N' 计划行 + 'ok'/'not ok' 行 + '# pass'/'# fail' 摘要行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandResult } from '../../../../scripts/agentic/verifier/command-result.mjs';

const TAP_PASS = '1..2\nok 1 unit\nok 2 contracts\n# pass 2\n# fail 0\n';
const TAP_FAIL = '1..2\nok 1 unit\nnot ok 2 contracts\n# pass 1\n# fail 1\n';

test('rc 0 with an all-pass TAP summary passes', () => {
  const check = parseCommandResult({ rc: 0, stdout: TAP_PASS }, 'node --test tests/');
  assert.equal(check.kind, 'command-result');
  assert.equal(check.ref, 'node --test tests/');
  assert.equal(check.status, 'PASS');
});

test('rc 0 with TAP failures fails HIGH', () => {
  const check = parseCommandResult({ rc: 0, stdout: TAP_FAIL }, 'cmd');
  assert.equal(check.status, 'FAIL');
  assert.equal(check.severity, 'HIGH');
});

test('non-zero exit code fails HIGH regardless of stdout', () => {
  const check = parseCommandResult({ rc: 1, stdout: 'everything looks great\n' }, 'cmd');
  assert.equal(check.status, 'FAIL');
  assert.equal(check.severity, 'HIGH');
});

test('timeout is UNKNOWN and outranks the exit code', () => {
  const rc0 = parseCommandResult({ rc: 0, stdout: TAP_PASS, timedOut: true }, 'cmd');
  assert.equal(rc0.status, 'UNKNOWN');
  const nonzero = parseCommandResult({ rc: 1, stdout: '', timedOut: true }, 'cmd');
  assert.equal(nonzero.status, 'UNKNOWN');
});

test('rc 0 with unparseable stdout stays UNKNOWN', () => {
  assert.equal(parseCommandResult({ rc: 0, stdout: '随便一段文字，没有 TAP 结构' }, 'cmd').status, 'UNKNOWN');
});

test('rc 0 with empty stdout stays UNKNOWN', () => {
  assert.equal(parseCommandResult({ rc: 0, stdout: '' }, 'cmd').status, 'UNKNOWN');
});

test('missing rc or non-string stdout is contract-invalid input', () => {
  assert.throws(() => parseCommandResult({ stdout: TAP_PASS }, 'cmd'), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => parseCommandResult({ rc: 0 }, 'cmd'), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => parseCommandResult({ rc: 0, stdout: 123 }, 'cmd'), (e) => e.code === 'CONTRACT_INVALID');
});
