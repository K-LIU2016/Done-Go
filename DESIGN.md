# Tango Done&Go Design System

Existing-system extraction, 2026-09-12. This codifies the shipped token layer and known component patterns, not a new visual direction or a claim that all 18 screens have passed fidelity QA. Source priority: explicit user instructions, supplied `design/` references, `docs/PRD.md`, `docs/SETTINGS-AND-INK-ADDENDUM.md`, then existing code. Default porcelain and optional ink are separate acceptance surfaces.

## 1. Atmosphere & Identity

Canonical product identity: **探戈 Done&Go**. The product is a personal agency layer for recording intent, negotiating responsibility, authorizing bounded execution, and making recovered time visible. Historical porcelain references may inform visual tokens only; they do not define product identity or business behavior. Business fixture state remains explicitly labelled independently of LLM connectivity.

## 2. Color

| Token | Porcelain | Ink |
|---|---|---|
| --bg | #F3F5F6 | #F5F1E8 |
| --surface | #FFFFFF | #FCFAF5 |
| --surface-2 | #FAFCFC | #F3EFE5 |
| --text | #232C32 | #282A27 |
| --text-2 | #65727B | #706D64 |
| --divider | #DDE4E7 | #DCD5C8 |
| --info | #426D92 | #A44335 |
| --ok | #4D7771 | #56685A |
| --warm | #956C43 | #7A6636 |
| --graphite | #2F3B42 | #282A27 |
| --focus | #7A9FBA | #A44335 |

Use existing semantic tokens. Ink #AD9360 and #819081 are decorative accents, not small text on paper. Ink shell-local variable overrides belong on `.shell`, where default shell values are declared. Status must also use readable text/icons, never color alone.

## 3. Typography

Actual stacks: `--font-serif`: Noto Serif CJK SC, Songti SC, STSong, SimSun, serif; `--font-sans`: Noto Sans CJK SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif; `--font-latin`: Inter, Helvetica Neue, Arial, sans-serif. These are configured fallbacks, not a claim that webfont files are bundled.

Existing scale: 42px/600 page titles; 24px/600 panel titles; 17px subtitles; 16px body at 1.6; 14px secondary controls/notes; 13px navigation/table labels; 88px/600 home time display. Preserve screen-specific responsive CSS, do not introduce a new type scale while replacing data bindings. Time and numeric comparisons use tabular figures. Never use calligraphy for controls or time labels.

## 4. Spacing & Layout

Preserve current page grids and class contracts. s01 uses the existing hero/summary/responsibility hierarchy; s02 uses the existing 2.2:1 board/aside grid, 24px gap, board padding 36px 40px, 430px timeline mechanics. Desktop shell has an 88px rail inset 18px; short-height navigation is the scroll owner. Existing 8px-based rhythm plus measured reference-specific exceptions remain; this extraction does not authorize global spacing normalization. The document owns page scrolling; avoid clipping essential controls or forcing all dense pages into fixed height.

## 5. Components

Measured porcelain quiet-screen exceptions: the shared artwork uses a 560-unit viewBox; S08 maximum artwork container 896px gives an approximately 739px ring at the 1920x1200 reference viewport. S18 maximum 376px gives an approximately 310px ring at 480x1040; primary action maximum width 395px and main time 33px. Crisp porcelain edges and a foreground crossing line replace broad blur. Ink retains smaller 656px/292px artwork limits and no page-wide arc. These are reference measurements, not a claim of final visual acceptance.

Final measured alignment adjustment: S08 content starts at x156 and heading is 60px at1920; S18 artwork/title/time moves down65px, ring band alone scales horizontally0.91 while the disc remains circular. Short screens retain compact spacing and ink excludes these adjustments.

- Shell / MobileChrome: existing shared navigation and framing components. Navigation uses links, active state plus text, visible keyboard focus. Preserve routes and scroll ownership.
- Paper/porcelain panels: existing screen CSS, semantic surface/divider/radius/shadow tokens; heading and content hierarchy. Loading, empty and error content must use the same panel layout rather than fake data.
- Main/secondary buttons: existing screen classes, explicit labels, native disabled state, focus-visible, visible busy/error outcomes. No success before durable acknowledgement.
- AppearanceSettings: native radio group 默认·瓷白 / 水墨, check plus 已选择 text, status feedback for failed read/write and invalid stored values. Stored key `tango-donego.appearance.v1`; only ink sets `html[data-theme=ink]`.
- DraftAssistant: one selected section, exact outbound preview, explicit generate, proposal and explicit apply; local failure keeps user text. It is not a global auto-sending chat box.
- Editors and approvals: label every field; preserve pending text on conflict, name selected object and version. Plan preview is distinct from applied state, confirmed is distinct from sent.

These component patterns are existing implementations, not an asserted all-states showcase pass. Final state/viewport QA remains open and must be recorded before release acceptance.

## 6. Motion & Interaction

### RC7 reference-calibration tokens

RC10 follow-up restores S02 boundary-track grid lines using the same hour percentages as the arrangement track; the optional open-time note retires when a protected interval starts too early or the track stacks below 904px. S04 method explanation remains distinct from saved metric evidence. Default S15 hero artwork top is -52px after normalized-reference review; ink placement is unchanged. These remain subject to actual follow-up screenshots.

RC8 follow-up S04 local wide-porcelain targets: saved numeric comparison values 72px, card title 34px, arrow 32px and unit 17px; unsaved/unknown labels remain body-sized, with no invented comparison values. A separate porcelain ring experiment proposes rotation 22deg, scaleX .93 and soft/mid/core strokes 16/8/3 SVG units, removing S18's previous extra .91 scale to avoid double narrowing; these ring values are candidates pending screenshot verification, not measured fidelity acceptance, and ink remains unchanged.

At the 1920×1200 porcelain reference viewport, S01 hero minimum height is 508px and responsibility-section lead space is 40px. S02 main/aside ratio is 2.73:1 and boundary track is 400px, shrinking responsively; the 630px time axis remains data-scaled. Display serif headings use regular 400 weight where the reference has unbolded Song type. S06 material registration and per-section question editing use explicit inline disclosure controls, preserving input values and pending-command locks.

S07 uses a start-aligned left panel with 840px desktop minimum height and a stable 380px ring region, independent of longer right-hand content. S08 porcelain action targets are 244px/254px wide and 60px high, with narrow-layout wrapping. S12 has two right-side cards: summary and combined savings/feedback; ledger values use a 240px column and 34px numeric display type, with unknown text retaining body sizing.

S13 keeps the real sync-status capsule inside its 840px desktop main card; the alert region is 200px and source panel 480px. Alert display type is 38px, section titles 24px, and primary action maximum width 292px with pill radius. S14 display-input measure is 13em, with source/input-mode actions grouped compactly without hiding labels; modal stack gap uses the 16px spacing step. Mobile porcelain comparison numbers use 62px display type and 20px comparison gap; S15/S18 numeric emphasis is 600 while units retain secondary sizing. These measurements are correction targets, not an acceptance claim. Document scrolling and existing responsive breakpoints remain the layout model.

Keep existing quiet motion. Ink feedback token 200ms and panel token 280ms; reduced-motion disables nonessential transitions. No new animation required for data binding. User controls trigger changes explicitly; hover must not hide essential actions. Preserve selected object, input and preview on asynchronous failure; avoid automatic navigation after approval.

## 7. Depth & Surface

Mixed fine-border plus light shadow strategy. Porcelain radii 24/28/34px, panel shadow `0 18px 50px rgba(35,44,50,.06)`, button shadow `0 10px 24px rgba(35,44,50,.16)`. Ink radii 8/12/16px with warmer, lighter paper surfaces. Ink ring is a faint 1.5px outline without inset/outer glow and retires in narrow/short contexts. Decoration cannot cover content or alter data geometry. Do not use full-screen mountains, neon, heavy glass, black-gold styling or distressed paper.

## 8. Accessibility Constraints & Open Debt

Target WCAG AA: 4.5:1 normal text and 3:1 large text, visible keyboard focus, labelled controls, non-color status, readable CJK, reduced motion and touch targets. Scenarios include keyboard-only operation, enlarged text, small viewport, interrupted network and concurrent editing. Full keyboard/screen-reader/contrast audits are not yet verified.

No design or accessibility debt has been accepted by the user. Open release gaps include strict 18-screen reference fidelity, all control states at mobile/tablet/desktop and screen-specific raw CSS consistency. The earlier settings Hook crash is no longer a current blocker: RC9 settings rendered and its empty-candidate validation was exercised. Track exact findings in `docs/DELIVERY-MATRIX.md` and `.omo/evidence/`; do not relabel remaining gaps as accepted debt.

Tool boundary: user permits only Codex built-in browser or Ego Lite. Frontend reference recipes that launch independent Playwright/Chromium do not apply. No Lighthouse 100 claim exists. React debug-tool installation and global primitive refactors are not part of the narrow data-binding repair and are not silently added to other owners' files.
