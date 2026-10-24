# Done-Go CTO Handoff Closeout Implementation Plan

> **For agentic workers:** This plan is for a controlled release and verification cycle. Do not implement or deploy any step until JC confirms the plan. Preserve all existing user files, untracked files, database files, environment files, rollback refs, and worktrees.

**Goal:** Safely reconcile the ThinkPad production checkout with GitHub `main` at `00dc54342b3aba63ddaf2b502ec8b0bc933ee9eb`, publish it through a reversible procedure, and close the remaining email, persistence, tunnel, and release evidence gaps.

**Architecture:** Treat the current production checkout at `d1e1eb7bd5949de3e9298e52231fd21e365199c5` as a protected baseline. Fetch and test the candidate in an independent clean worktree, create a rollback anchor for the current production revision, verify database recovery and tunnel ownership, then switch the serving checkout through `donego.service`. Keep live email, service restart persistence, database recovery, and external AI provider evidence as separate acceptance layers.

**Tech Stack:** Node.js 24.22.0, the current `scripts/serve-tango.mjs` Node service, SQLite in WAL mode, systemd user service, Cloudflare Tunnel, npm, Node test runner, and Playwright.

**Spec:** `CTO-HANDOFF-2026-10-24.md`

## Global Constraints

- Never use `git reset --hard`, `git clean`, force-push, database deletion, SQLite clearing, or secret replacement to manufacture a clean state.
- Do not modify LiteLLM Infra, its sessions, or its configuration.
- Keep `TANGO_AUTH_SECRET`, Resend/SMTP credentials, cookies, verification codes, and user content out of logs, evidence files, screenshots, and commits.
- Production stays loopback-bound at `127.0.0.1:17507`; public access remains through the existing tunnel.
- Every result carries the full candidate SHA, command, timestamp in `Asia/Shanghai`, return code, and one of `VERIFIED`, `INFERRED`, `UNKNOWN`, or `FAIL`.
- A fixture mailbox or Playwright pass proves application behavior only; it does not prove real mail delivery or user acceptance.
- The current untracked `CTO-HANDOFF-2026-10-24.md` is user-owned evidence and must be preserved byte-for-byte.

## Review Focus

- Candidate identity: the local `origin/main` is stale and the candidate object is currently absent; do not deploy until the fetched full SHA is exactly `00dc543...`.
- Release tree cleanliness: the serving checkout contains the untracked handoff file; do not switch it until that file has an explicitly approved reversible disposition.
- Anonymous auth probe: `/api/auth/*` requires `x-tango-client: tango-settings/1`; without it, `403 ORIGIN_REJECTED` is expected, while an unauthenticated marked request must return `401 AUTH_REQUIRED`.
- Database recovery: SQLite uses WAL and forward-only startup schema changes; a code rollback is not a migration rollback unless a compatible backup restore has been demonstrated.
- Browser state: `verify:ui` generates `artifacts/tango-ui-auth.json`; regenerate it on the candidate instead of trusting the previous artifact.
- Tunnel ownership: an active `cloudflared` process is not proof of a persistent service or automatic recovery.

---

## Current Assessment

### VERIFIED

- The current checkout is detached at `d1e1eb7bd5949de3e9298e52231fd21e365199c5`.
- `donego.service` is active and runs `/home/jc/projects/Done-Go/scripts/serve-tango.mjs` on `127.0.0.1:17507`.
- The local and public roots currently return `200`.
- With `x-tango-client: tango-settings/1`, the public anonymous auth probe returns `401 AUTH_REQUIRED` and `/api/auth/status` returns `200` with registration enabled and email delivery configured. A bare probe returns the protection response `403 ORIGIN_REJECTED` by design.
- `.env` and the current SQLite database are mode `600`; the database has `-wal` and `-shm` companions because it uses WAL mode.
- `git ls-remote origin refs/heads/main` currently resolves to `00dc54342b3aba63ddaf2b502ec8b0bc933ee9eb`.
- The local `origin/main` still resolves to `b4520d411225b36762901845084f8a4faa3075ea`, and the target object is not yet present in the local object database.

### INFERRED

- The handoff describes the candidate as the auth-page centering merge plus the final static-asset tunnel path, but the exact `d1e1eb7..00dc543` diff must be inspected after fetch before relying on that description.

### UNKNOWN

- Candidate object availability and exact diff after `git fetch origin main`.
- Full candidate-SHA unit and Playwright results.
- Real Resend delivery and JC's real account flow.
- Persistent ownership and automatic recovery of `cloudflared`.
- Production SQLite backup restoration and any migration compatibility.
- User, session, and collaboration persistence across a real service restart.
- Production admin/user permission experience and external AI provider availability.

## Recommended Order Changes

1. Move the real-email acceptance window after the candidate has been deployed and public smoke checks have passed. A real-email test performed on `d1e1eb7` is historical evidence for the old revision and consumes a live delivery without closing the candidate acceptance.
2. Promote rollback-anchor creation, database backup/recovery readiness, and tunnel ownership recording before the production switch. These are prerequisites for a controlled release, not post-release cleanup.
3. Correct the handoff's anonymous auth probe to include `x-tango-client: tango-settings/1` and change “migration rollback” to “backup restore and migration compatibility drill” because the repository has no down-migration runner.
4. Keep cloudflared automatic recovery `UNKNOWN` unless a separate, explicitly approved failover exercise is run. Recording the current PID, parent, command, config path, route, and manual recovery command is sufficient for this release gate.

## Task 0: Freeze the baseline and preserve ownership

**Files:**

- Read-only: `CTO-HANDOFF-2026-10-24.md`, `.env` metadata, `.tango-donego/collaboration.sqlite*`, systemd and tunnel metadata.
- Create only after approval: a private evidence directory outside the repository, for example `/home/jc/projects/Done-Go-release-evidence/2026-10-24-pre-00dc543/` with mode `700`.

**Entry condition:** `donego.service` remains active at the recorded baseline, or the failure is recorded before proceeding.

- [ ] Record `git status --short --branch`, `git rev-parse HEAD`, `git rev-parse origin/main`, remote URL, and `git worktree list --porcelain`.
- [ ] Record the handoff file's size, mode, owner, timestamp, and SHA-256 without changing it.
- [ ] Record only names/presence and permissions for `.env`; do not print or hash secret values into the evidence ledger. Inventory existing `.env.*` backups before creating another one.
- [ ] Record paths, modes, owners, sizes, and timestamps for the SQLite main file and any `-wal`/`-shm` files. Do not copy or open the production database for inspection before the backup procedure is approved.
- [ ] Record service state, `WorkingDirectory`, `ExecStart`, PID, active-enter time, the `17507` listener, and the current `cloudflared` PID/parent/config path.
- [ ] Run the non-mutating health probes with the client marker: local root `200`, public root `200`, public `/api/auth/status` `200`, and public `/api/auth/me` `401` with `AUTH_REQUIRED`.

**Exit condition:** A baseline evidence record exists and the untracked handoff document remains unchanged. Any unexpected status, listener, or public response stops the plan.

## Task 1: Fetch and reconcile the candidate source

**Files:**

- Modify Git metadata only: remote-tracking refs and worktree metadata.
- Preserve: `/home/jc/projects/Done-Go/CTO-HANDOFF-2026-10-24.md` and all existing dirty/untracked files.

**Entry condition:** Task 0 is complete and JC has approved the network fetch.

- [ ] Run `git fetch origin main` in the production repository; retain the fetch result.
- [ ] Require `git rev-parse origin/main` to equal `00dc54342b3aba63ddaf2b502ec8b0bc933ee9eb`; if the remote moved, stop and re-evaluate the candidate instead of silently following it.
- [ ] Verify the candidate commit and the current baseline commit resolve locally with `git cat-file -e <sha>^{commit}`.
- [ ] Record `git diff --stat d1e1eb7..00dc543` and `git diff --name-status d1e1eb7..00dc543`; inspect all changed files for auth, database, service, build, and tunnel impact.
- [ ] Confirm the current production rollback refs and create no new ref until the exact current `HEAD` has been recorded.
- [ ] Create a detached candidate worktree at `/home/jc/projects/Done-Go-candidate-00dc543` from the full candidate SHA. Do not run tests in the serving checkout.

**Exit condition:** The candidate SHA, exact diff, candidate worktree path, and current baseline identity are all recorded. A mismatch, missing object, unexpected schema change, or unexplained production-file difference is a stop condition.

## Task 2: Run all candidate offline gates in isolation

**Files:**

- Read-only source under the candidate worktree.
- Generated test artifacts under the candidate worktree or the private evidence directory; never under the production database or `.env` path.

**Entry condition:** Task 1 produced a clean candidate worktree.

- [ ] Ensure candidate dependencies are available; run `npm ci` only in the candidate worktree if its `node_modules` is absent or does not match the lockfile.
- [ ] Run `node scripts/release-preflight.mjs` and retain its JSON output. Treat missing production environment values as `UNKNOWN`, never as permission to print them.
- [ ] Run `npm run verify:web`.
- [ ] Run `npm run test:unit` and `npm run lint` as the broad regression checks.
- [ ] Run the isolated Playwright gates: `npm run verify:account`, `npm run verify:collaboration`, `npm run verify:demo`, `npm run verify:demo-direct`, and `npm run verify:ui`.
- [ ] Require `verify:ui` to regenerate `artifacts/tango-ui-auth.json` through `tests/helpers/email-setup.mjs`; do not reuse the historical 2026-10-23 auth artifact as evidence.
- [ ] Record each command's candidate SHA, start/end time, return code, pass/fail count, and failure artifact paths. Fixture email and demo data must remain isolated from production.

**Exit condition:** All required gates return `0` on the exact candidate SHA. A failing test is investigated and classified before any production action; no compensating production patch is made in the same release window.

## Task 3: Prepare rollback, database recovery, and tunnel evidence

**Files:**

- Git rollback ref: `refs/rollback/donego-20261024-pre-00dc543` pointing to the verified current production SHA `d1e1eb7...`.
- Private backup/evidence directory outside Git; permissions `700` for directories and `600` for files containing configuration or database data.
- No source files.

**Entry condition:** Candidate offline gates pass and the release is outside the `00:30–03:30 Asia/Shanghai` freeze window with no `heavy.lock`.

- [ ] Create the new rollback ref only after verifying it points exactly to the current serving `HEAD`; run the read-only rollback identity checks from `scripts/release-preflight.mjs` against the candidate repository and serving repository.
- [ ] Inventory existing environment backups, then make one clearly labeled, private, recoverable copy of the current production environment file if the operator's approved backup procedure requires it. Record path, mode, owner, and timestamp only; never put its contents in the ledger.
- [ ] Quiesce the application through `donego.service` for the database backup window. Copy the SQLite database as a consistent set, including whichever `-wal`/`-shm` files exist after quiescence; record SHA-256 values in the private recovery manifest, not in public release notes.
- [ ] Validate the backup copy with SQLite `PRAGMA integrity_check`, a schema snapshot, and a table/object inventory that excludes row contents and secrets.
- [ ] Restore the backup into a separate temporary directory and run the candidate service on an isolated loopback port with an isolated database path. Verify startup, auth status, integrity, and the expected schema delta. Do not connect the tunnel or alter production data during this drill.
- [ ] Because the repository uses startup `CREATE TABLE IF NOT EXISTS` plus forward `ALTER TABLE` and has no down-migration runner, classify “migration rollback” as `UNKNOWN` unless the isolated restore proves old-code/new-schema compatibility. If the candidate diff touches schema files, block deployment until that compatibility is demonstrated.
- [ ] Record the actual cloudflared process, parent process, command, config path, route for `donego.udify.fun`, and a manual recovery command. Keep persistent ownership and automatic recovery `UNKNOWN` unless separately tested.

**Exit condition:** The current code has a verified rollback anchor, the database backup can be integrity-checked and restored in isolation, and the tunnel's current ownership and manual recovery path are recorded. No source switch occurs if any of these are missing.

## Task 4: Resolve the serving worktree ownership before switching

**Files:**

- Current serving worktree only; no source changes.
- User-owned untracked `CTO-HANDOFF-2026-10-24.md` must remain recoverable and byte-identical.

**Entry condition:** Tasks 0–3 pass.

The current serving worktree is not clean because the handoff document is untracked. Do not hide this with `reset`, `clean`, or an unreviewed stash. Before the switch, choose one of these explicitly:

- **Recommended for preserving the exact `00dc543` candidate:** make a verified private copy of the handoff document, temporarily move the original out of the serving worktree for the switch, and restore it at the same path immediately after the service is healthy. Verify the SHA-256 before and after.
- **Alternative:** commit the handoff and README link first, then release the resulting documentation commit and record both `codeSha=00dc543...` and the new `worktreeSha`. This changes the candidate identity and requires a separate confirmation.
- **Alternative with higher operational scope:** point a temporary service unit override at the clean candidate worktree. Use only if JC explicitly prefers this route.

- [ ] Record the selected disposition before any path-changing operation.
- [ ] Require the serving worktree to have no unexplained tracked or untracked changes at the moment of `git checkout --detach`; preserve and restore the handoff file according to the selected disposition.

**Exit condition:** The serving checkout can be switched without overwriting or losing user-owned evidence, and the exact SHA used by the service is unambiguous.

## Task 5: Deploy the candidate through the service owner

**Files:**

- Serving checkout only, switched to `00dc54342b3aba63ddaf2b502ec8b0bc933ee9eb`.
- Service state and private release evidence; no source patch.

**Entry condition:** Tasks 0–4 pass, the freeze window is clear, and the pre-switch service/database/env/tunnel evidence is saved.

- [ ] Switch the serving checkout with `git checkout --detach 00dc54342b3aba63ddaf2b502ec8b0bc933ee9eb`; do not use `reset` or `clean`.
- [ ] Restart only through `systemctl --user restart donego.service`; do not restart cloudflared as part of this release.
- [ ] Confirm `systemctl --user is-active donego.service` is `active` and `git rev-parse HEAD` equals the full candidate SHA.
- [ ] Read back local root `200`, one real static CSS/JS resource `200` with a non-zero body, public root `200`, and public `/api/auth/status` `200` using the client marker.
- [ ] Read back public `/api/auth/me` with `x-tango-client: tango-settings/1`; require `401` and `AUTH_REQUIRED`. A probe without the marker returning `403 ORIGIN_REJECTED` is recorded as expected protection behavior, not a failure.
- [ ] Open the public URL in a fresh browser context and verify the login wall, registration link, password-confirm field after entering registration, no new console errors, and logout behavior. Do not use an old blank or cached tab as evidence.
- [ ] If a critical smoke check fails, preserve logs and the failed response, stop public acceptance, verify the rollback anchor again, switch back through the service owner, restart, and repeat local/public health checks before any further diagnosis.

**Exit condition:** The candidate is serving at the expected SHA and all release smoke checks pass, or a documented rollback has restored the previous verified production state.

## Task 6: Perform JC's real-email acceptance on the candidate

**Files:**

- No repository files.
- Private acceptance record containing no password, verification code, full mailbox credential, secret, or user正文.

**Entry condition:** Task 5 public smoke passes on the candidate SHA.

- [ ] In a fresh public browser context, confirm the login and registration entry points.
- [ ] JC uses a real mailbox to complete registration, receive the code, set a password, explicitly log in, open account settings, save a display name, log out, and log in again.
- [ ] Confirm the sender displays as `Done&Go`, the code is accepted once, invalid/expired attempts do not expose provider diagnostics, and the UI does not reveal secrets or internal stack details.
- [ ] Record only timestamp, candidate SHA, page paths, high-level HTTP outcomes, mail arrival fact, and any sanitized UI/browser error. Keep the verification code and password out of all artifacts.

**Exit condition:** Real email receipt and the complete account lifecycle are `VERIFIED`, or the item remains `UNKNOWN` and the release is explicitly treated as a partial/non-closed acceptance.

## Task 7: Verify restart persistence and close the release ledger

**Files:**

- Private release evidence directory.
- Optional future release summary under `docs/`; no code changes unless a separate fix is approved.

**Entry condition:** Task 6 passes, or JC explicitly accepts a documented partial release.

- [ ] Before restart, record the current account state and, only with JC's approval, create a clearly labeled disposable collaboration marker. Do not mutate existing user groups just to create evidence.
- [ ] Restart `donego.service` through systemd, verify active state and the same candidate SHA, then check the account, session behavior, and approved collaboration marker after restart.
- [ ] Record whether the existing session survives restart, whether a re-login is required, and whether user/collaboration data survives. Keep any unverified dimension `UNKNOWN`.
- [ ] Keep production admin/ordinary-user acceptance separate from fixture tests. If no authorized production admin test is available, leave it `UNKNOWN`.
- [ ] Keep external AI provider/quota availability `UNKNOWN` unless JC separately authorizes and performs that acceptance; do not touch LiteLLM Infra.
- [ ] Produce a release ledger containing candidate SHA, baseline SHA, rollback ref, test commands/results, service/tunnel readback, real-email result, database recovery result, restart result, and remaining UNKNOWN items.

**Exit condition:** Every claim in the release report has direct evidence or an explicit `UNKNOWN`; no historical test count is presented as current candidate proof.

## Task 8: Apply governance updates after acceptance

**Files:**

- Modify: `CTO-HANDOFF-2026-10-24.md` — correct the marked auth probe, reorder the live-email step, and clarify backup restore versus migration rollback.
- Modify: `README.md` — add the handoff document entry and a concise release-record link.
- Create: a dated release summary such as `docs/RELEASE-2026-10-24-00dc543.md`, containing evidence paths and statuses but no secrets or user content.

**Entry condition:** Task 7 has a complete ledger and JC approves the documentation commit.

- [ ] Make the documentation changes on a named branch based on the intended release line, never directly on a detached HEAD.
- [ ] Run the documentation link/path checks and the relevant non-production verification after the docs commit.
- [ ] Record the relationship between `codeSha=00dc543...`, the serving SHA, the rollback ref, and the later documentation commit. Do not push or publish without separate authorization.
- [ ] Audit stale branches and worktrees only after ownership is confirmed. Do not delete the `/tmp/donego-codex-*` worktrees, `Done-Go-dev`, or stale refs in this release task.

**Exit condition:** The handoff is discoverable from the repository, the release record is traceable to the candidate SHA, and cleanup remains a separately authorized decision.

## Plan Self-Review

- The original P0/P1/P2 items are covered: real email, source reconciliation, controlled deployment, tunnel ownership, account/web/demo gates, full Tango Playwright coverage, backup restore, restart persistence, README discoverability, stale-worktree governance, and evidence linkage.
- No task assumes the candidate diff, current target object, real mail delivery, database recoverability, or tunnel persistence before its discriminating check.
- No task introduces a migration abstraction or product redesign. A schema-related candidate diff creates a stop condition and a separate implementation decision.
- The auth probe test distinguishes an intentional `403 ORIGIN_REJECTED` caused by a missing client marker from the expected anonymous `401 AUTH_REQUIRED` path.
- The five highest-risk conditions have explicit checks: source identity, dirty ownership state, auth protection, WAL backup/recovery, and stale browser state.

This plan is complete for review. No implementation, deployment, version switch, database backup, service restart, or external write is authorized by the plan alone.
