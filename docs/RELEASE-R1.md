# Done&Go R1 release runbook

This runbook is the release boundary for R1. The default preflight is offline and read-only. It does not start a service, restart a process, deploy a connector, install dependencies, push Git changes, or print secret values.

## Release target and modes

The expected production shape is configurable in `scripts/release-preflight.mjs` and defaults to:

| Check | Expected value | Evidence rule |
| --- | --- | --- |
| Bind address | `127.0.0.1` | A configured value must match; an absent value is `UNKNOWN`. |
| Port | `17507` | A configured value must match; a local listener is checked only with `--runtime` or `--health`. |
| Public origin | `https://donego.udify.fun` | The value is checked for HTTPS and exact match when configured. The default preflight does not make a public request. |
| Service manager | systemd user service | A unit is checked when `RELEASE_SERVICE_UNIT`, `DONEGO_SERVICE_UNIT`, or `RELEASE_EXPECTED_SERVICE_UNIT` is configured; otherwise the user manager is observed without guessing a unit name. |
| Demo flag | `TANGO_DEMO_MODE=1` | This is an explicit deployment expectation. The existing production-readiness check still treats demo mode as a production blocker, so a demo-mode result cannot be called production proof. |
| LiteLLM URL | `http://127.0.0.1:4000/v1/chat/completions` | The URL is compared when `LITELLM_URL` or `TANGO_LITELLM_URL` is present. No provider request is made. |
| LiteLLM model | `auto` | The model is compared when `LITELLM_MODEL`, `TANGO_LITELLM_MODEL`, or `TANGO_AI_MODEL` is present. |

Run the default check from the repository root:

```sh
node scripts/release-preflight.mjs
```

The command performs Git state and identity checks, dependency presence checks, Node syntax checks, unit command readiness checks, a temporary static build with SHA-256 manifest verification, environment-name checks, AI flag and cap/limit shape checks, service-unit expectations, and rollback-target checks. It reports `VERIFIED`, `UNKNOWN`, `FAIL`, or `BLOCKED`. Missing production values are reported by name and presence only; their values are never printed.

`--runtime` adds a read-only TCP probe to the configured localhost bind and port. `--health` adds the TCP probe and a read-only HTTP request to the localhost root. Neither option starts or changes a service. Public-origin reachability, email delivery, authentication isolation, user flows, and provider health remain `UNKNOWN` until separately evidenced.

## Freeze and heavy lock

The preflight refuses release work during `00:30-03:30 Asia/Shanghai` and while `heavy.lock` exists at the repository root. In either case it reports `BLOCKED`, skips the temporary build, and exits with status `2`. Do not delete or bypass a lock to force a release. A lock is a release-process record and should include the candidate commit, build or manifest identifier, freeze time, operator, target mode, and current verification state.

Outside the freeze window, the preflight build is written below the system temporary directory and removed after verification. It never replaces `dist-web`, a running service, a database, or a user-data directory.

## Candidate steps

1. Confirm the worktree is clean, the branch and commit are recorded, and Git identity is configured.
2. Run `node --check scripts/release-preflight.mjs`.
3. Run the directly related tests:

   ```sh
   node --test tests/unit/tango-release.test.mjs tests/unit/tango-release-rollback.test.mjs tests/unit/tango-production-readiness.test.mjs
   ```

4. Run `node scripts/release-preflight.mjs` and retain its JSON output with the commit and timestamp.
5. Build the candidate with `npm run build` only outside the freeze window and only when no `heavy.lock` is present. Keep the resulting `dist-web/donego-*` directory and `manifest.json` together.
6. For the local product mode, use `npm start` or `npm run start:web` and inspect `http://localhost:5207/#today` as documented in [DEPLOYMENT.md](./DEPLOYMENT.md). Confirm core entry, time sorting, completion recording, personal time, review, import/export, and voice failure fallback.
7. For a target service, inspect the configured systemd user unit and use `--runtime` or `--health` only against the already running loopback service. Do not restart it as part of preflight.
8. Before any public connector is enabled, separately verify login, logout, invalid sessions, cross-site writes, two-user data isolation, administrator settings, deep-link refresh, real email receipt, and provider behavior. A root HTTP `200` is only a reachability fact.

The known public target is `https://donego.udify.fun`. The application must remain on loopback and the target port must be `17507` unless the expected values are explicitly overridden. Do not expose another local management service, and do not use a shared or unqualified service installation.

## Secrets and logs

The preflight records environment variable names and whether a value is present. It does not record `TANGO_AUTH_SECRET`, Resend or SMTP credentials, LiteLLM keys, cookies, verification codes, request headers, or user data. Keep those values in the service environment, outside the repository and build output. The release artifact must not contain credentials, browser data, or user databases.

Production readiness is a configuration check only. It does not verify email delivery, database persistence across restart, session invalidation, public reachability, authentication isolation, or external AI availability. Those claims need their own evidence.

## Rollback

Set `RELEASE_ROLLBACK_TARGET` (or `DONEGO_ROLLBACK_TARGET`) to the previous verified release directory or its `manifest.json`. The preflight verifies only that the target is a Done&Go manifest with file metadata; it does not switch traffic or alter files.

### Rollback target identity (git anchor)

The R1 rollback anchor is a git commit, not only a build directory. The canonical anchor is recorded by the branch `rollback/prod-20261023-7fa444d` and is the previous verified production release (2026-10-23, "Fix streaming false too-large: bound raw SSE bytes at 4 MiB"). Never trust a SHA copied by hand into a ticket: resolve the anchor from the ref, verify it resolves in both the candidate repository and the repository that will serve the rollback, and fail the gate on any mismatch. The preflight performs these read-only checks (`rev-parse`, `show`, `for-each-ref`, `merge-base`; it never checks out or fetches):

```sh
# 1. Resolve the anchor truth from the recorded ref (never from a pasted SHA).
ANCHOR=$(git rev-parse --verify rollback/prod-20261023-7fa444d^{commit})

# 2. Verify identity + anchor consistency in the candidate repository.
node scripts/release-preflight.mjs --rollback-target "$ANCHOR" --rollback-anchor "$ANCHOR"

# 3. Verify the same object exists in the repository that would serve the rollback.
node scripts/release-preflight.mjs --rollback-target "$ANCHOR" --rollback-anchor "$ANCHOR" \
  --rollback-repo /home/jc/projects/Done-Go
```

The `rollbackTargetCommit` report field carries `resolves`, `targetSha`, `objectType`, `subject`, `commitDate`, `refsPointingAtTarget`, `headSha`, `onReleaseLine`, and `anchor.matchesTarget`. A target or anchor that does not resolve, or a target that resolves to a different commit than the anchor, is `FAIL` and must stop the rollback. The same options are available as `RELEASE_ROLLBACK_COMMIT`/`DONEGO_ROLLBACK_COMMIT` (target), `RELEASE_ROLLBACK_ANCHOR`/`DONEGO_ROLLBACK_ANCHOR` (anchor), and `RELEASE_ROLLBACK_REPO` (repository).

### Rollback procedure (identity → switch → post-checks)

Trigger rollback when authentication or data isolation fails, the health probe fails, the candidate manifest differs from the frozen candidate, a critical write is unconfirmed, or a secret appears in an artifact or log.

1. Stop or detach the public connector using the approved service procedure; preserve DNS and tunnel credentials.
2. Stop the application through the service owner; preserve the database, user data, configuration, and logs.
3. Restore the previous verified build directory and matching manifest.
4. Verify loopback health, authentication, session behavior, and account isolation before reconnecting any public connector.
5. Record the trigger, restored release ID, data state, commands, timestamps, and remaining `UNKNOWN` items.

For the git-anchored production shape (systemd user service `donego.service`, `WorkingDirectory=/home/jc/projects/Done-Go`, loopback `127.0.0.1:17507`), the switch and post-checks are auditable as:

1. **Identity** — run the three commands above; require `rollbackTargetCommit` `VERIFIED` with `anchor.matchesTarget=true` in both repositories, and record the resolved 40-hex SHA, subject, and date in the rollback record. Any `FAIL` stops the rollback.
2. **Switch** — in the serving repository only: `git status --porcelain` must be clean, then `git checkout --detach "$ANCHOR"` and restart through the service owner (`systemctl --user restart donego.service`). Never `reset`, `clean`, or force-push; never check out into a dirty tree.
3. **Post-checks** — `git -C /home/jc/projects/Done-Go rev-parse HEAD` equals the anchor SHA and `git status --porcelain` is clean; `systemctl --user is-active donego.service` is `active`; `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:17507/` returns `200`; `curl -s http://127.0.0.1:17507/api/auth/status` reports the expected auth shape; an unauthenticated `GET /api/auth/me` returns HTTP 401 `AUTH_REQUIRED` (the expected login wall). Keep AI flags off during a rollback unless the trigger investigation requires otherwise.

A rollback drill that proves identity, restore, service shape, and the authentication wall without touching production data uses a temporary detached worktree and an isolated port (for example `git worktree add --detach /home/jc/projects/Done-Go-rollback-drill "$ANCHOR"`, run `TANGO_PORT=<drill-port> TANGO_DEMO_MODE=1 TANGO_COLLAB_DB=<isolated absolute path> node scripts/serve-tango.mjs`, probe, stop, then `git worktree remove`). The drill result is evidence for the procedure only, never for production state.

Never clear SQLite files, user records, session material, AI settings, or tunnel credentials during rollback. Database migration rollback requires a verified backup and restore exercise; without that evidence, the state is `UNKNOWN`.

## Evidence ledger

Use these labels in the release report:

- **VERIFIED**: directly observed in this release attempt with command, target, timestamp, and commit or manifest evidence.
- **UNKNOWN**: not exercised, unavailable in the current environment, or supported only by historical notes.
- **FAIL**: a direct check found a release blocker.
- **BLOCKED**: the freeze or `heavy.lock` prevented release work.

At minimum, record the preflight JSON, `node --check` result, the direct test results, the candidate commit, and the build manifest. Keep these claims separate:

| Claim | Default status without extra evidence |
| --- | --- |
| Git state, identity, dependencies, syntax, unit command readiness | `VERIFIED` or `FAIL` from preflight |
| Temporary build and SHA-256 manifest | `VERIFIED` when the freeze and lock are clear |
| Required environment names | `UNKNOWN` unless each required name is present; values remain undisclosed |
| AI flags and caps/limits | `UNKNOWN` unless configured and shape-valid |
| Loopback listener or HTTP health | `UNKNOWN` until `--runtime` or `--health` reaches an already running service |
| Public origin reachability | `UNKNOWN` in all offline modes |
| Real email receipt, authentication, account isolation, provider health | `UNKNOWN` until directly tested |
| Backup restore, migration rollback, sleep/offline recovery | `UNKNOWN` until exercised |

Historical deployment notes in [DEPLOYMENT.md](./DEPLOYMENT.md) are context only. They do not turn a current public endpoint, tunnel, screenshot, or configuration value into R1 evidence.
