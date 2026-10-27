# S2D-W8 M10 codex-smoke implementation

## Scope

Implemented the opt-in real Codex smoke test required by `.s2d/plan.md` M10 and BUILD-PLAN §3 W8-8. Only the M10-owned files were added: `tests/agentic/bridge/codex-smoke.mjs` and `tests/agentic/bridge/SMOKE-LOG.md`.

## Implementation

- `codex-smoke.mjs` is skipped unless `DONEGO_S2D_SMOKE=1`.
- Creates a temporary git repository and a per-mission `feat/donego-<missionId>` worktree; asserts the worktree fence.
- Uses the checked-in stdio JSON-RPC client and Codex adapter, with a completion-session shim that collects `item/completed` plus `turn/completed` notifications from Codex 0.163.0.
- Runs the mandated flow: structured read-only plan → `chooseModel` → smoke-pinned `gpt-6-luna`/`low` execute → node test → `review/start`.
- Counts real Codex turns and hard-fails after 10; records model, effort, elapsed time, result, plan, and choice in `SMOKE-LOG.md` without any credential material.
- Real protocol boundary removes adapter fixture aliases (`goal`, `sandbox`, `diff`) before sending requests to Codex 0.163.0.

## Checks run

1. `node --check tests/agentic/bridge/codex-smoke.mjs`: exit 0.
2. `node --test tests/agentic/bridge/codex-smoke.mjs`: exit 0; one test skipped because the opt-in variable was unset.
3. `node --test --experimental-test-coverage tests/unit/agentic/bridge/*.test.mjs`: exit 0; 135 tests passed, 0 failed; all-files line 97.68%, branch 80.77%, function 88.13%.
4. `DONEGO_S2D_SMOKE=1 node --test tests/agentic/bridge/codex-smoke.mjs`: attempted twice against local `codex-cli 0.163.0` in temporary repositories. Both attempts failed before the first completed turn: first `ActiveTurnOutputSchemaMismatch` (the adapter's generated-schema boundary did not accept the requested schema); second timed out waiting for Codex completion after 481689 ms. The failure is recorded in `SMOKE-LOG.md`; no passing real run is claimed.
5. `git diff --check`: exit 0.

## Coverage and external calls

The named M10 file has no ordinary unit test because it is an opt-in integration smoke. The bridge unit suite passes with 97.68% all-files line coverage, 80.77% branch coverage, and 88.13% function coverage. The two opt-in attempts created temporary repositories only; no real mission project was touched. The exact number of Codex turns observed by the smoke shim was 0 because both failures happened before a completed turn; Codex startup was invoked twice.

## Pending

- Real Codex flow remains unresolved in this environment: local app-server did not complete a turn, so the required successful plan/execute/test/review evidence is not available. No fake success is recorded.
- `SMOKE-LOG.md` is the latest failed-run record and contains no keys.
