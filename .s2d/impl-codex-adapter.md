# S2D-W8 M6 codex-adapter implementation

## Scope

Implemented only the M6 Codex adapter paths from `.s2d/plan.md` §2 M6: `adapter.mjs`, `threads.mjs`, generated-binding provenance, and `generate-codex-ts.mjs`. The existing execute test had an out-of-scope fixture typo (`factory` was destructured as only `adapter`); that one-line test correction is included so the named adapter suite can run.

## Implementation

- `packages/donego-bridge/src/codex/adapter.mjs`
  - `initialize` request followed by `initialized` notification.
  - `thread/start` with mission cwd, approval policy, and developer instructions.
  - `thread/goal/set` with the contract DoD preserved in the test-facing `goal` field and generated-protocol `objective` field.
  - Read-only `plan` with `gpt-6-luna`, `low`, read-only sandbox, and structured output schema.
  - `execute` with selected model/effort and workspace-write policy restricted to the mission worktree; pause/defer are honored without a turn.
  - `steer`, `interrupt`, `fork`, `revert`, `review` protocol mapping; rate limit/model/thread list passthrough.
  - Approval server requests map approve/reject to immediate JSON-RPC responses and report Need without auto-reply.
- `packages/donego-bridge/src/codex/threads.mjs`: in-memory mission/thread registry with explicit `MISSION_NOT_FOUND` errors.
- `packages/donego-bridge/scripts/generate-codex-ts.mjs`: version probe, `codex app-server generate-ts` invocation, temporary output directory, atomic replacement, and failure cleanup.
- `packages/donego-bridge/src/codex/types/GENERATED.md`: records `codex-cli 0.163.0` and generation command.

## Checks run

1. RED before implementation (exact command):
   `cd '/Users/chillbit/Proj/Done & Go/s2d/w8-codex-bridge' && node --test tests/unit/agentic/bridge/codex-adapter-plan.test.mjs tests/unit/agentic/bridge/codex-adapter-execute.test.mjs tests/unit/agentic/bridge/codex-adapter-review.test.mjs`
   Output: exit 1; `ERR_MODULE_NOT_FOUND` for `src/codex/adapter.mjs`.
2. Focused implementation tests:
   `node --test tests/unit/agentic/bridge/codex-adapter-plan.test.mjs tests/unit/agentic/bridge/codex-adapter-execute.test.mjs tests/unit/agentic/bridge/codex-adapter-review.test.mjs`
   Output: `# tests 23`, `# pass 23`, `# fail 0`.
3. Named coverage check:
   `node --test --experimental-test-coverage tests/unit/agentic/bridge/codex-adapter-plan.test.mjs tests/unit/agentic/bridge/codex-adapter-execute.test.mjs tests/unit/agentic/bridge/codex-adapter-review.test.mjs`
   Output: all 23 pass; all-files line 97.81%, branch 86.63%, function 82.40%.
4. Full bridge glob check:
   `node --test --experimental-test-coverage tests/unit/agentic/bridge/*.test.mjs`
   Output: 123 tests, 122 pass, 1 fail. The only failure is the pre-existing missing M8 file `packages/donego-bridge/src/runtime/session.mjs`, reported as `ERR_MODULE_NOT_FOUND`; it is outside M6 ownership.
5. Generated binding smoke check:
   `node packages/donego-bridge/scripts/generate-codex-ts.mjs "$tmp/types"`
   Output: exit 0, no stdout/stderr; generated output contained `GENERATED.md`.
6. Syntax check:
   `node --check packages/donego-bridge/src/codex/adapter.mjs && node --check packages/donego-bridge/src/codex/threads.mjs && node --check packages/donego-bridge/scripts/generate-codex-ts.mjs`
   Output: exit 0.

## Commit

`31b76bb feat: add Codex mission adapter` with `Co-Authored-By: ZCode`.

## Notes

- `codex app-server generate-ts` was run against local `codex-cli 0.163.0`; generated v2 types show `sandboxPolicy`, `input`, `objective`, `beforeTurnId`, and review `target` protocol fields. Test compatibility aliases are retained only where the existing fixtures assert the earlier contract shape.
- Full suite cannot be green until M8 supplies `src/runtime/session.mjs`; no M8 files were modified.
- No real Codex mission was run; this M6 ask used the mandated mock fixtures only.
