# M02-autonomy-types 实现记录

## 范围与契约映射

- 依据：`.s2d/plan.md:32-39,44-50`；M02 要求 A0–A5、动作风险、P0 禁止项、Actor/Model provenance、decision/result 错误码与规范化函数，文件域为 `scripts/agentic/autonomy/**`；M10 测试归属为 `tests/unit/agentic/autonomy/**`。
- PRD：`PRD.md:200-212` 定义 A0–A5；`PRD.md:592-625` 要求规范化 Contract、Grant、capability/scope、预算、时间窗、自治级别与默认 deny；`PRD.md:634-637` 要求 A3+ 审计及撤权/未知外部结果不可重做。
- BUILD-PLAN：`BUILD-PLAN.md:49-66` 要求 W0 契约冻结、Node ESM、TDD、零新增依赖、文件归属与不挂 `serve-tango`。
- CTO/批次二：`CTO-DECISIONS-2026-10-27.md:30-38` 要求 P0 无外部副作用、A4 显式确认、A5 永不自动、跨流使用 adapter/projection/event；`CTO-BATCH2-BRIEF-2026-10-27.md:24-41` 要求 W4 观察到 A5 边界、审计 fail-closed、显式 model provenance 与 UNKNOWN 传播。

## 实现

- `scripts/agentic/autonomy/types.mjs`：保留并扩展 A0–A5 与六类动作风险；新增不可变 `P0_BLOCKED_RISKS`/`P0_BLOCKED_AUTONOMY`、`isP0Forbidden()`、规范化函数、稳定 decision/result 错误码词表；`normalizeActor()` 校验 actor/provider，`resolvedModel` 缺失返回 `UNKNOWN` 而非完成。
- `scripts/agentic/autonomy/policy.mjs`：复用 P0 数据边界；默认拒绝合同/Grant/owner/scope/autonomy 不满足项；P0 外部/金融或 A4/A5 自动行为封锁，A4 非 P0 仅返回逐次确认。
- 测试先行：新增 `tests/unit/agentic/autonomy/types.test.mjs`，先执行 RED，再实现 GREEN；覆盖未知 level/risk、P0 边界不可变、actor/provider malformed、resolved model UNKNOWN、error-code vocab。
- 现有 `audit.mjs`、`confirmation.mjs`、`runtime.mjs` 与 `autonomy.test.mjs` 保持在 W4 自有域，已覆盖一次性确认、重复/过期/错绑定、审计失败、UNKNOWN、幂等、断线结果与恢复不重做。

## 检查证据

- RED：`node --test tests/unit/agentic/autonomy/types.test.mjs` → rc=1；ESM 报 `does not provide an export named 'DECISION_CODES'`。
- GREEN/覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0，27/27 通过；autonomy all files line 99.60%、branch 92.18%、function 90.54%。
- 语法/空白：`for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f"; done; git diff --check` → rc=0，`node-check rc=0`。
- 完整单测：`npm run test:unit` → rc=1，997 tests / 988 pass / 7 fail / 2 skipped；失败为现有基线：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`streamChat...`、两个 collaboration HTTP、voice pipeline ASR、voice-pipeline-gateway；本流 autonomy 子测在该输出中通过。未把基线失败写成通过。
- Web 门禁：`npm run verify:web` → rc=0，227/227 通过。
- 安装基线：`npm ci` → rc=1，npm 报 `Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`；未修改 lock、未新增依赖。
- 文件审计：`git diff --name-only 60fdc73..HEAD` 与当前修改仅落在 `.s2d/` 记录、`scripts/agentic/autonomy/**`、`tests/unit/agentic/autonomy/**`；未改 `contracts/agentic/**`、`serve-tango`、生产、`.env`、主仓。
- 外部调用/密钥：0 次真实外部调用；未读取 `.env` 或网关 key。

## 未决 / UNKNOWN

- 完整 `npm run test:unit` 仍有上述 7 个基线失败；不属于本流新增失败的判定需以已有基线和测试文件归属复核。
- `npm ci` lock 漂移仍 UNKNOWN/blocked，沿用 `.s2d/plan.md:49` 事实。
- 本模块只提供纯类型与策略边界，不挂 `serve-tango`，不执行真实外部动作；W3/W6/W7/W10/W13 的接缝与持久化审计由后续流负责。

## 提交

- 提交在 flock `/tmp/donego-s2d-pw.lock` 下完成；commit hash 见终报/提交输出。
