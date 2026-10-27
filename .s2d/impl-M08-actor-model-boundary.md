# M08-actor-model-boundary 实现记录

## 契约映射与负面路径

- `.s2d/plan.md:38,46-49`：M08 必须显式绑定 actor→resolved model，缺失/NULL 模型为 UNKNOWN，不得形成完成结论；跨流通过事件接口输入。
- `PRD.md:200-212,615-637`：A4 每动作确认、A5 永不自动；工具动作按 Contract/Grant 校验；审计与未知结果必须可追溯且 fail-closed。
- `CTO-DECISIONS-2026-10-27.md:30-38,74-84`：P0 无外部副作用；跨流用 adapter/projection/事件接口；未知证据保持 UNKNOWN；actor 必须显式绑定模型。
- `CTO-BATCH2-BRIEF-2026-10-27.md:24-41,45-57`：W4 负责自主边界与审计；`resolved_model=NULL` 只能 UNKNOWN；禁止跨流直接改冻结 schema。
- 负面路径先固化：未知/缺失模型不完成；事件缺少 eventId/owner/timestamp 拒绝；完成类事件带 UNKNOWN provenance 时强制 UNKNOWN；非完成事件只保留来源状态，避免错误升级。

## 实现

- `scripts/agentic/autonomy/actor-model-boundary.mjs`：新增 `normalizeActorProvenance`/`validateActorModel`、`completionVerdict`、完成事件白名单、`normalizeAutonomyEvent` 和保守的 `isCompletionEvent`；保留 requested/resolved model、provider、actor 状态，NULL/空模型只生成 UNKNOWN。
- `scripts/agentic/autonomy/audit.mjs`：审计事件统一经 actor/model boundary 展开 provenance；完成事件遇未知模型强制记录 `status=UNKNOWN` 与 `ACTOR_MODEL_UNKNOWN`，不报告成功；跨流事件字段仍放在已有 payload 结构，不改 W0 schema。
- `tests/unit/agentic/autonomy/actor-model-boundary.test.mjs`：8 条 TDD 测试覆盖 resolved/UNKNOWN、坏 actor、完成判定、事件归一化、未知完成事件、缺身份/坏时间、事件分类。

## TDD 与门禁证据

- RED（本 ask 实际执行）：`cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test tests/unit/agentic/autonomy/actor-model-boundary.test.mjs` → rc=1；`ERR_MODULE_NOT_FOUND`，目标 `actor-model-boundary.mjs` 尚不存在。
- GREEN（本 ask 实际执行）：`node --test tests/unit/agentic/autonomy/actor-model-boundary.test.mjs` → rc=0；8 tests、8 pass、0 fail。
- 本流 autonomy 覆盖率（本 ask 实际执行）：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0；67 tests、67 pass、0 fail；all-files line 97.37%、branch 84.09%、function 91.06%；新增 `actor-model-boundary.mjs` line 95.70%、branch 85.29%、function 100%。
- 语法/空白（本 ask 实际执行）：`for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f" || exit 1; done; git diff --check; printf 'syntax_and_diff_rc=0\\n'` → rc=0，输出 `syntax_and_diff_rc=0`。
- `npm run verify:web`（本 ask 实际执行）→ rc=0；命令完整通过。
- `npm run test:unit`（本 ask 实际执行）→ rc=1；1037 tests、1028 pass、7 fail、2 skipped。失败项：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`streamChat accepts typed content deltas and a clean close without an explicit done marker`、两个 collaboration HTTP 测试、voice-pipeline ASR 回放、`tests/unit/voice-pipeline-gateway.test.mjs`；未将全仓结果写成通过。

## 文件边界、依赖与未知项

- 本次新增/修改仅：`scripts/agentic/autonomy/actor-model-boundary.mjs`、`scripts/agentic/autonomy/audit.mjs`、`tests/unit/agentic/autonomy/actor-model-boundary.test.mjs`、本记录；未改 `contracts/agentic/**`、`serve-tango`、主仓、生产、ThinkPad 或 `.env`，未新增依赖、未调用真实外部服务或读取 gateway key。
- 当前工作树另有 M07 未跟踪文件 `scripts/agentic/db/migrations/autonomy-002-idempotency-recovery.sql` 与 `tests/unit/agentic/autonomy/idempotency-recovery.test.mjs`，本次未纳入 M08 提交；其归属/提交状态待批次协调时对账。
- 完整 `npm run test:unit` 仍 UNKNOWN/blocked 于上述 7 项既有失败；`npm ci` lock 漂移沿用 `.s2d/plan.md:50`，本 ask 未重跑且未改 lock。
