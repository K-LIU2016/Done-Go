# obs-spans（组3 · 模块5）实现记录

- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w10-observability`，分支 `feat/s2d-w10-observability`。
- 实现落点（前次会话整体提交 `61c78e4`）：本 ask 对该模块做规格核对 + 负面路径补测 + 门禁复跑 + 本记录补档。本 ask **未改动任何实现 `.mjs`**（`spans.mjs` 与 `61c78e4` 落盘版逐字节一致）；改动仅为 `spans.test.mjs` +65/-3（新增 4 个负面路径用例、强化 N3 断言）与本记录。

## 交付文件

| 文件 | 行数 | 说明 |
|---|---:|---|
| `scripts/agentic/observability/spans.mjs` | 164 | 实现（本 ask 未改） |
| `tests/unit/agentic/observability/spans.test.mjs` | 266 | 单测（21 用例；本 ask 17→21） |
| `.s2d/impl-obs-spans.md` | 本文件 | 模块明细 |

依赖（`spans.mjs:13-15`）：`node:url`、W0 `contracts.mjs` 的 `loadSchema/validate`（只读消费，不改写）、`vocabulary.mjs` 的 `ATTRIBUTE_KEYS/PROVENANCE/observabilityError/OBS_ERROR_CODES`；存储经构造注入的 `store`（obs-store 模块），与 plan 模块表「依赖 3,4」一致——对 4（obs-provenance）的依赖体现为共用 §2.2 规则的落点 `PROVENANCE.UNKNOWN` 与「禁回填」（见下），不直接 import。下游已核实消费者：`routes.mjs:17,118,151`（`createSpanRecorder` + `buildTree` 供 `GET /api/runs/:id/trace`）、`bundle.mjs:82-84`（span 行 UNKNOWN 传播）。

## 规格核对（`.s2d/plan.md:134` 模块表行5 + §2.1/§2.2）

职责三项逐一落位（cite 实现行号）：

1. **写入前用 `contracts.mjs` 校验 W0 `span.schema.json`**：`assertSpan`（`spans.mjs:20-31`）对入参跑冻结 schema 校验，失败抛 `CONTRACT_INVALID`（携带逐字段 errors）；`record()`（`spans.mjs:87-106`）第一行即 `assertSpan`，校验通过才触达 `store.insertSpan`——`additionalProperties:false` 因此挡在门外（用例 `spans.test.mjs:35-41`： smuggle 顶层 `model` 被拒）。
2. **attributes→列投影**：`projectAttributes`（`spans.mjs:51-65`）把 §2.1 抽取列 `request_model/actor_role/actor_model/resolved_model/model_source/model_local` 全部经 `ATTRIBUTE_KEYS` 常量取键（无散落字面量），并落 `provenance`；`resolved_model` 只取 `donego.model.resolved ?? donego.actor.model`（`spans.mjs:54`），**绝不**从 `gen_ai.request.model` 回填（`spans.mjs:57` 独立列；用例 `:80-90` 断言 request_model 有值时 resolved_model 仍 NULL）；键外 attributes 原样进 `attributes_json`（用例 `:92-102`）。§2.2 规则2 落地：model 缺失/空白 → `resolved_model=NULL` + `provenance=UNKNOWN`（用例 `:71-78`、`:104-114`）；规则4：`model_source` 单独成列不并入 model。
3. **span 树装配**：`buildTree`（`spans.mjs:115-134`）按 `parent_id` 嵌套，父缺失的 span 不消失——升为根并计入 `orphans`（`:128-131`），断链可见而非静默；不改存储行（用例 `:199-205`）；owner 作用域由 `store.listRunSpans` 承载（`store.mjs:157-161`，N12）。

附带 `classifyOutcome`（`spans.mjs:144-162`）：每 span 恰落一个桶 `succeeded/failed/timed_out/running` + `incomplete` 标志；`running` 超 SLA → `timed_out`（N9，既非失败也非成功，`:67-80`），有 `startedAt` 无终态 → `incomplete`（N10，UNKNOWN 传播的输入）。

## 覆盖的负面路径（`.s2d/plan.md` §3，本模块份内）

- **N1**（缺失/空 model 写 span → 接受但 UNKNOWN）：缺失 `:71-78`；**空白串** `:104-114`（本 ask 补，plan「缺失/空」的空态）；`assertActorResolved` 抛出侧属 obs-provenance 套件（其记录已核，绿）。
- **N3**（同 span id 重复写 → 幂等）：`:149-164`（本 ask 强化：第二次带不同 `startedAt`/`status`，断言 `duplicate:true`、`started_at` 不改、行数 1、状态保持首次的 `running`）。
- **N9**：`:207-224`（超 SLA → `timed_out`，failed/succeeded 均 0；SLA 内 → `running`）。
- **N10**：`:237-246`（无终态 → `incomplete:true`）。
- **N12**：`:192-197`（跨 owner buildTree 得空树，存在性不泄露；store 层 `getSpan` 亦 owner 键控）。
- 本 ask 补充的拒绝/幂等路径：跨 owner 复用 span id → `SPAN_OWNER_MISMATCH`（`:166-173`，recorder 级；store 级另有 `store.test.mjs:73-78`）；显式 `donego.model.resolved` 优先、空白回落 actor model（`:116-136`）；`model_local:true→1`、缺省→NULL（`:138-147`）；无 owner → `OWNER_REQUIRED`（`:175-178`）；`classifyOutcome` 参数非法 → `INVALID_ARGUMENT`（`:259-265`）。
- N11（重放 attempt/calls 不重复累计）在 obs-store/obs-metrics 侧，不在本模块。

## 检查（本 ask 内执行，均为实际命令，cwd=worktree）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-test-coverage --test tests/unit/agentic/observability/spans.test.mjs` | 0 | `# tests 21 / # pass 21 / # fail 0 / # skipped 0`；`spans.mjs` line **100.00%** / branch 96.55% / funcs 100% |
| `node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`（`plan.md:146` §5.2 门禁原样） | 0 | `# tests 225 / # pass 225 / # fail 0 / # skipped 0`；`spans.mjs` line **100.00%** / branch 96.61% / funcs 100%（all files line 97.44% / branch 84.94%） |
| `npm run test:unit`（`plan.md:147` §5.3 全量门禁） | 1 | `# tests 1205 / # pass 1196 / # fail 7 / # skipped 2`；失败集合与 §0.1 七条**逐一相符**（3 已知 + 4 预存：metric-layout、design-system、streamChat…done marker、independent authenticated accounts…、AI uses selected shared fields…、replays a multi-clause recording…、voice-pipeline-gateway），零新增失败。总数 970→1205 = 本流 obs 套件 225 + 基线；运行时工作树含并行 obs-gates 会话未提交的 `gates.test.mjs` 增补（+10 用例，全绿），如实声明 |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs`（`plan.md:149` §5.5 只读守卫） | 0 | 输出为空（冻结面零改动） |

覆盖率结论：line ≥80% 达标（模块 100%，模块套件与全套件两口径一致），branch 同时报告（96.55%/96.61%，`plan.md:162` 裁决3 口径）。

## TDD 说明（如实）

- RED 阶段非本 ask 执行：前次会话按先测后码落盘（提交 `61c78e4` 消息「TDD: 197-test RED suite written first, all modules implemented to 211/211 green」）。本 ask 未改实现，新增 4 用例 + 强化 N3 是对既有实现的规格补测，落盘即 GREEN，无法也无意重放 RED。

## 未运行（如实声明，不冒充模块检查）

- `npm run verify:web`（§5.4，227/227）：流级门禁，本模块未触 `web/**`，归 obs-report/汇总步。
- Playwright 未启用（本模块无路由 e2e，`plan.md:150` 条件不触发）。

## 红线核对

- 文件归属：本 ask 仅改 `tests/unit/agentic/observability/spans.test.mjs` 与 `.s2d/impl-obs-spans.md`；实现文件与冻结面零改动。提交只含上述两文件——工作树中并行会话的 `tests/unit/agentic/observability/gates.test.mjs` 未暂存、未提交（属 obs-gates 模块）。

## 重跑证据（本 ask，2026-10-27，worktree HEAD=`3a4da49` 起点）

本 ask（provenance 补齐重跑轮的 obs-spans 节点）对已交付模块做规格重核 + 门禁复跑；**未改任何实现或测试 `.mjs`**（`git diff --stat 61c78e4 HEAD -- scripts/agentic/observability/spans.mjs` 为空，spans.mjs 自 feat 提交逐字节未变；模块测试仍 21 用例/266 行）。改动仅本记录。

必读重核：BRIEF §3（W10 责任边界、mock 不升级为端到端）、BUILD-PLAN §2.1/§2.3/§2.4（归属/TDD≥80%/门禁失败集合）、CTO-DECISIONS §3.3（未解析模型不产生通过结论）与 §5（协议）、PRD §10.5（span 属性约定：gen_ai.*/donego.* 命名、chat span 记模型不记正文）——spans.mjs 的键全部经 `vocabulary.mjs` 的 `ATTRIBUTE_KEYS`（gen_ai.request.model / donego.actor.model / donego.model.resolved / donego.model.source / donego.model.local），无散落字面量，与 PRD §10.5 对齐；`prototype.html:212` 块抽屉「追踪」标签为 span 树的 routes 层下游消费面，与本模块职责边界一致。下游消费者行号复核：`routes.mjs:17`（import createSpanRecorder）、`:118`、`:150`（buildTree 供 trace 路由；原记录笔误 `:151`）；`bundle.mjs:82-84`（`spanUnknowns` 对断线 span 传播 UNKNOWN）——均实读确认。

| 命令（cwd=worktree） | rc | 结果 |
|---|---:|---|
| `node --experimental-test-coverage --test tests/unit/agentic/observability/spans.test.mjs` | 0 | `# tests 21 / # pass 21 / # fail 0 / # skipped 0`；`spans.mjs` line **100.00%** / branch 96.55% / funcs 100% |
| `node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs` | 0 | `# tests 235 / # pass 235 / # fail 0 / # skipped 0`（并行会话续增至 235，本模块 21 不变）；`spans.mjs` line **100.00%** / branch 96.61%；all files line 97.55% / branch 85.54% |
| `npm run test:unit` | 1 | `# tests 1205 / # pass 1196 / # fail 7 / # skipped 2`；7 条失败逐一=§0.1：metric-layout、design-system、streamChat…done marker、independent authenticated accounts…、AI uses selected shared fields…、replays a multi-clause recording…、voice-pipeline-gateway（`not ok` 名称实取自输出），零新增 |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空；`FROZEN` 在 HEAD 与 `60fdc73` 均为 `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`（N15 只读守卫） |
| `git diff --name-only 60fdc73 HEAD \| sed 's\|/[^/]*$\|\|' \| sort -u` | 0 | 仅 `.s2d`、`scripts/agentic/db/migrations`、`scripts/agentic/observability`、`tests/unit/agentic/observability`——全部 §2.1 归属内 |

覆盖率结论维持：line ≥80% 达标（模块 100%），branch 同时报告（96.55%/96.61%）。未运行项不变：`npm run verify:web`（流级，归汇总步）、Playwright（本模块无 e2e，条件不触发）。
