# S2D-W8 M2 bridge-hub implementation

## Scope

Implemented only the W8 bridge-hub paths specified by `.s2d/plan.md` §2 M2 (read at lines 49–56): pairing service, device registry, HTTP/WSS routes, composition factory, and the bridge migration.

## Files

- `scripts/agentic/db/migrations/bridge-001-devices.sql`
- `scripts/agentic/bridge-hub/pairing.mjs`
- `scripts/agentic/bridge-hub/devices.mjs`
- `scripts/agentic/bridge-hub/routes.mjs`
- `scripts/agentic/bridge-hub/hub.mjs`

## Behavior implemented

- Pairing codes are generated as human-input-safe alphanumeric values, expire after 10 minutes, are single-use, and are persisted only as SHA-256 digests (`pairing.mjs:5-39`).
- Device credentials use 32 random bytes, are persisted only as SHA-256 digests, resolve to owner/device metadata, and support immediate owner-scoped revocation (`devices.mjs:4-47`).
- `createBridgeRoutes` is an unmounted route factory. It handles authenticated pairing and owner-scoped revocation, WSS Bearer authentication, owner-targeted delivery, ping heartbeats, message size enforcement, bridge events, and revoke-to-close linkage (`routes.mjs:40-164`).
- The migration creates `bridge_pairings` and `bridge_devices`, including the required `owner_id`, digest indexes, and revocation fields (`bridge-001-devices.sql:1-23`).

## Checks run

Exact module coverage command:

```text
node --test --experimental-test-coverage tests/unit/agentic/bridge/hub-pairing.test.mjs tests/unit/agentic/bridge/hub-devices.test.mjs tests/unit/agentic/bridge/hub-routes.test.mjs
```

Result: exit 0; 20 tests passed, 0 failed. Coverage report: bridge-hub line 98.61% overall (devices 100.00%, pairing 100.00%, routes 95.15%); functions 88.79% overall. This satisfies the ≥80% line-coverage requirement. The exact command/output is recorded in `argus-cto/projects/donego/evidence/s2d-w8-impl.md`.

Commit: `7db4922900116ced6bb1200b3d72c3d751a5659f` (`feat: implement bridge hub pairing and websocket routes`, with `Co-Authored-By: ZCode`).

## Not run / pending outside this module

- Full `npm run test:unit`, `npm run verify:web`, W0 contract merge, security review, and real Codex smoke are not claimed here; they belong to the workflow-level gates or other W8 modules.
- No runtime dependency was added; the route tests use the existing root `ws` dependency.
