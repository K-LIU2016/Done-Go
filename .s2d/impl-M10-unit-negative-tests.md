# M10-unit-negative-tests 实现记录

## 范围与契约映射

- `.s2d/plan.md:40-48`：M10 负责 A0–A5、拒绝/越权/重复/过期/审计失败/超时/断线/恢复/幂等/UNKNOWN/owner 隔离；只修改 `tests/unit/agentic/autonomy/**`。
- `BUILD-PLAN.md:33-66,68-80`：W4 文件归属、Node ESM、TDD、零新增依赖、单测覆盖率门禁及报告证据要求。
- `PRD.md:194-212`：合同前无外部副作用；A0/A1 观察/建议，A2 准备，A3 可逆，A4 每次独立确认，A5 永不自动。
- `CTO-DECISIONS-2026-10-27.md:30-40,60-72` 与 `CTO-BATCH2-BRIEF-2026-10-27.md:24-41`：P0 无外部副作用、A4 显式确认、A5 不自动、resolved model 缺失保持 UNKNOWN；W4 跨流不改 W0 schema。
- `prototype.html:199-228`：交互阶段为“说/看/定/交”，本模块只验证自治边界，不改前端。

## 实现内容

- 新增 `tests/unit/agentic/autonomy/m10-negative-paths.test.mjs`：11 个负面/边界测试。
- 覆盖 A0/A1 拒绝写入、A2/A3 能力和 grant scope、A4 一次性确认与 replay、A5 financial hard-stop、owner 隔离、resolved_model=NULL UNKNOWN、审计写入失败 fail-closed、timeout/client disconnect UNKNOWN 且恢复不重做、幂等重复、P0 fence、确认过期/绑定错误/replay。
- 未修改生产代码、W0 schema、`serve-tango`、其他流目录、生产、主仓、ThinkPad 或 `.env`；未新增依赖、未读取 gateway key、未执行真实外部动作。

## TDD / 验证

- RED 探索命令：`cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test tests/unit/agentic/autonomy/m10-negative-paths.test.mjs` → rc=1，11 tests/10 pass/1 fail；失败是断言过窄（恢复 UNKNOWN 结果携带已记录的 error output），已修正为断言状态/错误码，未把该次失败当作实现缺陷。
- GREEN：同一命令 → rc=0，11 tests/11 pass/0 fail。
- 本流单测+覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0，84 tests/84 pass/0 fail；all files line 97.67%、branch 86.91%、function 89.42%。
- 语法/空白：`for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f" || exit 1; done; git diff --check` → rc=0，无输出。
- 全仓 `npm run verify:web` → rc=0，227 tests/227 pass/0 fail。
- 全仓 `npm run test:unit` → rc=1，1054 tests/1045 pass/7 fail/2 skipped；失败为预存的 `src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`streamChat accepts typed content deltas...`、`independent authenticated accounts...`、`AI uses selected shared fields...`、`replays a multi-clause recording...`、`tests/unit/voice-pipeline-gateway.test.mjs`。这些失败均在 M10 文件域之外；本流 autonomy suite 全绿。

## 状态

- 依赖申请：无。
- 真实外部调用：0。
- 待决/UNKNOWN：全仓已有失败仍需由其 owner 对账；M10 的未知外部结果测试明确保持 UNKNOWN 且不重试。
