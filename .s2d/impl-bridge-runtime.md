# S2D-W8 bridge-runtime implementation

## Scope

Implemented M8 `packages/donego-bridge/src/runtime/session.mjs` only, as assigned by `.s2d/plan.md` §2 M8. The runtime coordinates mission plan/execute/steer/interrupt/resume/fork/revert/review/status, one worktree and Codex thread per mission, selected-model/quota trace events, Need forwarding, offline blocked events, and contract-hash validation before resume.

## Implementation

- `packages/donego-bridge/src/runtime/session.mjs`
  - `createBridgeRuntime({ makeAdapter, worktrees, repoRoot, chooseModel, chooseReviewModel, sendEvent, stateFile, now, log })` with dependency injection for tests.
  - Atomic `0600` state checkpoint storing mission worktree, branch, contract hash, plan, thread ID, execution/review metadata; no upstream keys.
  - Same-process recovery fallback plus persisted state-file recovery; calls adapter `adoptThread` before resumed operations.
  - `hashContract` uses stable recursive key ordering and SHA-256 per PRD §8.1.
  - Offline state emits `blocked` with `need: 打开本机桥`; execute emits model/effort/reason/quota snapshot trace.

## Checks run

1. Before implementation, exact named runtime check:
   `cd '/Users/chillbit/Proj/Done & Go/s2d/w8-codex-bridge' && node --test tests/unit/agentic/bridge/bridge-runtime.test.mjs --experimental-test-coverage`
   Output: exit 1; `ERR_MODULE_NOT_FOUND` for `packages/donego-bridge/src/runtime/session.mjs`.
2. Focused runtime coverage check:
   `node --test --experimental-test-coverage tests/unit/agentic/bridge/bridge-runtime.test.mjs`
   Output: `# tests 11`, `# pass 11`, `# fail 0`; runtime line coverage `93.59%`; all-files line coverage `96.33%`.
3. Full W8 bridge unit check:
   `node --test --experimental-test-coverage tests/unit/agentic/bridge/*.test.mjs`
   Output: `# tests 133`, `# pass 133`, `# fail 0`; all-files line coverage `97.35%`, branch `78.54%`, function `86.32%`.
4. Diff hygiene:
   `git diff --check`
   Output: exit 0.

## Commit

Pending: this module was not committed at the time of this file's creation; commit must use the required flock/pathspec procedure and message format.

## Notes

- No real Codex call was made; runtime tests use the existing fake adapter and in-process fixtures, consistent with the task's mock-only unit-test rule.
- No runtime dependency was added. Only the assigned runtime source file was added; the existing untracked `.s2d` notes from other modules were not modified.
