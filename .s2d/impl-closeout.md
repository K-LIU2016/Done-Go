# S2D-W2 M7 实现记录：closeout

日期：2026-10-26
模块：closeout（组 4）

## 依据与归属

- 模块文件清单取自 `.s2d/plan.md:124-137`：`scripts/agentic/engine/index.mjs` 与 `tests/unit/agentic/engine/engine-suite.test.mjs`。
- W2 全局文件归属、TDD、覆盖率和门禁取自 `BUILD-PLAN.md:34-48`、`:57-80`；W2 目标取自 `BUILD-PLAN.md:103-110`。
- 跨模块黄金路径测试覆盖 M1 hash/db、M2 event-clock、M3 run-engine、M4 policy、M5 outbox、M6 recovery 相关公共 API；实现代码引用均限制在 W2 engine 目录。

## 实现

- `scripts/agentic/engine/index.mjs:1-7` 新增公共 barrel，导出 DB/迁移、canonical hash、event clock、run engine、policy、outbox 工厂及辅助常量，供后续集成按稳定入口导入。
- `tests/unit/agentic/engine/engine-suite.test.mjs:16-80` 新增一个跨模块黄金路径：迁移内存库 → 合同规范化与 hash → Grant 发放/激活及 §8.2 放行 → 定时器触发 → 三步 run（含外部动作登记、派发、读回核验）→ `succeeded`，并检查审计与 verified outbox。

## 验证（本 ask 实际执行）

1. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage tests/unit/agentic/engine/`
   - 退出码 1：Node 将目录作为模块解析并报 `MODULE_NOT_FOUND`；该命令不是有效的目录收集方式，未将其伪报为通过。
2. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage tests/unit/agentic/engine/*.test.mjs`
   - 退出码 0；51 tests、51 pass、0 fail。
   - 覆盖率：all files line 97.28%、branch 83.90%、functions 84.89%；超过 ≥80% 门槛。engine 实现文件逐项 line：db 92.68%、event-clock 90.70%、hash 97.37%、index 100%、outbox 95.49%、policy 96.19%、run-engine 95.16%。
3. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && npm run verify:web`
   - 退出码 0；227 tests、227 pass、0 fail。
4. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && npm run test:unit`
   - 退出码 1；997 tests、990 pass、7 fail。失败包括计划已知的 `streamChat accepts typed content deltas…`、`independent authenticated accounts…`、`AI uses selected shared fields…`，以及本基线另外出现的 `src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`replays a multi-clause recording…`、`tests/unit/voice-pipeline-gateway.test.mjs`；未修改这些归属外文件。
5. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && git diff --check && node --check scripts/agentic/engine/index.mjs && node --check tests/unit/agentic/engine/engine-suite.test.mjs`
   - 退出码 0；无 whitespace、语法错误。

## 越权用例复核

M4 单测 `tests/unit/agentic/engine/policy.test.mjs:165-191` 共 26 条，满足 ≥20：

- CASE-01 黄金允许；CASE-02 能力不在 Grant；CASE-03 资源越界；CASE-04 未披露 dataClass；CASE-05 modelCalls 预算溢出；CASE-06 预算等于上限；CASE-07 tokens 预算溢出。
- CASE-08 早于准备窗；CASE-09 准备窗边界；CASE-10 结束边界；CASE-11 晚于窗口；CASE-12 A4 逐次确认；CASE-13 非法运行时 A4 仍确认；CASE-14 A5 永不自动；CASE-15 A5 清单内仍拒绝。
- CASE-16 autonomy 超合同；CASE-17 系统付款禁止；CASE-18 过期 Grant；CASE-19 已撤销 Grant；CASE-20 合同 hash 不符；CASE-21 已消费 Grant；CASE-22 proposed 未激活。
- CASE-23 过期与能力组合；CASE-24 窗口与预算组合；CASE-25 dataClasses 部分未披露；CASE-26 dataClasses 全部披露。

## 安全与待办

- 本模块及全套测试无外部真实调用（0）；未读取 gateway key、`.env`，未接触生产。`policy.mjs:36-39`、`outbox.mjs:23-29`、`run-engine.mjs:20-36` 的 SQL 值均走参数绑定；外部动作必须先 register，outbox 状态与未知对账由既有实现负责。
- `BUILD-PLAN.md:52-55` 要求 W0 冻结后做契约一致性校验；本 worktree 当前按 `.s2d/plan.md:8-10` 记录的事实，未发现 W0 contracts/冻结产物，因此该校验未运行，待 W0 冻结后补做。
- `npm ci`/lockfile 基线问题已记录在 `.s2d/plan.md:6-13`；全仓 `npm run test:unit` 的实际 7 个失败如上，不归因于 closeout 文件。
- 第 2 批接口：从 `scripts/agentic/engine/index.mjs` 导入 `openEngineDb`、`applyEngineMigrations`、`createEventClock`、`createRunEngine`、`createPolicyEngine`、`createOutbox` 及 hash 工具；服务端挂载仍按 `BUILD-PLAN.md:46-47` 由后续集成流完成。
