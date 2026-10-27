# S2D · W10 可观测性与运行证据 · 计划 DAG

> 状态：规划（本文件为 plan-of-record）。worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability`
> 分支 `feat/s2d-w10-observability`，基 W0 `60fdc73`（`contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`，本 ask 内 cat 验证）。
> 上游：`PRD.md` §4/§5.4/§5.6/§6.3/§8.2/§8.4/§10.4/§10.5/§10.6/§12、`BUILD-PLAN.md` §2.1–§2.5/§3、`CTO-DECISIONS-2026-10-27.md` §2/§3/§4/§5、`CTO-BATCH2-BRIEF-2026-10-27.md` §3/§4/§5、`prototype.html`（块抽屉「进行中/追踪」标签、活动条目 `text`+`why`、交付台泳道）。
>
> **本轮为 provenance 补齐重跑**：原轮规划 actor（deepseek）额度耗尽，DB 记录 `resolved_model=NULL`（缓存导入）；本文件由当前绑定模型（`b5c1cfc7-f526-421b-9f6d-010a794d37d7/glm-5.3`）重新执行规划派生。模块 DAG 与前轮执行记录（`.s2d/impl-obs-*.md`）保持同名同组，保证下游节点键稳定。

## 0. 本 ask 实测基线（2026-10-27，本会话执行）

| 命令 | rc | 结果 |
|---|---:|---|
| `npm ci` | **1** | `EUSAGE`：`Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`（debug log `2026-10-27T01_47_46_700Z`）。成因：`package.json:36` `"sherpa-onnx-node": "^2.0.0"` 的平台可选依赖未进 lock；两文件最后一次变更在 `65efc27`（W10 之前）。与批次一矩阵登记一致，非本流引入；`node_modules` 不存在。本流只用 `node:*` 与仓库内 ESM，`node --test` 可跑（下行实证）。 |
| `node --experimental-strip-types --test tests/unit/agentic/contracts/contracts.test.mjs` | 0 | `# tests 12 / # pass 12 / # fail 0`，48ms——W0 冻结契约套件在无 node_modules 条件下可用 |
| `git diff --name-only 60fdc73 HEAD \| sed … \| sort -u` | 0 | 分支改动仅落在 `.s2d/`、`scripts/agentic/observability/`、`scripts/agentic/db/migrations/`（obs-*）、`tests/unit/agentic/observability/`——全部在 §2.1 归属内 |

前轮规划节点登记的全量基线（本次未重跑，引用前轮记录）：`npm run test:unit` rc=1，970 tests / 961 pass / **7 fail** / 2 skip；`npm run verify:web` rc=0，227/227。

### 0.1 基线失败集合（本流门禁只允许这 7 条）

BUILD-PLAN §2.4.2 明列 3 条：`streamChat accepts typed content deltas…`、`independent authenticated accounts…`、`AI uses selected shared fields…`；批次一矩阵另登记 4 条预存：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`replays a multi-clause recording…`、`tests/unit/voice-pipeline-gateway.test.mjs`。本流门禁：失败集合与上表**完全一致**（不多不少）。

## 1. 本流边界（BUILD-PLAN §2.1 + 红线 3）

只可新增/修改：

```
scripts/agentic/observability/**            # 全部实现
scripts/agentic/db/migrations/obs-*.sql     # 只加 obs_ 前缀表
tests/unit/agentic/observability/**         # 单测
.s2d/plan.md                                # 本文件
```

禁止：`contracts/agentic/**`（W0 冻结 b9d9）、`scripts/agentic/contracts.mjs`、`scripts/agentic/db/index.mjs`、他流目录（engine/block-store/perception/media/…）、`scripts/serve-tango.mjs`、`scripts/build-web.mjs`、`web/**`、发布清单、Done-Go 主仓 / Done-Go-classic / thinkpad / 生产 / LiteLLM / .env。跨流消费走只读 + adapter/projection（CTO-DECISIONS §2）：W1 DTO→adapter、W11 timeline→projection、跨流状态→事件接口，**不改写 W0 schema**。

端口 17691–17699；Playwright（仅 obs-routes 若加 e2e）须 `flock -w 900 /tmp/donego-s2d-pw.lock`，全局 ≤2 spec 进程。

## 2. 契约映射（先写映射，再编码）

### 2.1 逐字段映射（依据本会话实读的 schema）

| W0 契约（实测 required/enum） | W10 投影 | 规则 |
|---|---|---|
| `span.schema.json`：required `id,name,kind,startedAt,status`；`kind`∈{invoke_agent,execute_tool,chat,donego.need}；`status`∈{running,ok,error}；顶层 `additionalProperties:false`，`attributes` 为自由 object | `obs_spans`（id,parent_id,name,kind,started_at,ended_at,status,owner_id,run_id,input_ref,output_ref,error,attributes_json） | 新信息只进 `attributes`，禁改 schema |
| `span.attributes` | 抽取列 `request_model`/`actor_role`/`actor_model`/`resolved_model`/`model_source`/`model_local` | 键名常量集中 `vocabulary.mjs`，禁散落字面量（PRD §10.5 span 属性约定） |
| `run.schema.json`：required `id,missionId,contractHash,state,startedAt,updatedAt`（§4.2 八态 queued→…→succeeded/partial/failed/unknown/cancelled） | `obs_run_metrics` 每 run 一行 | run 表为状态权威，观测层只读、不做状态机 |
| `step.schema.json`：required `id,runId,name,kind,state,attempt`；`kind`∈{plan,schedule,execute,verify,merge} | `obs_step_metrics` | 重试 = 同 inputHash 的 `attempt>0`；重放不重复计数 |
| `spend.schema.json`：required `calls,tokens`；可选 `costCny,localShare` | `obs_cost` 聚合 | `costCny` 缺失 → **UNKNOWN，不得写 0**（PRD §10.6「未知显示未知」；显式免费与缺失必须可区分） |
| `evidence.schema.json`：required `type,title`；可选 `verified` | `obs_gates.evidence_json` | gate 必挂 evidence；`verified!==true` 不计通过（PRD §5.6 证据区） |
| `acceptance`（decision） | 验收率派生 | 仅 `accepted` 计收益（P5：估算不是收益） |
| `need`（defaulted/expired）、`grant`（invalidated/expired） | 打扰/超时/越权拦截指标 | 只读对齐 policy 事件（PRD §5.5、§8.4） |

### 2.2 actor/model provenance（红线 7 + BRIEF §3/§4.5）

1. 每个 actor（L0 Conductor / L1 Block Agent / L2 Worker / verifier / reviewer / fixer）必须带 `actor.role` + `actor.model`（PRD §6.1 分层）。
2. `actor.model` 未解析 → `resolved_model=NULL` + provenance=`UNKNOWN`；**禁止回填、猜测、从相邻 actor 继承**（CTO-DECISIONS §3.3：不能解析的 actor 不得产生通过结论）。
3. `assertActorResolved(actor)` 对 UNKNOWN 抛 `PROVENANCE_UNRESOLVED`；`markRunComplete()` 遇任一 UNKNOWN actor 抛 `RUN_NOT_VERIFIABLE`，run 只落 `partial`/`unknown`。
4. 模型来源（gateway/mock/fixture）单记 `model_source`；mock/fixture 永不计入真实调用成功（BRIEF §3 末条）。

### 2.3 stale cache 识别（内容身份，非时间戳）

```
cacheKey = sha256(canonicalJson({ kind, contractHash, blockRevision, model, effort, inputsHash }))
stale    = entry.key !== recomputeKey || entry.inputsHash !== currentInputsHash
        || entry.contractHash !== currentContractHash || entry.modelSource === 'unknown'
```

stale 条目不得进入「已验证」证据；仅时间过期但内容身份一致的标 `expired-but-matching`（不计 stale 但必须记录）——防止把缓存摘要当端到端成功（BRIEF §3）。

### 2.4 四态裁决与 UNKNOWN 传播（CTO-DECISIONS §3.7 + BRIEF §2）

`bundle.mjs` 逐项裁决，只认 `VERIFIED` / `PROVISIONAL` / `UNKNOWN` / `BLOCKED`，升级禁止越级：
- 真实端到端命令 rc=0 + 非 mock evidence → 才可 `VERIFIED`；
- mock、单测、schema 通过、进程启动成功、缓存摘要 → 最高 `PROVISIONAL`；
- 缺 test 命令/rc、缺模型 provenance、缺 web 证据 → `UNKNOWN`；
- 门禁失败或 HIGH 未修 → `BLOCKED`。

## 3. 负面路径清单（TDD 先测后码；覆盖拒绝/重复/超时/断线/恢复/幂等）

| # | 场景 | 期望 |
|---|---|---|
| N1 | 缺失/空 `actor.model` 写 span | 接受写入但标 UNKNOWN；`assertActorResolved` 抛 `PROVENANCE_UNRESOLVED` |
| N2 | 对 UNKNOWN actor 调 `markRunComplete` | 抛 `RUN_NOT_VERIFIABLE`，run 落 `partial`/`unknown`，不写 succeeded |
| N3 | 同一 span id 重复写入 | 幂等：不新增行、不改 `started_at`，返回 `duplicate:true` |
| N4 | 同 gate 同 `(stream,name,head)` 重复记录 | 幂等：不产生双行 |
| N5 | gate 缺 `command` 或 `rc` | 抛 `GATE_INCOMPLETE`，拒绝记录 |
| N6 | `costCny` 缺失 | 指标输出 UNKNOWN，绝不出现 0 |
| N7 | 缓存 `contractHash` 变更 | 判 stale，且排除出 verified 集合 |
| N8 | 缓存 `modelSource==='mock'` | 判不可验证，不得进入端到端成功 |
| N9 | 超时（running 超 SLA） | 计 timeout 并标 `timed_out`，不算失败也不算成功 |
| N10 | 断线/不完整 span（有 startedAt 无终态） | 计 `incomplete`，UNKNOWN 传播到 bundle |
| N11 | 恢复重放（同一 run 重放 step） | `attempt` 递增，`calls` 不重复累计 |
| N12 | 跨 owner 读取 trace/metrics | `NOT_FOUND`（不泄露存在性） |
| N13 | 矩阵中某流只有单测 | 强制 `PROVISIONAL`，不得 `VERIFIED` |
| N14 | 矩阵中某流评审 `resolved_model=NULL` | 强制 `PROVISIONAL`/`UNKNOWN`（对齐 W8 处置，BRIEF §1） |
| N15 | 试图改 W0 schema / `contracts.mjs` / `db/index.mjs` | 只读守卫测试：`FROZEN` 与 schema 快照 hash 未变 |

## 4. 模块 DAG

`→` 为依赖；同 group 并行（独立文件域），跨 group 串行（共享 schema/公共入口串行，CTO-DECISIONS §5）。

```
G1  obs-vocabulary ──┬─→ G2 obs-store(obs-001/002.sql) ─┬─→ G3 obs-spans
    obs-schema-map ──┘   obs-provenance ─────────────────┼─→ G3 obs-gates
                                                         └─→ G3 obs-cache
G3 ─→ G4 obs-metrics
G3 ─→ G4 obs-bundle（依赖 5,6,7,8）
G4 ─→ G5 obs-matrix
G4 ─→ G5 obs-routes（依赖 5,6,7,10）
G5 ─→ G6 obs-report
```

| # | group | 模块 | 路径 | 职责 | 依赖 |
|---|---:|---|---|---|---|
| 1 | 1 | `obs-vocabulary` | `scripts/agentic/observability/vocabulary.mjs` | attribute 键常量、actor roles、UNKNOWN 哨兵、模型来源枚举、错误码、`normalizeActor` | — |
| 2 | 1 | `obs-schema-map` | `scripts/agentic/observability/schema-map.mjs` | §2.1 映射编码为数据 + 只读守卫（校验 `FROZEN` 与 schema hash 快照 `contract-snapshot.json`） | — |
| 3 | 2 | `obs-store` | `scripts/agentic/observability/store.mjs` + `db/migrations/obs-001-spans.sql`、`obs-002-metrics.sql` | `obs_*` 表 + 幂等 upsert + owner 过滤查询；复用 `openAgenticDb`（db/index.mjs:44）/`migrate`（:67），不改它 | 1,2 |
| 4 | 2 | `obs-provenance` | `scripts/agentic/observability/provenance.mjs` | actor/model 解析与 UNKNOWN 标注、`assertActorResolved`、`markRunComplete` 闸门 | 1 |
| 5 | 3 | `obs-spans` | `scripts/agentic/observability/spans.mjs` | 写入前用 `contracts.mjs` 校验 W0 span schema；attributes→列投影；span 树装配（PRD §10.5） | 3,4 |
| 6 | 3 | `obs-gates` | `scripts/agentic/observability/gates.mjs` | 门禁记录（command/rc/pass/fail/skip/coverage/head/contractCommit/evidence），幂等键 `(stream,name,head)` | 3 |
| 7 | 3 | `obs-cache` | `scripts/agentic/observability/cache.mjs` | §2.3 cacheKey、stale / expired-but-matching 判定、stale 排除集 | 3 |
| 8 | 4 | `obs-metrics` | `scripts/agentic/observability/metrics.mjs` | 延迟 p50/p90（PRD §12）、失败/超时/不完整率、重试、成本（calls/tokens/costCny/localShare），UNKNOWN 不落 0 | 5,6 |
| 9 | 4 | `obs-bundle` | `scripts/agentic/observability/bundle.mjs` | run 证据包：actors/models、gates、metrics、stale、unknowns、evidence 引用；§2.4 四态裁决 | 5,6,7,8 |
| 10 | 5 | `obs-matrix` | `scripts/agentic/observability/matrix.mjs` | 批次验收矩阵（纯数据）：HEAD/冻结契约/test rc/web 证据/push/评审模型/残余风险/状态；只按 §2.4 推导（BRIEF §2.4） | 9 |
| 11 | 5 | `obs-routes` | `scripts/agentic/observability/routes.mjs` | `createObservabilityRoutes({db,auth})` → `(req,res,pathname)=>handled`：`GET /api/runs/:id/trace`、`/activity`、`/api/cache/stale`（PRD §10.4）；owner 过滤，非本 owner 一律 `NOT_FOUND`；不挂 serve-tango（BUILD-PLAN §2.1，W13 统一挂载） | 5,6,7,10 |
| 12 | 6 | `obs-report` | `scripts/agentic/observability/report.mjs` | 矩阵 → Markdown 渲染（含 UNKNOWN 段与冲突记录），落调用方指定路径（BRIEF §4 七项回报） | 10 |

## 5. 每模块 TDD 与门禁

1. 每模块先落 `tests/unit/agentic/observability/<module>.test.mjs`（RED）再实现到 GREEN；共享 harness 放 `_harness.mjs`。
2. 覆盖率：`node --test --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`，本流每个 `.mjs` line ≥80%（同时报 branch；BUILD-PLAN §2.3）。
3. 全量：`npm run test:unit` 失败集合 = §0.1 的 7 条（不多不少）。
4. `npm run verify:web` 全过（本流不改 `web/**`）。
5. 只读守卫：`git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` 输出为空。
6. Playwright：仅 obs-routes e2e 时启用，`flock -w 900 /tmp/donego-s2d-pw.lock`，≤2 spec，端口 17691–17699。

## 6. 交付物

- 证据：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w10-<节点>.md`（plan/tests/impl/review 各一）
- 终报：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/s2d-w10-report.md`，必含 BRIEF §4 七项：worktree/分支/HEAD 与 b9d9 关系、文件边界、契约映射+拒绝路径 demo、精确命令+rc+通过/失败/跳过数、四路评审与修复 actor 真实模型（含 NULL 与否）、运行库/报告/代码差异、UNKNOWN 清单与 push 结果。

## 7. 待 CTO 裁决（不阻塞开工）

1. `GET /api/runs/:id/trace|activity` 最终挂载归 W10 工厂还是 W13（BUILD-PLAN §2.1 已定 W13 统一挂载；本流只交 `createObservabilityRoutes` 工厂）。
2. 矩阵数据源：只读解析各流 `s2d-*-report.md` vs 调用方传结构化 JSON——两路都支持；解析失败即 UNKNOWN，不做启发式猜测。
3. 覆盖率口径：BUILD-PLAN 要 ≥80%，W8 实际 branch 78.27%（BRIEF §2）；本流按 line 判定、报告同时给 branch。
