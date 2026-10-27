# M09-route-harness 实现记录

## 契约映射与负面路径

- `.s2d/plan.md:39-48`：M09 导出 `createAutonomyRoutes`/纯服务入口，串联策略、确认、审计、幂等与恢复；不挂 `serve-tango`、不执行真实外部动作；A4 逐次确认、A5 不自动、UNKNOWN/fail-closed。
- `BUILD-PLAN.md:45-47,56-66`：路由模块只导出可挂载函数，Node ESM、零新增依赖、TDD；不改 `serve-tango`、冻结 W0 schema、生产或 `.env`。
- `PRD.md:194-212,276-281`：合同前禁止外部后果；A4 每次动作独立确认；A5 永不自动。
- `CTO-BATCH2-BRIEF-2026-10-27.md:28-41`：W4 保持 P0 无外部副作用、A4 显式确认、A5 不自动执行；跨流以接口进入。

负面路径先固化在 `route-harness.test.mjs`：不支持的 method/path → 404；缺失上下文 → 400 `CONTEXT_INVALID`；确认写审计失败 → 400 `AUDIT_WRITE_FAILED`；恢复 UNKNOWN 不重做；execute 只调用注入的 dry-run executor，不连接真实外部系统。

## 实现

- `scripts/agentic/autonomy/runtime.mjs:1-155`：增加 `decide()` 纯策略入口；`perform()` 默认 dry-run 且对空输入 fail-closed；`createAutonomyRoutes()` 导出 POST `/api/autonomy/decide`、`/confirm`、`/execute`、`/recover`，统一 JSON 风格结果与异常映射；confirm 发放后写 `autonomy.confirmation.issued` 审计；execute/recover 使用 runtime 的幂等结果与 UNKNOWN 恢复保护。
- `tests/unit/agentic/autonomy/route-harness.test.mjs:1-116`：6 条 TDD 路由测试，覆盖纯决策无执行、A4 token+审计、dry-run 幂等、UNKNOWN 恢复不重做、404/坏输入、审计失败。

## TDD 与验证证据

- RED（本 ask）：`cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test tests/unit/agentic/autonomy/route-harness.test.mjs` → rc=1，4 tests/0 pass/4 fail；失败分别暴露旧 harness 仅支持 decide、decide 错误地执行 dry-run、confirm/execute/recover 路由不存在、空 body 抛 TypeError。
- GREEN（本 ask）：同一命令 → rc=0，6 tests/6 pass/0 fail。
- 本流 autonomy 全测：`node --test tests/unit/agentic/autonomy/*.test.mjs` → rc=0，73 tests/73 pass/0 fail。
- 覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0；all files line 97.67%、branch 85.37%、function 91.13%。
- 语法/空白：`for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f" || exit 1; done; git diff --check` → rc=0，无输出。

## 边界与依赖

- 本模块只修改 `scripts/agentic/autonomy/runtime.mjs`、`tests/unit/agentic/autonomy/route-harness.test.mjs`、本记录；未改 W0 schema、`serve-tango`、生产、主仓、ThinkPad、`.env` 或其他流文件。
- 未新增依赖、未读取/打印 gateway key、未执行真实外部动作。
- 全仓门禁与提交结果由收口报告记录；本 ask 未将未运行或失败的全仓检查写成通过。
