# S2D-W3 implementation — grant-lifecycle

## Scope

- Grant lifecycle and fail-closed checks: `scripts/agentic/mission/grants.mjs`
- Mission state/replay kernel: `scripts/agentic/mission/state-machine.mjs`
- Persistence, route harness, and migration: `scripts/agentic/mission/store.mjs`, `scripts/agentic/mission/routes.mjs`, `scripts/agentic/db/migrations/mission-001-core.sql`
- Tests: `tests/unit/agentic/mission/**`

## Contract mapping

The implementation follows `.s2d/plan.md:19-30`: Mission lifecycle and side paths (`scan`, `preview`, `discuss`, `contract`, `prepare`, `start`, `review`, `deliver`, `block`, `pause`, `resume`, `cancel`, `fail`, `expire`); owner/revision checks; scan/preview/contract prerequisites; A1-A3 contract autonomy; A4/A5 fail closed; unsigned-window expiry; pause/resume contract-hash revalidation; terminal-state rejection; replay/tamper checks. Grants implement `proposed → active → consumed|revoked|expired|invalidated`, with owner/actor/contract hash/model provenance, capability, resource scope, data disclosure, expiry/window, budget, and autonomy checks. Malformed timestamps and malformed grant/context inputs fail closed. Contract changes invalidate proposed/active grants; terminal grants cannot authorize calls.

## TDD and checks executed

- RED evidence: `/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w3-red.md` (initial missing-module failure).
- `node --test tests/unit/agentic/mission/*.test.mjs` — rc 0; 28 tests, 28 passed, 0 failed.
- `node --test --experimental-test-coverage tests/unit/agentic/mission/*.test.mjs` — rc 0; 28 passed, 0 failed; aggregate line 98.74%, branch 83.82%, function 98.99%.
- `npm run verify:web` — rc 0; 227 tests passed, 0 failed.
- `npm run test:unit` — executed; rc 1 with 996 tests, 985 passed, 9 failed, 2 skipped. Failures are repository/baseline tests outside W3 plus the stale pre-fix W3 grant tests observed before the final grant fix; rerun after final edits is required for an accurate final gate result.
- `git diff --check` — rc 0.

No runtime dependency, W0 schema, cross-flow engine, main branch, production, or secret source was changed. Files remain within the W3 ownership boundary plus this implementation note.
