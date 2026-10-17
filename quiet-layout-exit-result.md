# Quiet layout & exit route correction — result

> Root correction, 2026-09-13: the two `evidence/screenshots/s08.png` / `s18.png` files referenced below are prior app captures, **not attachment originals**. The actual originals under `design/01_桌面大图/08_静驻时刻_不安排也成立.png` and `design/02_移动端大图/18_移动端_静驻时刻.png` have no ordinary sidebar/tab bar and agree with the PRD. Thus the “design discrepancy” claims below are superseded by `.omo/evidence/quiet-original-source-audit.md`; they do not require a new user design decision. Root later verified keepStill/exit return routes in Ego Lite. Visual artwork fidelity remains a separate active repair.

Owner bound: src/screens/s08-stillness/**, src/screens/s18-m-stillness/**, src/routes/groupB.tsx, and MobileChrome.tsx limited to the optional hideNavigation prop. No other files, deps, commits, stages, browsers, Playwright, gstack, or subagents were used.

## Implemented (VERIFIED, code-level)

1. /stillness moved from groupB.shell to groupB.bare; the route component and all other route records are unchanged. App.tsx renders bare routes outside Shell, so the ordinary sidebar/topbar/footer no longer surround the quiet screen. Closes the "/stillness 仍 Shell" part of S08-L01 GAP.
2. .s08 fullscreen correction: min-height 70vh → 100vh with its own padding (owned css only; no hidden-selector styling on other pages).
3. MobileChrome gains optional hideNavigation = false; the tab bar renders only when navigation is not hidden. Status header and clear X are untouched. S18MStillness passes hideNavigation; TABS definition unchanged.
4. returnTo contract in quietSurface.ts (pure, tested):
   - validateQuietReturnTo accepts only single-slash internal app paths; rejects missing/empty, non-path ("https://…", "javascript:…", relative), whitespace/control characters, protocol-relative "//", backslash authority tricks, cross-origin parses, and quiet-recursive destinations (/stillness, /m/stillness, incl. trailing slash and query variants).
   - selectQuietEntryOrigin: validated returnTo verbatim (query IDs preserved) else fallback.
   - selectQuietExitTarget: current ?returnTo (validated) → persisted session originRoute (validated) → fallback. Legacy session origins of /stillness or /m/stillness are rejected and fall through.
   - describeQuietExecuteFailure: readable Chinese failure text for unknown promise rejections.
5. Both screens: openQuietSession now persists the validated originRoute (validated returnTo else fallback: "/" for s08, "/m/now" for s18) instead of location.pathname (/stillness or /m/stillness itself).
6. Exit routing: verified keepStill and verified × exit both navigate to selectQuietExitTarget; direct entry (no/invalid returnTo, no valid session origin) falls back to / (s08) or /m/now (s18). Session reuse semantics unchanged.
7. Async hardening: both store.execute call sites in both screens now .catch rejections → pendingAction released, open effect also releases openInFlight, and a readable RUNTIME_PROMISE_REJECTED error with retry plan is shown. No infinite wait, no unhandled rejection. Retry of a possibly-applied exact command stays safe because the store settles unresolved same-commandId candidates idempotently and returns REVISION_CONFLICT (rederive path) otherwise.

## Design/PRD basis for the keepStill UX change (explicit requirement, implemented)

- PRD.md:73 — quiet screens (s08/s18) are fullscreen, hide normal navigation, and 退出后回到来源屏.
- PRD.md:71 — s18 安静界面隐藏标签栏仅保留退出按钮.
- DELIVERY-MATRIX S08-I01 — keepStill 保存 suppressPrompts 并关闭回来源; S08-I04 — × saves and returns to the actual origin page.
- DELIVERY-MATRIX S18-I01 — 持久 keepStill/suppressPrompts，关闭回来源; S18-I02 — × returns to actual source screen with mobile-home fallback.

Because the accepted matrix explicitly requires "save and close back to origin" for keepStill, the previous stay-on-screen keepStill behavior was changed to navigate to the validated origin after verified save + readback. This is the required change, not a silent UX drift.

## Discrepancies recorded for root (not silently resolved)

1. evidence/screenshots/s18.png (original design PNG) SHOWS a four-tab bar (此刻/时间/协同/我的) on the mobile quiet screen, conflicting with PRD.md:71 and S18-L01 (隐藏 tab). Implemented per PRD/matrix (tab hidden). Design source and acceptance docs disagree; root may want design reconciliation.
2. evidence/screenshots/s08.png shows the quiet screen inside the desktop shell (sidebar, brand bar, footer), while PRD.md:73 and S08-L01 treat shell-surrounded quiet as the gap. Bare fullscreen implemented per PRD/matrix.

## Validation (VERIFIED)

- node --test src/screens/s08-stillness/quiet-return.test.ts src/screens/s08-stillness/quiet-ui.test.ts → 12/12 pass (6 new pure tests: returnTo validation incl. external/protocol-relative/backslash/quiet-loop and verbatim query preservation; entry-origin persistence; exit-target precedence incl. legacy /stillness and /m/stillness session origins falling back; readable execute-failure text; plus the 6 pre-existing quiet-ui tests still passing).
- npx tsc -b --pretty false → exit 0 (whole build, no foreign or owned errors).
- npx oxlint scoped to the owned files/dirs → clean.

## Remaining boundaries (UNKNOWN here, needs root browser acceptance)

- Per constraint no browser/Playwright/gstack was used: actual keepStill/× cross-page navigation, fullscreen visuals against the original PNGs, and mobile X persistence in the running app are unverified here and left for root's Ego acceptance.
- tests/groupB.spec.ts s08 cases (read-only inspection) assert only data-page="s08" locators, so the bare move should not break them, but the Playwright suite was not run (constraint).
- The s18 original-PNG tab-bar discrepancy above needs a design decision before it can be called accepted.
