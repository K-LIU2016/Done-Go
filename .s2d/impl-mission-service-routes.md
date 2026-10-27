# S2D-W3 implementation — mission-service-routes

## Scope and contract mapping

- Mission service and route harness: `scripts/agentic/mission/routes.mjs:1-143`.
- Owner-scoped persistence and optimistic revisions: `scripts/agentic/mission/store.mjs:9-69`.
- Grant lifecycle is routed through the existing fail-closed kernel in `scripts/agentic/mission/grants.mjs:16-76`; statuses follow the frozen grant contract and contract changes invalidate proposed/active grants.
- Mission transitions and replay remain in `scripts/agentic/mission/state-machine.mjs:1-105`; route transitions append replayable events and store idempotent command results.
- Migration boundary remains `scripts/agentic/db/migrations/mission-001-core.sql:0-61`; no W0 schema or `serve-tango` mount was changed.

## Negative paths covered

`tests/unit/agentic/mission/routes.test.mjs:25-116` covers authentication failure, duplicate creation/conflict, owner isolation, stale revision conflict, rejected-command replay, cross-owner event hiding, grant owner isolation, unknown model rejection, and route boundary handling. Existing mission/grant tests cover terminal recovery, timeout/window expiry, pause/resume hash mismatch, malformed timestamps, capability/scope/disclosure/budget denial, A4/A5 fail closed, revoke, consume, and contract-change invalidation.

## Checks run in this ask

- `cd '/Users/chillbit/Proj/Done & Go/s2d/w3-mission' && node --test tests/unit/agentic/mission/*.test.mjs`: rc 0; 31 tests, 31 passed, 0 failed.
- `cd '/Users/chillbit/Proj/Done & Go/s2d/w3-mission' && node --test --experimental-test-coverage tests/unit/agentic/mission/*.test.mjs`: rc 0; 31 passed; all-files line 98.40%, branch 82.74%, functions 100%; module line coverage: grants 100%, state machine 100%, store 100%, routes 94.20%.
- `npm run verify:web`: rc 0; 227 passed, 0 failed.
- `npm run test:unit`: rc 1; 1001 total, 992 passed, 7 failed, 2 skipped. Failures are outside W3: two React layout/style tests, one AI stream baseline, two collaboration password baseline tests, and two voice-pipeline tests (missing optional `sherpa-onnx-node` / gateway baseline). W3 tests are green.
- `node --check scripts/agentic/mission/grants.mjs && node --check scripts/agentic/mission/state-machine.mjs && node --check scripts/agentic/mission/store.mjs && node --check scripts/agentic/mission/routes.mjs && git diff --check`: rc 0.

## Scope/security

No runtime dependency, external call, gateway key, `.env`, production, main branch, or forbidden cross-flow directory was used. The worktree was clean before this implementation edit; final commit is pending flock. Frozen W0 files were not changed by this module edit (the branch already contains the inherited W0 baseline).

## UNKNOWN / pending

The full repository unit gate remains non-green due to the seven unrelated failures listed above. No Playwright run was needed: this is a server-side harness module and no browser spec is assigned in `.s2d/plan.md`. Push was not performed; only the requested local commit is pending.
