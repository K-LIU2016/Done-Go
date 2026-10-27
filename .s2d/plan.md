# S2D · W7 计划 DAG（Agent Runtime / Model Router / MCP Tool Registry）

输入（唯一裁决源）：`/private/tmp/donego-w7-brief-20261027.md`。
上游设计：`design/schedule-to-delivery/PRD.md` v0.2（§4/§6.3/§6.4/§8.2/§8.3/§10.1 A4-A6/§10.5）、`BUILD-PLAN.md` §2/§3/§4、`CTO-DECISIONS-2026-10-27.md` §2/§5。
契约基线：`contracts/agentic/FROZEN = v1 b9d9bdfa0511905a95b729753b82e574adab6bb`（只读，不得修改）。
worktree：`/Users/chillbit/Proj/Done & Go/s2d/w7-runtime` @ `feat/s2d-w7-runtime`（基 W0 `60fdc73`）。
现状事实：本基线只有 W0 骨架（`scripts/agentic/{contracts.mjs,db/index.mjs,gateway-key.mjs}`）；**W2 policy/run-engine、W3 mission、W4 autonomy、W10 trace 的文件都不存在**，因此 W7 一律经注入 port 交互（W13 接 adapter），不 import 不存在的流内模块。
`npm ci` rc=1（EUSAGE：lock 缺 `sherpa-onnx-win-arm64@2.0.0`，brief 已知项，不改 lock）；targeted 测试用 `node --test` 直跑，无需 node_modules。

## 分组（并行波次；同组模块文件零交叉）

- **G1 runtime**（A4）、**G2 model-router**（A5）、**G3 tool-registry**（A6）三组文件域互不相交、可并行；
- **G4 契约一致性**（跨域测试）依赖 G1/G2/G3 产出，最后执行；
- 无跨组源文件依赖：G2/G3 自带最小 port 形状（结构化鸭子类型），G1 只 import 冻结的 `contracts.mjs` 与 `db/index.mjs`。各域自己的迁移文件（w7-1/w7-2/w7-3）按文件名排序执行、互不引用。

```
M1 runtime-ports ──────┐
M2 runtime-store ──────┼──► M3 runtime-engine ──────────────┐
                                                              ├──► M8 w7-contract-consistency
M4 model-router-core ──► M5 model-router-call ───────────────┤
                                                              │
M6 tool-registry-core ─► M7 tool-registry-mcp ───────────────┘
```

## M1 runtime-ports（G1）

文件：`scripts/agentic/runtime/ports.mjs`、`scripts/agentic/runtime/errors.mjs`、`tests/unit/agentic/runtime/ports.test.mjs`
内容：
- port 形状（纯结构定义 + 工厂校验，不实现业务）：`policyPort.check(ctx, action) → {allow, reason?, need?}`；`modelCaller(req) → {ok, content?, model?, usage?, error?}`；`toolCaller`；`spanSink`（可选记录器，trace 存储归 W6/W13）；`clock.now()`。
- `errors.mjs`：fail-closed 错误码（FORBIDDEN/BUDGET_EXCEEDED/NEED_HUMAN/UPSTREAM_UNAVAILABLE/CONTRACT_INVALID/CONFLICT，对齐 `api-error.schema.json` 枚举），message 不携带 key/敏感正文。
负面测试先行：缺 policyPort / policyPort 无 check / check 抛错 / clock 缺失 → 一律构造失败（fail closed），不静默降级。

## M2 runtime-store（G1）

文件：`scripts/agentic/runtime/store.mjs`、`scripts/agentic/db/migrations/w7-1-runtime-store.sql`、`tests/unit/agentic/runtime/store.test.mjs`
表（全部带 `owner_id`，引用 mission/contract/grant 一律为不 FK 的字符串列，避免与 W2/W3 迁移冲突）：`w7_work_orders`（+`idempotency_key` 唯一、`revision` 乐观锁）、`w7_work_results`、`w7_agent_steps`（state 按**冻结 step.schema.json** 枚举 `pending/running/succeeded/failed/paused/skipped` + `checkpoint` 载荷，UNKNOWN 记在 checkpoint 载荷与 run 级，见文末 mismatch）、`w7_unknown_outcomes`（外部结果 UNKNOWN 台账：只对账、不自动重试）。
负面测试先行：跨 owner 读写 → NOT_FOUND；idempotency key 同 key 异载 → CONFLICT；旧 revision 写入 → CONFLICT；重复 step（同 id+inputHash）→ 走检查点重放而非重执行。

## M3 runtime-engine（G1，核心）

文件：`scripts/agentic/runtime/engine.mjs`、`scripts/agentic/runtime/budget.mjs`、`tests/unit/agentic/runtime/engine.test.mjs`
`createAgentRuntime({ policyPort, modelCaller, toolCaller, store, clock, schemaDir })` → `runAgent({ actor, workOrder, contract, grantRefs, ownerCtx })`：
1. 入参 `work-order.schema.json` 校验失败 → CONTRACT_INVALID（执行上下文放独立 ctx 参数，不塞进 WorkOrder 破坏 additionalProperties:false）。
2. fail-closed 清单：policy/Grant/actor/model/contract/owner 任一缺失 → 拒绝，不产生任何副作用。
3. 纵深防御（独立于 policyPort）：`action.autonomy==='A5'` 永远拒绝；`'A4'` 必须带一次性确认凭据，否则 NEED_HUMAN。
4. budget.mjs（可注入 now）：calls/tokens/deadline 与合同 budget 窗口校验；子预算之和 ≤ 父剩余（PRD §6.4）；GrantRef scope ⊆ 父 Grant。
5. step 循环 pending→running→succeeded|failed（+paused 检查点）；每次跃迁落检查点；暂停/恢复只能从检查点续跑，resume 时重验 contractHash + 重跑 policyPort.check + 用新 now 重验预算。
6. modelCaller 返回无 `model` 来源 / resolvedModel 为空 → 记 UNKNOWN，**不得**生成 status=done 的 WorkResult。
7. 输出先过 `work-result.schema.json` 校验再返回；spent 如实（免费 0、未知写未知）。
负面测试先行（brief 清单逐条）：跨 owner、Grant 不匹配、A4 未确认、A5、无 resolved model、无 policy port、预算超限、窗口外（注入时钟）、重复 step、旧 revision、transport 结果 UNKNOWN、暂停后无检查点恢复/恢复时 hash 变、idempotency 冲突。

## M4 model-router-core（G2）

文件：`scripts/agentic/model-router/router.mjs`、`tests/unit/agentic/model-router/router.test.mjs`
纯选择函数：`(taskClass, dataClass, {actor, budget, localAvailable}) → { status:'selected'|'unknown', model?, provider?, locality:'local'|'cloud', provenance{rule, inputsHash, decidedAt}, reason }`。
- 规则表：sensitive → 仅 local；secret → 永不进模型（直接拒）；无规则命中 → UNKNOWN（不猜默认模型）。
- Codex 代码路径产出须经 `codex-choice.schema.json` 校验（luna/sol/6.1-sol + effort + rateLimit）。
- 测试不依赖时钟：provenance.decidedAt 用注入 now；每条规则正例 + dataClass 越界/空输入/预算为 0 反例。

## M5 model-router-call（G2）

文件：`scripts/agentic/model-router/call.mjs`、`scripts/agentic/model-router/transport.mjs`、`scripts/agentic/db/migrations/w7-2-model-router.sql`、`tests/unit/agentic/model-router/call.test.mjs`
- `transport.mjs`：OpenAI-compatible transport 接口 + `createChatTransport({ baseUrl, apiKey, fetch, timeoutMs })`——**key 只经注入**（运行期由 `gateway-key.mjs` 供 W13 接线；本流不读不打印），fetch 可注入，测试全 mock，绝不联网。
- `call.mjs`：`complete(taskClass, messages, {dataClass, actor, ownerId, budget, localAvailable})` = router 选择 → 记账 → transport 调用（select port 鸭子类型同 M4 selectModel：localAvailable 原样透传、now 由注入 clock 派生，`select: selectModel` 可直接接线） → 结果必须带模型来源（response.model / 选择 provenance），否则 UNKNOWN；timeout → UPSTREAM_UNAVAILABLE、403 → FORBIDDEN，错误结构化上抛不吞。
- 台账表 `w7_model_selections`（owner_id、actor、task_class、data_class、model 或 NULL=UNKNOWN、provenance、status）；**actor 显式绑定模型**：无 resolved model 记 UNKNOWN，不得视为完成。
负面测试先行：transport timeout、403、返回无 model、router UNKNOWN、secret dataClass、预算耗尽、跨 owner 查台账。

## M6 tool-registry-core（G3）

文件：`scripts/agentic/tool-registry/registry.mjs`、`tests/unit/agentic/tool-registry/registry.test.mjs`
- 能力清单登记：manifest 以冻结 `connector.schema.json` 校验（transport mcp-http/mcp-stdio(bridge)、reads[].scope/dataClass、risk、quota、processing、retention）+ 工具级 inputSchema；`listTools(grant)` 按 Grant scope 过滤。
- `call(tool, args, ctx)`：未登记 → 拒；然后 `policyPort.check`（注入）；工具输入越 inputSchema、资源 scope 越界、dataClass 不在合同 dataDisclosure（sensitive 未授权 local、secret 永拒）、预算/配额超限、Grant 不匹配 → 任一命中即拒并记审计。
- 外部内容只作数据：结果包成 `{kind:'external-content', data}`；检出"改变指令/越权"式载荷 → 标记隔离进 evidence，绝不改 WorkOrder/合同/权限。
负面测试先行：未登记工具、scope 越界、disclosure 越界、quota 超限、Grant 不匹配、恶意外部内容、缺 policyPort。

## M7 tool-registry-mcp（G3）

文件：`scripts/agentic/tool-registry/mcp.mjs`、`scripts/agentic/db/migrations/w7-3-tool-registry.sql`、`tests/unit/agentic/tool-registry/mcp.test.mjs`
- MCP 客户端薄封装：transport 接口（HTTP/stdio 形状，**全部注入 mock**，不引 MCP SDK、不联网、不新增依赖）；initialize/listTools/callTool 流程 + 超时/错误结构化（UPSTREAM_UNAVAILABLE）。
- 调用全链路：manifest 登记（M6）→ policy check → invoke → 结构化结果 + `w7_tools`/`w7_tool_calls` 审计表（owner_id、grant_id、policy 判定、结果摘要、外部 ID、UNKNOWN 台账不重试）。
负面测试先行：transport 超时/断连、返回非结构化内容、重复调用幂等、调用中 Grant 被撤销 → fail closed。

## M8 w7-contract-consistency（G4）

文件：`tests/unit/agentic/contracts/w7-contract-consistency.test.mjs`（只新增验证，不改 schema）
- 用 M3/M5/M7 真实产出的 WorkOrder/WorkResult/Spend/Evidence/Step/CodexChoice 逐一对冻结 schema `assertValid`；吃下 `contracts/agentic/fixtures/{work-order,work-result,grant-ref,spend,evidence,step,connector,codex-choice}.fixtures.json` 的 valid 样例；invalid 样例必须被拒。
- 校验 FROZEN 仍为 `v1 b9d9bdfa0511905a95b729753b82e574adab6bb`，schema 目录未被本流改动（git status 断言）。

## 门禁（实现节点执行，非本节点）

1. targeted（实测修订 2026-10-27：本机 Node v22.22.2 的 `node --test` 不接受裸目录参数，报 `Cannot find module <dir>`，对 W0 已有目录同样复现；必须用文件通配形式）：
   `node --test --experimental-test-coverage tests/unit/agentic/runtime/*.test.mjs tests/unit/agentic/model-router/*.test.mjs tests/unit/agentic/tool-registry/*.test.mjs tests/unit/agentic/contracts/w7-contract-consistency.test.mjs`，rc=0，逐模块+aggregate line/branch/function ≥80%。
2. `npm run verify:web`、`npm run test:unit` 按实际 rc 记录（node_modules 缺失的影响如实写，不隐藏）。
3. `git diff --check`、工作树干净、push 分支 + `git ls-remote` 回读；不推 main、不 force、不 `--no-verify`。
4. 端口段 17681–17689 仅测试内使用；不挂载 serve-tango；不碰 W0/W3/W4/W6/W10 文件与 `contracts/agentic/**`。

## 文档↔代码 mismatch（按现有代码/冻结契约为准，报告需列出）

1. brief 裁决⑥"step 状态至少 pending→running→succeeded|failed|**unknown**"，但冻结 `step.schema.json` 的 state 枚举为 `pending/running/succeeded/failed/paused/skipped`（无 unknown）；`run.schema.json` 才有 `unknown`。→ 实现遵循冻结 schema：UNKNOWN 落在 step.checkpoint 载荷 + run 级 state=unknown + `w7_unknown_outcomes` 台账，语义等同"步骤结果未知、不得自动重试"。
2. CTO-DECISIONS §4 批次二表中 W7 行写"准备、live、reviewing、delivered"，这些是 Mission 状态（mission.schema.json），归 W3 mission-service；本流按 brief（更晚、唯一裁决源）只做薄运行时，不改 Mission 状态机。
3. PRD §10.1 A6 建议用 `@modelcontextprotocol/sdk`，但 BUILD-PLAN §2.3 禁新增运行时依赖且 brief 红线⑤"不新增依赖"→ 自写最小 MCP 消息封装（transport 注入）。

## 红线自查（每模块收尾过一遍）

不碰 Done-Go 主仓/classic/thinkpad/生产/LiteLLM/.env；不读写打印 key/Authorization/cookie；同组模块文件零交叉；TDD 负面路径先行；确定性时钟（预算窗口/expiry/checkpoint 全部注入 now/clock）；外部调用全 mock 不联网；大产出写文件，ask 回 ≤30 行。
