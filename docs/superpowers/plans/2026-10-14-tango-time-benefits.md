# Tango time benefits implementation plan

> Execute the user's approved screenshot review in this checkout. The user requested implementation and GitHub synchronization, so proceed through validation without another planning approval.

**Goal:** Make Done&Go show understandable time totals, optional task-specific AI guidance, confirmed time gains, and the user's choice of how to use them.

**Architecture:** Keep the existing static `web/` application and its three screens. Put pure time calculations in an inline core script that both the page and unit tests consume; keep legacy storage keys compatible. Do not change the separate React application or self-hosted AI services.

**Tech stack:** Plain HTML/CSS/JavaScript, Node test runner, Playwright. Existing React checks also run before synchronization.

**Spec:** The six screenshot-review recommendations approved in the current conversation.

## Global constraints

- Brand: 探戈 Done&Go; slogan: 事情搞定，时间归你。
- AI assistance stays an optional part of each task.
- Estimates never become confirmed savings when a recommendation is selected.
- Compare planned and user-confirmed actual minutes; actual includes AI preparation, checking, and rework. This comparison does not establish that AI caused the difference.
- Generic work, meals, and unknown tasks have no fabricated AI savings.
- Only the user chooses a freed interval's use; preserve existing conflict handling and browser data.
- Keep the forest palette and hand-drawn identity, improve contrast and responsive layout.
- Preserve language selection, import/export, speech input, and onboarding.

## Review focus

- Overlapping tasks and user intervals must not be deducted twice from an awake-day budget.
- Legacy estimated AI reductions and unconfirmed trials must not inflate confirmed totals.
- Invalid completion input, overruns, and repeat completion must not create savings or duplicates.
- Historical/future tasks and already elapsed intervals must not invite booking time in the past.
- Seven/thirty-day review metrics must use the same selected interval, and mobile dialogs must remain usable.

## Task 1: Honest time calculations

**Files:** `web/index.html` (inline `tango-time-core`); `tests/unit/tango-time.test.mjs`.

**Interfaces:** `TangoTime.occupiedMinutes(entries)`, `TangoTime.unplannedMinutes(entries, wake)`, `TangoTime.confirmedSavings(trials, from, to)`, `TangoTime.estimate(trials, category, minutes)`.

- [x] Add tests for interval unions, budgets, confirmed-only totals, selected date ranges, invalid inputs, and personal estimates with insufficient samples.
- [x] Run the tests and observe the missing behavior fail.
- [x] Implement the pure core and connect homepage/review metrics.
- [x] Re-run the tests.

## Task 2: Task assistance and completion

**Files:** `web/index.html` task cards, model sheet, completion sheet, and action handlers.

- [x] Add browser tests: viewing model guidance never changes schedules or confirmed totals; unknown tasks have no savings claim.
- [x] Add browser tests: completing a 60-minute plan in 40 actual minutes records 20 minutes once; overruns record zero; blank/negative input is rejected.
- [x] Replace fixed percentage/tool-ranking claims with personal history or `待估算`; show company, a named reference model, capability, official source, device guidance, and copyable task prompt.
- [x] Add an explicit completion action and required actual duration; only save after confirmation.
- [x] Present `腾出 20 min`, the actual freed interval, and `散步 / 自由安排 / 另选`; create a user interval only after selection and through conflict resolution.
- [x] Verify persistence, duplicate prevention, and past-interval behavior.

## Task 3: Three-screen visual clarity

**Files:** `web/index.html` stylesheet, timeline, picker, review calendar; `README.md`; `docs/REDESIGN-2026-10.md`.

- [x] Improve text/surface contrast, metric hierarchy, navigation consistency, and main-container width.
- [x] Add duration bands to the time tree and a list alternative.
- [x] Use readable short labels for selecting personal time, and replace product-facing `留白` wording with `自己的时间` or `自由安排`.
- [x] Keep optional completion fireworks but remove score/streak incentives; show confirmed minutes in the review calendar.
- [x] Update the current product overview and clarify estimation/measurement boundaries.

## Task 4: Validate and synchronize

**Files:** `playwright.tango.config.ts`; `tests/tango/*.spec.ts`; `scripts/serve-tango.mjs`; evidence under gitignored `test-results/`.

- [x] Run static-app unit and browser tests, existing unit suite, build, and lint; distinguish existing failures.
- [x] Inspect real light/dark desktop and mobile renders, selected task, completion, model sheet, empty state, and English/RTL navigation.
- [x] Review the final diff for scope, storage compatibility, and accidental secrets.
- [x] Commit the changes, push to the authorized repository, and verify the remote commit. Report synchronization separately from deployment.
