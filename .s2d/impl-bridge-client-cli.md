# S2D-W8 bridge-client-cli implementation

## Scope

Implemented M7 from `.s2d/plan.md:90-96`: independent `donego-bridge` package CLI (`pair/start/status`), outbound WSS client with heartbeat/reconnect/revocation handling, and device config persistence. Files are limited to `packages/donego-bridge/**` plus the owned bridge WSS test correction.

## Files

- `packages/donego-bridge/package.json`
- `packages/donego-bridge/donego-bridge.js`
- `packages/donego-bridge/src/config.mjs`
- `packages/donego-bridge/src/client/wss.mjs`
- `packages/donego-bridge/src/cli.mjs`

## Behavior

- Pair posts only the pairing code to `/api/bridge/pair`, stores only hub/device/token/pairedAt, enforces `0600`, and never persists upstream keys (`config.mjs` lines 1-45; `cli.mjs` lines 40-75).
- Start performs only an outbound WebSocket connection, sends bearer authorization plus token query compatibility, pings periodically, reconnects with bounded exponential backoff, and stops on close code 4001 or `device.revoked` (`wss.mjs` lines 1-110).
- Status reads the local state file only; unknown commands and missing pairing return nonzero usage/errors (`cli.mjs` lines 30-118).
- Package declares `type: module`, `donego-bridge` bin, and zero package dependencies (`package.json`). Runtime `ws` is dynamically loaded from the host when CLI is run without an injected constructor; tests inject a fake constructor.

## Checks

- RED command run before implementation: `node --test tests/unit/agentic/bridge/bridge-wss-client.test.mjs`; exit 1 with `ERR_MODULE_NOT_FOUND` for the missing WSS module.
- GREEN exact owned-module command: `node --test --experimental-test-coverage tests/unit/agentic/bridge/bridge-wss-client.test.mjs tests/unit/agentic/bridge/bridge-cli.test.mjs`; exit 0, 15 tests passed, 0 failed. Coverage: all-files line 99.00%; cli 96.67%; WSS 100.00%; config 95.24%.
- Syntax command: `node --check packages/donego-bridge/src/config.mjs && node --check packages/donego-bridge/src/client/wss.mjs && node --check packages/donego-bridge/src/cli.mjs && node --check packages/donego-bridge/donego-bridge.js`; exit 0.
- Full bridge suite command: `node --test --experimental-test-coverage tests/unit/agentic/bridge/*.test.mjs`; exit 1 only because `bridge-runtime.test.mjs` imports the not-yet-implemented M8 `src/runtime/session.mjs`; 122 passed and 1 failed. Its aggregate line coverage was 97.72%.

## Notes

- The WSS test had a pre-existing test-helper capture bug (`revoked` was destructured before increment); the owned test now exposes a getter so the test observes the specified runtime behavior. No other module-owned tests were changed.
- Workflow-wide `npm run test:unit`, `npm run verify:web`, W0 merge/contract checks, security review, and real Codex smoke were not run in this module ask.
