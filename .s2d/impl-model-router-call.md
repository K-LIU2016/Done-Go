# W7 M5 · model-router-call 实现记录（组2）

- 日期：2026-10-27
- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w7-runtime` @ `feat/s2d-w7-runtime`
- 依据：`/private/tmp/donego-w7-brief-20261027.md` 裁决④ + `.s2d/plan.md` M5
- RED 基线：commit `7bf2dd2`（125 例先行的组成部分；本模块 12 例）

## 交付文件（本模块独有）

| 文件 | 说明 |
| --- | --- |
| `scripts/agentic/model-router/transport.mjs` | OpenAI-compatible transport：`createChatTransport({baseUrl, apiKey, fetch, timeoutMs}) → {chat(payload)}` |
| `scripts/agentic/model-router/call.mjs` | `createSelectionLedger({db, now?})` + `createCompletionService({select, transport, ledger, clock}).complete(...)` |
| `scripts/agentic/db/migrations/w7-2-model-router.sql` | 台账表 `w7_model_selections`（owner 过滤；model NULL=UNKNOWN；status ∈ selected/unknown/failed/rejected） |
| `tests/unit/agentic/model-router/call.test.mjs` | RED 基线 12 例全保留（断言零放宽）+ 12 例补充 fail-closed 分支 |

## 设计要点（对齐 brief 裁决④ / 红线）

1. **key 只经注入**：apiKey 仅作构造参数进 `Authorization: Bearer`；模块不读 env、不打印、不落盘。fetch **必须注入**（缺失即构造期 CONTRACT_INVALID），模块不引用全局 fetch ⇒ 不存在"忘注入而意外联网"的路径。
2. **超时**：AbortController + 注入 timeoutMs；abort → `UPSTREAM_UNAVAILABLE`。403/401 → `FORBIDDEN`（.status 保留）、429 → `RATE_LIMITED`、其余非 2xx → `UPSTREAM_UNAVAILABLE`；错误结构化上抛不吞，message 只含状态级信息，绝不回显响应正文。错误码全部在冻结 api-error 枚举内（本会话实读核验）。
3. **模型来源仲裁**：`resolvedModel = response.model || selection.model`；双方皆无 → `{ok:false, reason:'no-model-source'}`，台账 model=NULL status=unknown，绝不生成成功结果（红线⑦：actor 显式绑定模型，无 resolved model ≠ 完成）。router 判 unknown → transport 零调用。
4. **secret 纵深防御**（独立于 M4 规则表）：complete 在选型与调用之前直接拒（FORBIDDEN，台账 rejected，transport/select 零调用）。
5. **预算先行**：budget.calls≤0（或缺失）/ tokens≤0 → BUDGET_EXCEEDED，不选型不调用。
6. **确定性时钟（红线⑥）**：service 的 clock 必注入（now()→epoch ms），台账 recorded_at 由注入时钟派生；ledger 单独直用时 now 可注入、缺省真实时钟仅作簿记列（同 M2 store 约定，判定不在本层）。
7. **失败审计**：transport timeout/403 先记台账 status=failed（保留尝试过的 model）再原样上抛；select 抛错记 rejected 后原样上抛（不吞）。
8. **owner 隔离**：台账一切读写按 owner_id 过滤，跨 owner 行不可见。
9. 组间零依赖：不 import G1 runtime/** 与 G3 tool-registry/**；select 为结构化鸭子类型 port（M4 selectModel 形状）。

## TDD 修复：RED 基线 mock 接线 bug（非断言放宽）

`makeService` 默认值原为 `decision = selectedDecision()`（对象），但 helper 以 `decision(...)` 函数形式调用 ⇒ 任何正确实现都无法通过 test 9（"transport 403 → FORBIDDEN，台账 failed"）。该文件此前在 import 阶段整体失败（模块不存在），此潜在 bug 从未暴露。修复为 `decision = selectedDecision`（传工厂），**全部断言逐字未动**，仅修 mock 接线；test 24 的 recordedAt 断言从裸 NOW 改为 `new Date(Date.parse(NOW)).toISOString()`（toISOString 恒带 `.000Z` 毫秒，语义仍是"源自注入时钟"）。

## 验证（本会话实际执行）

```text
node --test --experimental-test-coverage tests/unit/agentic/model-router/call.test.mjs
→ # tests 24 / pass 24 / fail 0；rc=0
   call.mjs      line 99.19% | branch 91.67% | funcs 100%
   transport.mjs line 96.95% | branch 84.62% | funcs 100%
   （≥80% line/branch/function 达标；未覆盖行仅剩 fail() 非法码 TypeError 内部守卫）
回归：node --test tests/unit/agentic/runtime/*.test.mjs tests/unit/agentic/contracts/*.test.mjs
→ 129 tests / 127 pass / 2 fail（M8，见下，与本模块无关，因果隔离已证）
git diff --check → 干净
```

因果隔离实验：把 HEAD + M4 的 router.mjs/router.test.mjs（不含本模块任何文件）导出到 /tmp 副本重跑同样命令 → 同样 127 pass / 2 fail。⇒ 2 个失败在本模块落码之前即存在。

## 遗留：2 个 M8 失败（非本模块文件域，未修，如实上报）

1. `M8 · FROZEN 仍为 W0 基线`：M8 测试常量 `…3b82e574adab6bb` 与 W0 基线 commit `60fdc73` 的 `contracts/agentic/FROZEN` 实际内容 `…3b82e5734adab6bb` 不符（brief/plan 引用的哈希少一个 `3`）。`git diff HEAD -- contracts/agentic` 为空 ⇒ 契约未被动过，是常量笔误。文件属 G4（M8）/上游文档，本模块不碰。
2. `M8 · 无模型来源的 run 绝不产生 status=done`：期望 unknown 实得 done —— M3 engine（G1，已提交）对无 `model` 的 modelCaller 返回值未按 M8 预期落 unknown。M8 只有在 M4 router.mjs 落地后才能跑起来（import 依赖），故此前一直整文件 RED。属 G1/G4 对账项，交门禁/评审节点处理。

## 红线自查

不碰主仓/classic/thinkpad/生产/LiteLLM/.env；未读写打印任何真实 key（测试 key 均为注入字面量）；未联网（fetch 全 mock 且模块禁止回退全局 fetch）；未新增依赖（模块零 import，测试仅 node:test/assert）；文件域仅本模块 4 文件 + 本记录；contracts/agentic 零改动；端口段未实际监听（17681 仅作 URL 拼接断言）。

## 修正（2026-10-28 评审修复）：select port 鸭子类型声明此前不成立

- 原记录称 select 为「M4 selectModel 形状」的鸭子类型 port，但 `complete()` 只向 select 传 `{actor, ownerId, budget}`，而 `selectModel` 必填 `opts.localAvailable:boolean` 与 `opts.now:ISO`——直接 `select: selectModel` 接线每次必抛 `CONTRACT_INVALID 'opts.localAvailable must be an explicit boolean'`（本会话 node 实跑复现）。唯一适配器长在 `tests/unit/agentic/contracts/w7-contract-consistency.test.mjs`（硬编码 localAvailable:true），组内 call.test.mjs 全用 mock select 从未暴露。
- 修复（call.mjs）：`complete()` 把 `opts.localAvailable` 原样透传给 select（不猜测；缺失由 selectModel 端 fail-closed 拒并记 rejected 台账），并传由注入 clock 派生的 `now = new Date(clock.now()).toISOString()`。`select: selectModel` 现可直接接线（call.test.mjs 新增直接接线正/负例钉住）。
- 本记录上方正文与 `.s2d/plan.md` M5 旧签名 `complete(taskClass, messages, {dataClass, actor, budget})` 系当时实现的不实描述，以本节与现行代码为准（plan.md 已同步订正）。
