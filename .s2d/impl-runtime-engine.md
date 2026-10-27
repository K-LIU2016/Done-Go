# M3 runtime-engine 实现记录

- 模块：`scripts/agentic/runtime/engine.mjs`、`scripts/agentic/runtime/budget.mjs`、`tests/unit/agentic/runtime/engine.test.mjs`（plan.md M3，组1）。
- RED 基线：commit `7bf2dd2` 已含 engine.test.mjs（29 cases）；实现前实测
  `node --test tests/unit/agentic/runtime/engine.test.mjs` → 整文件 `not ok 1`（ERR_MODULE_NOT_FOUND：engine.mjs/budget.mjs 不存在）。
- 新增实现：
  - `budget.mjs`：`createBudgetTracker({contract, workOrder, now})`（now 接受 epoch-ms 数字或 now() 函数，缺失 fail closed）
    → `assertWithinWindow`（早于 window.prepStart→FORBIDDEN；晚于 min(window.end, workOrder.deadline)→BUDGET_EXCEEDED）、
    `assertCanSpend`（spent+请求 ≤ 工单 calls/tokens 双轴）、`charge`、`snapshot`（含注入 now）；
    `assertChildBudgetsWithinParent`（子预算之和 ≤ 父剩余，父轴缺省不约束，PRD §6.4）；
    `assertGrantRefsSubset`（grantId 必须命中父 Grant；scope 等值或同 capability '/' 边界子路径才算子集）。
  - `engine.mjs`：`createAgentRuntime({policyPort, modelCaller, toolCaller?, spanSink?, store, clock, schemaDir})`
    → `runAgent({actor, workOrder, contract, grantRefs, ownerCtx, steps, idempotencyKey?})` / `resumeAgent({runId, actor, ownerCtx, contract?})`：
    1. Phase A 入参校验（零副作用）：workOrder 过冻结 work-order.schema.json、contract 过 contract.schema.json、
       grantRefs 逐条过 grant-ref.schema.json、ownerCtx.ownerId 与 contract.ownerId 必须一致（跨 owner → FORBIDDEN）；
       执行上下文走独立 ctx，不塞进 WorkOrder。
    2. 前置检查：policyPort.check('run.start')——显式拒绝→failed outcome；check 抛错（基础设施故障）→ 原样上抛（不吞成 allow/outcome）；
       ownerCtx.parentGrants 注入时做 GrantRef 子集校验；预算窗口（注入 now）不过 → failed outcome。
    3. step 循环：pending→running→succeeded|failed|paused 每次跃迁落 store（复用 M2 幂等/跃迁表）；
       重复 step（同 id+inputHash）检查点重放不二次执行；暂停存检查点（含 doneSteps/next），无 WorkResult。
    4. ctx.modelCall：纵深防御（A5 永拒 FORBIDDEN；A4 无一次性 confirmation.token → NEED_HUMAN，独立于 policyPort）
       → policyPort.check → 预算 assertCanSpend → 注入 modelCaller；结果无 model 来源 → recordUnknownOutcome 台账 +
       run 级 unknown，绝不生成 done WorkResult（红线⑦）；ok:false → 结构化上抛（UPSTREAM_UNAVAILABLE/FORBIDDEN）。
       ctx.toolCall：同防御+policy；未注入 toolCaller → FORBIDDEN。
    5. 恢复：仅 paused 可恢复（否则 CONFLICT）；重验 contractHash（变化→CONFLICT）、重跑 policyPort.check（拒绝→FORBIDDEN 上抛）、
       用新 now 重验预算窗口（越 deadline→BUDGET_EXCEEDED）、从 checkpoint（next 优先，缺省按 doneSteps 跳过）续跑；
       跨 owner → NOT_FOUND；actor 不匹配 → FORBIDDEN；checkpoint.next 指向不存在步骤 → CONTRACT_INVALID。
    6. 输出：WorkResult 先过冻结 work-result.schema.json 再返回/落库；unknown/paused 不生成 WorkResult；
       spent 取自 tracker.snapshot（如实：免费 0、costCny 缺省=未知）。
    7. 幂等：idempotencyKey 缺省自动取 `auto:<workOrder canonical hash>`；同 key 同载重放（含落库结果直读），异载/同 id 异载 → CONFLICT。
- 测试：追加 18 cases（0 删除；唯一 diff 删除行是 freshRuntime 助手签名扩展以转发 spanSink/toolCaller 注入，属测试 harness 补洞，
  既有 29 cases 原文未动且全过）。追加覆盖：toolCall 三态（拒/未注入/正例）、spanSink 事件、决策形状非法、跨 owner runAgent、
  grantRef/steps/idempotencyKey 形状负例、步骤返回非对象、ok:false 无 error 对象、无模型来源→unknown+台账、自动幂等键重放、
  paused 重放、仅 doneSteps 续跑、恢复负例三连、parentGrants 子集（run+resume）、budget 负例集、GrantRef 子路径/形状集、
  失败落库失败不吞错。
- 实测修复记录（测试侧缺陷，非放宽断言）：追加测试初版三处 harness/fixture 缺陷——freshRuntime 不转发 spanSink/toolCaller、
  同 runtime 同工单触发自动幂等重放/同 id 异载 CONFLICT（换工单 id+负载）、resume fixture 的 checkpoint.next 指向不存在步骤；
  修复后全绿。实现侧修 1 个真 bug：budget.mjs `nonNegativeInteger` 漏 `throw`（failClosed 只调用未抛出，负数花费被静默放过），
  由追加负例 charge({calls:-1}) 暴露，已修。

## 检查（全部本节点实测）

- GREEN：`cd '/Users/chillbit/Proj/Done & Go/s2d/w7-runtime' && node --test tests/unit/agentic/runtime/engine.test.mjs`
  → rc=0，`# tests 47 / # pass 47 / # fail 0`。
- 组1 全绿：`node --test tests/unit/agentic/runtime/*.test.mjs` → `# tests 98 / # pass 98 / # fail 0`（ports 20 + store 31 + engine 47）。
- 覆盖率（逐模块，gate 1 同款命令）：`node --test --experimental-test-coverage tests/unit/agentic/runtime/engine.test.mjs`
  → engine.mjs line 97.02 / branch 87.77 / funcs 100.00；budget.mjs line 96.94 / branch 94.38 / funcs 93.33（均 ≥80）。
- W7 targeted 全 glob（plan 门禁 1 命令原样）：`node --test --experimental-test-coverage tests/unit/agentic/runtime/*.test.mjs
  tests/unit/agentic/model-router/*.test.mjs tests/unit/agentic/tool-registry/*.test.mjs
  tests/unit/agentic/contracts/w7-contract-consistency.test.mjs` → `# tests 103 / # pass 98 / # fail 5`：
  5 个 fail 全部为 M4–M7/M8 的 RED 基线（model-router/tool-registry 实现文件尚不存在，ERR_MODULE_NOT_FOUND），
  属组2/组3/组4 并行工作，非本模块回归；runtime 组在同一运行内 98/98 全绿。
- 语法：`node --check scripts/agentic/runtime/engine.mjs && node --check scripts/agentic/runtime/budget.mjs` → rc=0。
- 红线自查：两实现文件仅 import `node:crypto`、冻结 `../contracts.mjs`、组1 自有 `./errors.mjs`/`./ports.mjs`/`./budget.mjs`；
  无 `Date.now()`/`new Date()`（时间全部经注入 clock，ISO 仅由注入 ms 换算）、无 process.env/.env、无 fetch/http/网络、
  无 key/Authorization/cookie 读写打印（grep 仅命中注释里的禁令说明）；未触碰 W0/W3/W4/W6/W10 文件与 `contracts/agentic/**`。
- 未运行：`npm ci`/`verify:web`/`npm run test:unit`/lint（属门禁节点；npm ci 已知 rc=1 lock 缺 sherpa-onnx-win-arm64）。
- 对 M8 的接口事实：happy path 产出的 WorkResult 已当场过 `validate(workResultSchema)` 断言（engine.test.mjs 正例），
  w7-contract-consistency 可直接复用 `createAgentRuntime` + `freshRuntime` 形状取真实产出。

## 设计裁决（测试钉住的行为，供 M8/W13 对账）

- policyPort 显式拒绝（{allow:false}）→ runAgent 收场 failed outcome（有失败 WorkResult）；check 抛错 → runAgent 直接 reject。
  恢复路径两者都 reject（FORBIDDEN）。理由：拒绝是可审计的运行结果，端口故障是基础设施错误。
- 前置 Grant 子集/窗口/预算不满足 → failed outcome（零模型调用），与显式拒绝同型；结构性入参问题（schema/形状）→ reject。
- run 级注册表为引擎内存态（steps 是闭包，不可序列化）；SQLite 台账（工单/结果/步骤/UNKNOWN）全走注入 store。
  W13 接线时 resume 必须回到同一 runtime 实例，或由 adapter 重建 steps 后按 checkpoint 续跑。
- 自动幂等键绑定 (ownerId, workOrder canonical hash)：同 id 同载重放结果、同 id 异载 CONFLICT——重试须换工单（新 id 或 revision），
  与"UNKNOWN 不得自动重试"一致。
