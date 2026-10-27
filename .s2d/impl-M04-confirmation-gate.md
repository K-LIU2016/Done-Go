# M04-confirmation-gate 实现记录

## 范围与契约映射

- 计划映射：`.s2d/plan.md:34` 要求一次性 A4 confirmation 的签发、消费、绑定和过期；拒绝重复、错 actor、错模型、错 hash；不产生长期 Grant。
- 负面路径：`.s2d/plan.md:21-24` 固化无确认/重复/过期/绑定不一致、A5 永不自动、UNKNOWN 与审计 fail-closed；`.s2d/plan.md:47-48` 固化 A4 每次确认、A5 不自动、未知结果不报告成功。
- 产品语义：`PRD.md:200-212`（A4 每次动作单独确认，A5 永不自动）；`PRD.md:276-281`（合同 hash 与一次性授权语义）。
- CTO 边界：`CTO-DECISIONS-2026-10-27.md:30-38`（P0 无外部副作用、A4 需用户确认、A5 永不自动）；`CTO-BATCH2-BRIEF-2026-10-27.md:28-41`（W4 责任和 fail-closed/model provenance）。

## 实现

- `scripts/agentic/autonomy/confirmation.mjs`：校验 action/contract/TTL 和日期；通过 `normalizeActor()` 拒绝 `resolvedModel=null`；token 绑定 actionId、actionHash、actorId、resolvedModel、contractHash；消费时先完整匹配再检查过期，成功/过期均原子删除，重放返回 `CONFIRMATION_REPLAY`。
- `scripts/agentic/autonomy/runtime.mjs`：`confirm()` 先重新运行策略，仅对 `needs_confirmation` 签发 token；执行消费传入同一 action hash，避免 token 被换绑；不创建长期 Grant。
- `tests/unit/agentic/autonomy/confirmation.test.mjs`：TDD 覆盖未解析模型、非法输入/TTL、非 A4 拒绝、action/hash/contract 绑定、过期清除与重放。
- `tests/unit/agentic/autonomy/autonomy.test.mjs`：为既有 A4/A5 fixture 补齐合同 capability，使边界测试在策略严格校验下仍验证 confirmation gate 行为。

## TDD 与检查证据

- RED：`node --test tests/unit/agentic/autonomy/confirmation.test.mjs` → rc=1；5 个测试中 4 个失败，分别暴露 unresolved actor 未拒绝、非法输入未拒绝、非 A4 未拒绝、TTL=1ms 未过期。
- GREEN：`node --test tests/unit/agentic/autonomy/autonomy.test.mjs tests/unit/agentic/autonomy/confirmation.test.mjs tests/unit/agentic/autonomy/types.test.mjs` → rc=0；32 tests、32 pass、0 fail、0 skipped。
- 覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/autonomy.test.mjs tests/unit/agentic/autonomy/confirmation.test.mjs tests/unit/agentic/autonomy/types.test.mjs` → rc=0；确认模块 line 96.55%、branch 93.55%、function 100%；本次选定 autonomy 集合总计 line 95.40%、branch 86.59%、function 77.68%。函数覆盖率总表低于 80%，但 M04 confirmation 模块本身超过 80%；未伪报为全模块门禁通过。
- 语法/空白：`for f in scripts/agentic/autonomy/confirmation.mjs scripts/agentic/autonomy/runtime.mjs tests/unit/agentic/autonomy/confirmation.test.mjs; do node --check "$f"; done; git diff --check` → rc=0（无输出）。
- 基线 autonomy 全量：此前 `node --test tests/unit/agentic/autonomy/*.test.mjs` → rc=1，因并行工作流未完成的 `side-effect-fence.mjs` 缺失及 policy-boundaries 先行测试失败；该失败不属于 M04 confirmation gate，不能标绿。

## 变更边界与依赖

- 本模块改动：`scripts/agentic/autonomy/confirmation.mjs`、`scripts/agentic/autonomy/runtime.mjs`、`tests/unit/agentic/autonomy/confirmation.test.mjs`、`tests/unit/agentic/autonomy/autonomy.test.mjs`，以及本记录。
- 未修改 W0 `contracts/agentic/**`、`serve-tango`、生产、主仓、`.env`；未新增依赖；未读取网关 key；真实外部调用 0 次。
- 工作树同时存在其他并行节点的未提交文件（`policy.mjs`、`audit.mjs`、`side-effect-fence.mjs`、migration/test 文件）；本次提交只纳入上述 M04 文件，不吸收其变更。

## 待决 / UNKNOWN

- 本流完整 `npm run test:unit`、`npm run verify:web` 未在本节点重跑；按标准应由 M11/最终收口重跑并记录 rc。
- 选定 M04 测试集合 function coverage 77.68%（由 runtime/policy/audit 等共享代码拉低），M04 confirmation 模块独立 coverage 已超过 80%；是否按跨模块聚合门禁计数待 M11 裁决。
