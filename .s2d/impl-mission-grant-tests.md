# S2D-W3 mission-grant-tests implementation

## Scope and contract mapping

- Mission transition/replay and contract-version invalidation seam: `scripts/agentic/mission/state-machine.mjs:3-14,24-48,53-107`. The lifecycle follows `.s2d/plan.md:19-30`; contracted missions accept a changed contract hash as a new version, while unchanged hashes fail closed (`CONTRACT_UNCHANGED`). Pause/block recovery requires the existing contract hash.
- Grant lifecycle and fail-closed authorization: `scripts/agentic/mission/grants.mjs:1-84`. Grant shape, owner/actor, explicit resolved model, contract hash, capability, resource scope, disclosure, window, budget, expiry, A4 confirmation and A5 prohibition are checked before authorization. Terminal grants cannot authorize calls.
- Owner/revision/idempotency persistence and recovery: `scripts/agentic/mission/store.mjs:10-67`; migration boundary is `scripts/agentic/db/migrations/mission-001-core.sql:1-61` (pre-existing, unchanged in this ask). Route harness and contract binding are `scripts/agentic/mission/routes.mjs:40-128`; route no longer fills a missing contract hash from stored grant (`:110`), so omitted/mismatched hashes fail closed.

## TDD changes

Tests were extended before the corresponding hardening edits in the implementation: malformed grant shape and empty model rejection (`tests/unit/agentic/mission/grants.test.mjs:49-68,113-122`), contract-version transition (`tests/unit/agentic/mission/state-machine.test.mjs:54-67`), stale grant writes and owner isolation (`tests/unit/agentic/mission/persistence.test.mjs:47-58`), malformed mission input and route contract binding (`tests/unit/agentic/mission/routes.test.mjs:42-60,102-126`).

## Checks executed

- `cd '/Users/chillbit/Proj/Done & Go/s2d/w3-mission' && node --test tests/unit/agentic/mission/*.test.mjs`: rc 0; 36 tests, 36 passed, 0 failed, 0 skipped.
- `cd '/Users/chillbit/Proj/Done & Go/s2d/w3-mission' && node --test --experimental-test-coverage tests/unit/agentic/mission/*.test.mjs`: rc 0; 36 passed, 0 failed; aggregate line 98.51%, branch 85.53%, functions 100%. Module line coverage: grants 100%, state-machine 100%, store 100%, routes 94.37%.
- `cd '/Users/chillbit/Proj/Done & Go/s2d/w3-mission' && npm run verify:web`: rc 0; 227 tests passed, 0 failed, 0 skipped.
- `cd '/Users/chillbit/Proj/Done & Go/s2d/w3-mission' && npm run test:unit`: rc 1; 1006 tests, 997 passed, 7 failed, 2 skipped. The seven failures are pre-existing/outside W3: `src/screens/s04-plan/metric-layout.test.ts`, `src/styles/design-system.test.ts`, typed content delta stream, collaboration permissions, AI shared fields, multi-clause recording, and voice-pipeline gateway. W3 module tests are green in the named module command above.
- `node --check` for all four mission modules plus `git diff --check`: rc 0, no output.
- Scope/freeze audit: `git diff --name-only` returned only `scripts/agentic/mission/**` and `tests/unit/agentic/mission/**`; current `contracts/agentic/FROZEN` is `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`. No schema, `.env`, gateway key, production, main, classic, engine, or dependency files changed.

## UNKNOWN / pending

- No Playwright spec was assigned by `.s2d/plan.md`; not run. No external calls or real gateway key were used. Full repository unit gate remains non-green due to the seven failures listed above. Actor/model provenance is represented by explicit `resolvedModel`; unresolved/empty model is rejected (`MODEL_UNKNOWN`). Cross-flow consumers receive the state/grant seam; W3 does not mount routes into `serve-tango`.
