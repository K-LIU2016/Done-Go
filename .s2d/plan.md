# S2D · W10 可观测性与运行证据 · 计划 DAG

> 状态：规划（未编码）。worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability`
> 分支 `feat/s2d-w10-observability` @ `60fdc73`（含冻结 `b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> 上游：`PRD.md` §4/§5.4/§5.6/§6.3/§8.2/§8.4/§10.5/§10.6/§12、`BUILD-PLAN.md` §2.1–§2.5、§3、`CTO-DECISIONS-2026-10-27.md` §2.1–§2.6/§3/§4、`CTO-BATCH2-BRIEF-2026-10-27.md` §3/§4/§5。

## 0. 基线实测（本 ask 内执行）

| 命令 | rc | 结果 |
|---|---:|---|
| `npm ci` | **1** | `EUSAGE`：`Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`。与批次一矩阵「W0 npm ci rc=1（基线 lock 缺 `sherpa-onnx-win-arm64`）」一致，非本流引入。`node_modules` 因此不存在；本流测试只用 `node:*` 与仓库内 ESM，不依赖安装即可运行。 |
| `npm run test:unit` | 1 | 970 tests / 961 pass / 7 fail / 2 skip |
| `npm run verify:web` | 0 | 227/227 pass |
| `node --experimental-strip-types --test tests/unit/agentic/contracts/contracts.test.mjs` | 0 | 12/12 pass（W0 契约套件可用） |

### 0.1 基线失败清单（本流门禁只允许这 7 条）

已知基线 3 条（BUILD-PLAN §2.4.2）：
- `streamChat accepts typed content deltas and a clean close without an explicit done marker`
- `independent authenticated accounts, read-only permissions, conflicts and idempotent personal links`
- `AI uses selected shared fields, forbids permission actions, binds versions and rechecks revocation`

预存 4 条（批次一矩阵已登记为基线外预存）：
- `src/screens/s04-plan/metric-layout.test.ts`
- `src/styles/design-system.test.ts`
- `replays a multi-clause recording: live partials, VAD segments and both finals arrive`
- `tests/unit/voice-pipeline-gateway.test.mjs`

本流门禁：`npm run test:unit` 失败数 ≤7 且集合与上表完全一致；新增 1 条即门禁不通过。

## 1. 本流边界（BUILD-PLAN §2.1 + 本 ask 红线 3）

只可新增/修改：

```
scripts/agentic/observability/**            # 全部实现
scripts/agentic/db/migrations/obs-*.sql     # 只加 obs_ 前缀表
tests/unit/agentic/observability/**         # 单测
.s2d/plan.md                                # 本文件
```

禁止：`contracts/agentic/**`（W0 冻结）、`scripts/agentic/contracts.mjs`、`scripts/agentic/db/index.mjs`、`scripts/agentic/{engine,block-store,perception,media,...}/**`（他流）、`scripts/serve-tango.mjs`、`scripts/build-web.mjs`、`web/**`、发布清单、Done-Go 主仓 / Done-Go-classic / thinkpad / 生产 / LiteLLM / .env。

端口：如需本地 HTTP harness 用 17691–17699；Playwright（若最后加 trace 投影 e2e）须 `flock -w 900 /tmp/donego-s2d-pw.lock`，全局 ≤2 spec 进程。

## 2. 契约映射（先写映射，再编码）

W0 冻结 schema **不改写**。W10 只读消费 + 投影到 observability 自有表与 attribute 命名空间。

### 2.1 逐字段映射

| W0 契约（`contracts/agentic/*.schema.json`） | W10 投影 | 说明 |
|---|---|---|
| `span`（`span.schema.json`，`required=[id,name,kind,startedAt,status]`） | `obs_spans`（`id,parent_id,name,kind,started_at,ended_at,status,owner_id,run_id,input_ref,output_ref,error,attributes_json`） | 顶层 `additionalProperties:false`，新信息只能进 `attributes` |
| `span.attributes`（自由 `object`） | 抽取列 `request_model` / `actor_role` / `actor_model` / `resolved_model` / `model_source` / `model_local` | 键名常量集中 `vocabulary.mjs`，禁散落字面量 |
| `run`（`run.schema.json` 的 8 态） | `obs_run_metrics`（每 run 一行 + 状态直方图） | 只读；状态以 run 表为权威，观测层不做状态机 |
| `step`（`step.schema.json`：`attempt`、`kind`∈plan/schedule/execute/verify/merge） | `obs_step_metrics` | 重试 = 同一 `inputHash` 的 `attempt>0` |
| `spend`（`spend.schema.json`：`calls`/`tokens` 必填，`costCny?`、`localShare?`） | `obs_cost` 聚合 | `costCny` 缺失 → `UNKNOWN`（PRD §10.6「未知显示未知」），**不得写 0**；显式免费 0 与缺失必须可区分 |
| `evidence`（`evidence.schema.json`：`type`、`verified?`） | `obs_gates.evidence_json` | gate 必须挂 evidence；`verified!==true` 不计入通过 |
| `acceptance`（`decision`） | 验收率派生 | 仅 `accepted` 计入收益 |
| `need`（`defaulted`/`expired`） | 打扰/超时指标 | 超时按默认值处理必须可统计 |
| `grant`（`invalidated`/`expired`） | 越权拦截/失效计数 | 与 policy 事件对齐，只读 |

### 2.2 actor/model provenance 规则（红线 7 + BRIEF §3）

1. 每个 actor（L0 Conductor / L1 Block Agent / L2 Worker / verifier / reviewer / fixer）必须有 `actor.role` + `actor.model`。
2. `actor.model` 未解析 → 写 `resolved_model = NULL` 且 provenance = `UNKNOWN`；**禁止**回填、猜测或从相邻 actor 继承。
3. `assertActorResolved(actor)` 对 `UNKNOWN` 抛 `PROVENANCE_UNRESOLVED`；`markRunComplete()` 遇任一 UNKNOWN actor 抛 `RUN_NOT_VERIFIABLE`，run 只能落 `partial`/`unknown`。
4. 模型来源（`gateway`/`mock`/`fixture`）单独记 `model_source`；`mock`/`fixture` 永不计入「真实调用成功」（BRIEF §3 末条）。

### 2.3 stale cache 识别

以内容身份而非时间戳判定新鲜度：

```
cacheKey = sha256(canonicalJson({ kind, contractHash, blockRevision, model, effort, inputsHash }))
stale    = entry.key !== recomputeKey
        || entry.inputsHash !== currentInputsHash
        || entry.contractHash !== currentContractHash
        || entry.modelSource === 'unknown'
```

`stale` 条目不得进入「已验证」证据；仅时间过期但内容身份一致的标 `expired-but-matching`，不计 stale 但必须记录（防止把缓存摘要当成功）。

### 2.4 UNKNOWN 传播（BRIEF §3 末条 + CTO-DECISIONS §3.4）

`bundle.mjs` 逐项裁决，只认四种终态：`VERIFIED` / `PROVISIONAL` / `UNKNOWN` / `BLOCKED`。升级规则（禁止越级）：
- 只有真实端到端命令 rc=0 + 非 mock evidence 才能 `VERIFIED`；
- mock、单测、schema 通过、进程启动成功 → 最高 `PROVISIONAL`；
- 缺 test 命令/rc、缺模型 provenance、缺 web 证据 → `UNKNOWN`；
- 门禁失败或高风险未修 → `BLOCKED`。

## 3. 负面路径清单（先写测试，TDD）

| # | 场景 | 期望 |
|---|---|---|
| N1 | 缺失/空 `actor.model` 写 span | 接受写入但标 `UNKNOWN`；`assertActorResolved` 抛 `PROVENANCE_UNRESOLVED` |
| N2 | 对 UNKNOWN actor 调 `markRunComplete` | 抛 `RUN_NOT_VERIFIABLE`，run 落 `partial`/`unknown`，不写 succeeded |
| N3 | 同一 span id 重复写入 | 幂等：不新增行、不改 `started_at`，返回 `duplicate:true` |
| N4 | 同 gate 同 `(stream,name,head)` 重复记录 | 幂等：覆盖或返回既有记录，不产生双行 |
| N5 | gate 缺 `command` 或 `rc` | 抛 `GATE_INCOMPLETE`，拒绝记录 |
| N6 | `costCny` 缺失 | 指标输出 `UNKNOWN`，绝不出现 `0` |
| N7 | 缓存 `contractHash` 变更 | 判 stale，且 stale 条目被排除出 verified 集合 |
| N8 | 缓存 `modelSource==='mock'` | 判不可验证，不得进入端到端成功 |
| N9 | 超时（span `status='running'` 超 SLA） | 计入 timeout 并标 `timed_out`，不算失败也不算成功 |
| N10 | 断线/不完整 span（有 `startedAt` 无终态） | 计入 `incomplete`，UNKNOWN 传播到 bundle |
| N11 | 恢复重放（同一 run 重放 step） | `attempt` 递增，`calls` 不重复累计 |
| N12 | 跨 owner 读取 trace/metrics | `NOT_FOUND`（不泄露存在性） |
| N13 | 矩阵中某流只有单测 | 强制 `PROVISIONAL`，不得 `VERIFIED` |
| N14 | 矩阵中某流评审 `resolved_model=NULL` | 强制 `PROVISIONAL`/`UNKNOWN`（对齐 W8 处置） |
| N15 | 试图改 W0 schema / `contracts.mjs` | 只读守卫测试：`FROZEN` 与 schema 快照 hash 未变 |

## 4. 模块 DAG

依赖用 `→`。同 group 内可并行，跨 group 串行（共享 schema/公共入口串行）。

```
G1  obs-vocabulary ──┬─→ G2 obs-store(obs-001/002.sql) ─┬─→ G3 obs-spans
    obs-schema-map ──┘   obs-provenance ─────────────────┼─→ G3 obs-gates
                                                         └─→ G3 obs-cache
G3 ─→ G4 obs-metrics
G3 ─→ G4 obs-bundle
G4 ─→ G5 obs-matrix
G4 ─→ G5 obs-routes
G5 ─→ G6 obs-report
```

| # | group | 模块 | 路径 | 职责 | 依赖 |
|---|---:|---|---|---|---|
| 1 | 1 | `obs-vocabulary` | `scripts/agentic/observability/vocabulary.mjs` | attribute 键常量、actor roles、UNKNOWN 哨兵、模型来源枚举、错误码、`normalizeActor` | — |
| 2 | 1 | `obs-schema-map` | `scripts/agentic/observability/schema-map.mjs` | §2.1 映射编码为数据 + 只读守卫（校验 `FROZEN` 与 schema hash 快照） | — |
| 3 | 2 | `obs-store` | `scripts/agentic/observability/store.mjs`、`db/migrations/obs-001-spans.sql`、`obs-002-metrics.sql` | 表结构 + 幂等 upsert + owner 过滤查询；复用 `openAgenticDb`/`migrate`，不改它 | 1,2 |
| 4 | 2 | `obs-provenance` | `scripts/agentic/observability/provenance.mjs` | actor/model 解析与 UNKNOWN 标注、`assertActorResolved`、`markRunComplete` 闸门 | 1 |
| 5 | 3 | `obs-spans` | `scripts/agentic/observability/spans.mjs` | 写入前用 `contracts.mjs` 校验 W0 `span.schema.json`；attributes→列投影；span 树装配 | 3,4 |
| 6 | 3 | `obs-gates` | `scripts/agentic/observability/gates.mjs` | 门禁记录（command/rc/pass/fail/skip/coverage/head/contractCommit/evidence），幂等键 `(stream,name,head)` | 3 |
| 7 | 3 | `obs-cache` | `scripts/agentic/observability/cache.mjs` | §2.3 cacheKey、stale / `expired-but-matching` 判定、stale 排除集 | 3 |
| 8 | 4 | `obs-metrics` | `scripts/agentic/observability/metrics.mjs` | 延迟 p50/p90（PRD §12）、失败/超时/不完整率、重试、成本（calls/tokens/costCny/localShare），UNKNOWN 不落 0 | 5,6 |
| 9 | 4 | `obs-bundle` | `scripts/agentic/observability/bundle.mjs` | run 证据包：actors/models、gates、metrics、stale、unknowns、evidence 引用；§2.4 状态裁决 | 5,6,7,8 |
| 10 | 5 | `obs-matrix` | `scripts/agentic/observability/matrix.mjs` | 批次验收矩阵（纯数据）：HEAD/冻结契约/test rc/web 证据/push/评审模型/残余风险/状态；只按 §2.4 推导 | 9 |
| 11 | 5 | `obs-routes` | `scripts/agentic/observability/routes.mjs` | `createObservabilityRoutes({db,auth})` → `(req,res,pathname)=>handled`：`GET /api/runs/:id/trace`、`/activity`、`/api/cache/stale`；owner 过滤，非本 owner 一律 `NOT_FOUND` | 5,6,7,10 |
| 12 | 6 | `obs-report` | `scripts/agentic/observability/report.mjs` | 矩阵 → Markdown 渲染（含 UNKNOWN 段与冲突记录），落调用方指定路径 | 10 |

## 5. 每模块 TDD 与门禁

1. 每个模块先落 `tests/unit/agentic/observability/<module>.test.mjs`（RED），再写实现到 GREEN。
2. 覆盖率：`node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`，本流每个 `.mjs` line ≥80%（同时报 branch）。
3. 全量：`npm run test:unit` 失败集合必须等于 §0.1 的 7 条（不多不少）。
4. `npm run verify:web` 必须 227/227（本流不改 `web/**`）。
5. 只读守卫：`git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` 输出必须为空。
6. Playwright：仅当 `obs-routes` 加 e2e 时启用，`flock -w 900 /tmp/donego-s2d-pw.lock`，≤2 spec，端口 17691–17699。

## 6. 交付物

- 证据：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w10-<节点>.md`（plan/impl/tests/review 各一）
- 终报：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/s2d-w10-report.md`
- 终报必须含：worktree/分支/HEAD、与 `b9d9` 关系、修改文件清单、未改跨流文件、契约映射、拒绝路径 demo、精确命令+rc+通过/失败/跳过数、四路评审与修复 actor 的真实模型（含 NULL 与否）、运行库/报告/代码差异、UNKNOWN 清单、push 结果。

## 7. 待 CTO 裁决（不阻塞开工）

1. `GET /api/runs/:id/trace|activity` 归 W10（PRD A12 trace）还是 W13 统一挂载——本流只交 `createXxxRoutes` 工厂、不挂 `serve-tango.mjs`，默认做。
2. 矩阵数据源：允许只读解析各流 `s2d-*-report.md`，还是必须由调用方传入结构化 JSON。默认两路都支持；解析失败即 `UNKNOWN`，不做启发式猜测。
3. 覆盖率口径：BUILD-PLAN 要 line ≥80%，W8 实际 branch 78%；本流按 line 判定并在报告同时给 branch。
