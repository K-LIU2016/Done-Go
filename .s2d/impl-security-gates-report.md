# S2D-W8 M11 security-gates-report implementation

## Scope

This module implemented the read-only security review and gate evidence described by `.s2d/plan.md:120-125`. It did not modify the protected Done-Go or Done-Go-classic workspaces.

## Files

- `packages/donego-bridge/src/policy/approvals.mjs`
- `packages/donego-bridge/src/client/wss.mjs`
- `scripts/agentic/bridge-hub/pairing.mjs`
- `scripts/agentic/bridge-hub/routes.mjs`
- `tests/unit/agentic/bridge/bridge-cli.test.mjs`
- `tests/unit/agentic/bridge/bridge-wss-client.test.mjs`
- `tests/unit/agentic/bridge/security-gates.test.mjs`
- `tests/unit/agentic/bridge/security-contract.test.mjs`
- evidence: `/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w8-impl.md`
- final report: `/Users/chillbit/.claude-code-router/argus-cto/projects/donego/s2d-w8-report.md`

## Findings resolved

- Owner mismatch could consume another owner's one-time pairing code: fixed before the atomic used-at update.
- Command blacklist missed separated recursive/force rm flags and `git -C ... config`: fixed with regression tests.
- Deliverable glob checks were lexical only and could approve symlink escapes: fixed with default realpath ancestor resolution.
- Device token was included in the WSS URL query: removed; Authorization header is now the only transport in the client.

## Checks

- W8 bridge suite: 141/141 pass; line coverage 95.19%, function 86.66%; aggregate branch 77.23% is below 80% and is reported, while the requested line threshold is met.
- Frozen W0 contracts plus bridge consistency: 26/26 pass.
- `npm run verify:web`: 227/227 pass, exit 0.
- `npm run test:unit`: exit 1 with 6 unrelated repository failures; 1108/1116 pass. No bridge test failed.
- W0 merge succeeded at `569a019` after preserving untracked local `.s2d` metadata.
- Real Codex smoke: 2 startup attempts, 0 completed turns; no successful smoke is claimed.

## Commit sequence

`ed1472b`, `366b55e`, `569a019`, `dfa9b7a`.
