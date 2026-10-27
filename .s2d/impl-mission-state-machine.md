# S2D-W3 implementation — mission-state-machine

## Scope

- Mission transition/replay kernel: `scripts/agentic/mission/state-machine.mjs`
- Grant lifecycle and fail-closed checks: `scripts/agentic/mission/grants.mjs`
- W3 persistence/route/migration implementation already present on this branch and exercised by the module suite:
  - `scripts/agentic/db/migrations/mission-001-core.sql`
  - `scripts/agentic/mission/store.mjs`
  - `scripts/agentic/mission/routes.mjs`
- Tests: `tests/unit/agentic/mission/**`

## Contract mapping implemented

Mission follows the frozen lifecycle and side paths from `.s2d/plan.md:19-23`: scan/preview/discuss/contract/prepare/start/review/deliver, block/pause/resume/cancel/fail/expire. Transitions validate owner and expected revision, prerequisites, A1–A3 contract autonomy, A4/A5 fail-closed behavior, unsigned-window expiration, pause/resume contract hash, and terminal-state recovery. Accepted transitions emit replayable events; tampered event order/revision/state is rejected.

Grant behavior follows `.s2d/plan.md:26-30`: proposed/active/consumed/revoked/expired/invalidated; owner/actor/contract hash/model provenance, capabilities, resource scope, disclosure, time window, budget, and autonomy checks are fail-closed. Invalid timestamps return `GRANT_INVALID`; contract changes invalidate proposed or active grants; consumed/revoked/expired/invalidated grants cannot authorize calls.

## TDD and checks

- RED evidence: `/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w3-red.md` records the initial missing-module failure.
- `node --test tests/unit/agentic/mission/*.test.mjs` — **rc 0**, 26 tests, 26 passed, 0 failed.
- `node --test --experimental-test-coverage tests/unit/agentic/mission/*.test.mjs` — **rc 0**, 26 passed; aggregate line 98.68%, branch 82.87%, function 98.97%.
- `npm run verify:web` — **rc 0**, 227 passed, 0 failed.
- `npm run test:unit` — run after W3 fixes; report its exact baseline failures separately if any. W3 module tests are included only if explicitly collected by the repository runner.
- `git diff --check` — **rc 0**.

No runtime dependency, W0 schema, cross-flow engine, main branch, production, or secret source was changed.
