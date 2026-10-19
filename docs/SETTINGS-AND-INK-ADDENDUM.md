# Tango Done&Go: backend settings and optional ink theme

> **历史资料边界（2026-10-16）**：本文保留 React/Vite 服务端设置和主题扩展方案，供追溯与后续研究使用。它不定义当前产品入口、当前实现或上线标准。当前唯一产品基准是 http://localhost:5207/#today，主架构以 DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md 为准。

User addition, 2026-09-12. This adds to the existing V2 delivery contract; it does not replace the 18-screen product or change the default porcelain design.

## Outcomes

1. The canonical product name is **探戈 Done&Go** across UI, accessibility strings, runtime keys, server configuration, and documentation. Historical design attachments remain source archives only and are not product identity.
2. A reachable, responsive `/settings` page provides LLM connection settings. It accepts the user's labelled plain text or Markdown URL format, parses into editable Base URL, Messages URL, Models URL, API key, model, and protocol fields, then tests the actual selected model with a minimal inference request. A models-list response alone is not successful inference. Report each stage and useful redacted errors separately.
3. A saved, verified endpoint powers an actual draft assistance action. Generated text is a proposal until explicitly applied to the shared draft. No fake fallback presented as model output; failure preserves user text; generation never sends messages, changes a calendar, or overrides user confirmation.
4. Appearance offers `porcelain` (default) and `ink`, with immediate application, reload persistence, keyboard support and accurate save-failure feedback. Switching does not alter business data, routing, grants, or inputs. Default appearance retains its existing visual rules.

## Local backend and credentials

The current app is React/Vite without a backend. Introduce a small Node HTTP service bound to loopback, with a Vite `/api` proxy and a production command serving built assets plus the same API. This is a local administration surface, not an internet-exposed unauthenticated admin server. Public hosted administration will require a separate authentication/deployment decision.

Only the server contacts the upstream endpoint. Support the supplied Messages protocol (`/v1/messages`) and conventional OpenAI Chat Completions via an explicit protocol choice. Preserve supplied paths and avoid `/v1/v1`. Validate URL protocols and endpoint coherence; intentional loopback HTTP is allowed. Never follow redirects while carrying credentials. Block metadata/link-local and malformed URLs. Bound body sizes, input lengths and request duration. Protect local mutations against cross-origin/CSRF requests and reject untrusted Host/Origin values. Do not log request bodies, Authorization headers, pasted settings, or raw upstream errors.

Credentials are never source constants or frontend persistent storage. Saving uses a ignored, private server-side settings file with mode 0600 in a mode-0700 directory and atomic replacement; API responses expose only `hasApiKey`, not the key. Redact all errors, screenshots and evidence. Test credentials are synthetic. Changing any material endpoint/model configuration invalidates previous connection proof. Explicit disconnect disables use; do not silently choose another provider.

## Ink design system

Canvas #F5F1E8; paper #FCFAF5; text #282A27; muted #747168; border #DCD5C8; restrained cinnabar #A44335, old gold #AD9360, bamboo #819081. Use readable Song/Ming serif display type and modern sans-serif controls, tabular numerals, thin boundaries, broad faint warm shadows, 12–18px primary corners and 6–10px controls. Ink-primary buttons use paper text; selected controls have more than a color cue. Focus remains conspicuous.

Keep the existing grid, labels, chart values, timeline positions and paths. Warm paper texture is barely visible. At most a faint, noninteractive distant-mountain accent at the edge of spacious home/stillness surfaces; no imagery over text, charts, calendars, or dense work areas. Decorations retreat on small screens. No glass/neon/blue-purple gradients, heavy 3D, dark-gold luxury, scroll inflation, tiny gray text or animated distraction. Feedback approximately 160–240ms; panels 240–360ms; respect reduced motion.

Contrast refinement: the suggested muted #747168 is 4.33:1 on canvas #F5F1E8 and 4.68:1 on paper #FCFAF5. Darken normal-sized canvas secondary text slightly (for example #706D64); the user's palette permits this readability adjustment. Gold #AD9360 and bamboo #819081 are decorative accents, not normal-sized text on paper (2.83:1 and 3.23:1 respectively). Use darker semantic text variants and retain labels/icons for state.

## Verification

- B1: all rendered routes and document title use Tango Done&Go; runtime and server keys use the canonical tango-donego naming.
- B2: paste Markdown and plain-text configuration; verify exact editable parsed values, malformed/empty handling, real models + inference stages, timeout/auth/model errors, saved restart behavior, and no secret response/storage/log leakage.
- B3: with a configured fixture upstream, generate a proposal through the actual HTTP service, apply it to the selected shared draft, refresh and reopen; unchanged sections and authorization boundaries remain intact. Verify actual supplied endpoint separately with no business/private context in the probe.
- B4: default → ink → reload → another route → default; persisted choice and unchanged user data; desktop/mobile/keyboard/reduced-motion and stored preference failure checks. Inspect representative home, ledger, workspace and settings screenshots and smoke all 18 routes in both styles.
- B5: proportional tests, production build/start and browser console checks. Real RED before behavior changes, same GREEN after. Preserve unrelated in-flight work; no commits or public deployment.

## Ownership

- Backend/settings lane: `server/**`, `src/settings/**`, `src/App.tsx`, `src/shell/Shell.tsx`, `src/screens/mobile/MobileChrome.tsx`, `index.html`, `package.json`, `vite.config.ts`, `.gitignore`, settings-specific tests/evidence. No domain/data/runtime or existing business screen changes.
- Theme lane: `src/appearance/**`, `src/styles/ink.css`, `src/main.tsx`, theme-specific tests/evidence. Leave existing tokens/default rules untouched; scope overrides to `[data-theme="ink"]`. Exports `initializeAppearance()` and `AppearanceSettings` for the settings lane.
- Existing owners retain domain/data/runtime and business screens. Parent coordinates the shared-draft integration after its command API is available.
