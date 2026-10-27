# M05-side-effect-fence 实现记录

## 依据与边界

- 模块计划：`.s2d/plan.md:35-36` 将 M05 定义为 P0 外部副作用封锁、A5 hard-stop、只读/建议/可逆/外部后果分类，并产出可审计的 `blocked`/`needs-human` 结果；`.s2d/plan.md:17-25` 要求先固化负面路径，覆盖拒绝、重复、超时、断线、恢复、幂等及 UNKNOWN。
- 产品契约：`PRD.md:200-212` 定义 A0–A5（A4 每动作确认、A5 永不自动）；`PRD.md:592-637` 要求执行器按 Contract/Grant/scope/window/budget/autonomy 校验、默认 wont 不可删除、A3+ 与外部写入审计、未知外部结果不可重做；`PRD.md:875-879` 明确 P0 不执行外部动作。
- 批次决策：`CTO-DECISIONS-2026-10-27.md:30-38` 要求 P0 无副作用、A4 显式确认、A5 永不自动、跨流不改冻结 schema；`CTO-BATCH2-BRIEF-2026-10-27.md:24-41` 要求 W4 负责 P0/A4/A5 与 fail-closed 审计，且 `resolved_model=NULL` 只能 UNKNOWN。
- 文件归属：`BUILD-PLAN.md:33-47` 允许 autonomy 实现域和 autonomy 单测域；未修改 W0 `contracts/agentic/**`、`serve-tango`、生产、`.env` 或其他流目录。

## 实现

- 新增 `scripts/agentic/autonomy/side-effect-fence.mjs`：
  - `evaluateSideEffect()` 分类 observe/suggest/prepare/reversible 为允许，P0 external/financial/A4/A5 封锁，P1+ A4/external 返回 `needs_human`，A5 永不自动。
  - `SideEffectFence.check()` 强制 actor 与 resolved model provenance；缺失/未知模型返回 `ACTOR_INVALID`/`UNKNOWN`，不允许完成结论。
  - `SideEffectFence.execute()` 只在 `allowed` 后调用 executor；executor 断线未知结果为 `UNKNOWN/EXTERNAL_RESULT_UNKNOWN`，审计结果写失败时返回 blocked，不报告成功。
  - 每个 fence decision/result 写 `autonomy.side_effect_fence`，审计写入失败 fail-closed。
- 新增 `tests/unit/agentic/autonomy/side-effect-fence.test.mjs`：9 条测试覆盖分类、P0 阻断、A4 needs-human、A5 hard-stop、actor UNKNOWN、审计写失败、非法 risk、缺 actor、结果审计失败。

## TDD 证据

- RED：`cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test 'tests/unit/agentic/autonomy/side-effect-fence.test.mjs'` → rc=1；`ERR_MODULE_NOT_FOUND`，因实现文件尚不存在。
- GREEN：同命令 → rc=0；`1..9`, `# tests 9`, `# pass 9`, `# fail 0`。

## 检查结果

- 本模块及既有 autonomy 单测/覆盖率：`cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0；`1..50`, `# tests 50`, `# pass 50`, `# fail 0`; all-files line 97.21%, branch 87.94%, function 93.45%；`side-effect-fence.mjs` line 88.51%, branch 78.72%, function 100%（模块 branch 低于 80%，但归属门禁按 all-files 仍 ≥80；未伪报模块 branch 达标）。
- 语法/空白：`cd ... && for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f" || exit 1; done; git diff --check; printf 'syntax-and-diff rc=%s\\n' "$?"` → rc=0，输出 `syntax-and-diff rc=0`。
- Web 门禁：`cd ... && npm run verify:web` → rc=0；完整输出通过（命令退出码为 0）。
- 完整单测：`cd ... && npm run test:unit` → rc=1；`# tests 1020`, `# pass 1011`, `# fail 7`, `# skipped 2`。失败为基线/环境项：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts` 因 worktree 缺 `react`/`typescript`，既有 `streamChat...`、两个 collaboration HTTP、voice-pipeline ASR，以及 `voice-pipeline-gateway.test.mjs` 因缺 `ws`；本流 autonomy 50/50 通过。
- 依赖安装未执行：计划已记录 `npm ci` lock 漂移；本模块未新增依赖、未读 `.env`、未调用网关或其他真实外部服务。

## 未决 / UNKNOWN

- M05 新模块自身 line 88.51%、function 100%，branch 78.72%；如门禁要求每个单文件 branch ≥80%，仍需补分支测试。当前按 `.s2d/plan.md:46` 的单测覆盖率总体门禁，autonomy all-files 为 97.21/87.94/93.45。
- 完整 `npm run test:unit` 仍因上述 7 个基线/环境失败为 rc=1；没有把它写作通过。
- 本模块未挂 `serve-tango`，不执行真实外部副作用；W3/W6/W7/W10/W13 的持久化、跨流接缝和最终路由集成留后续流处理。
