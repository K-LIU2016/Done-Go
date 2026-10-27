# impl · obs-gates（G3 模块 6）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`，本 ask 内 cat 复核）

## 模块文件（plan §4 #6）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/gates.mjs` | scripts/agentic/observability/** | 已有（61c78e4）；本 ask 修正一处注释引用（BUILD-PLAN §5→§2.3/§2.4，见「文档-代码差异」），行为无变化 |
| `scripts/agentic/db/migrations/obs-002-metrics.sql`（obs_gates 表） | obs-*.sql | 已有（61c78e4），本 ask 未改 |
| `tests/unit/agentic/observability/gates.test.mjs` | tests/unit/agentic/observability/** | 已有（20322f5 补至 24 测试），本 ask 未改（复跑全绿） |

实现主体已在 `61c78e4` 落地（前一轮中断遗留）；20322f5 ask 以 TDD 视角重验全部
plan 要求（§2.1 evidence 行、§2.4 四终态、§3 N4/N5/N12、§4 行 6 幂等键）并补齐
最后 2 个未覆盖分支。本 ask（provenance 补齐重跑）对照重派生的 plan 逐条复核
行为一致、全部门禁复跑 GREEN，仅修正注释中的 BUILD-PLAN 章节引用。

## 设计要点（对照 plan）

- **记录字段**（plan §4 行 6）：`command/rc/passed/failed/skipped/coverage/head/
  contractCommit/evidence` 全部落 `obs_gates`（obs-002-metrics.sql:4-22，另有
  `kind/durationMs/recordedAt` 附加列）；`coverage_json`/`evidence_json` 按原样
  JSON 存储。
- **幂等键 `(stream,name,head)`**（N4）：实现为 `(owner_id,stream,name,head)`
  主键 upsert（store.mjs:233-293）——重复记录原地更新并返回 `duplicate:true`，
  不产生双行、不改首记 `recorded_at`；同 gate 名不同 head 是不同 gate。
- **拒绝路径**（N5，vocabulary.validateGate vocabulary.mjs:135-165）：缺
  `stream/name/head/command`（含空白串）或 `rc` 非整数 → `GATE_INCOMPLETE`，
  拒绝记录；`passed/failed/skipped` 给了但非整数同样拒绝。
- **evidence 规则**（§2.1 + §2.4，gates.mjs:43-66，裁决从强拒到弱声明有序）：
  - rc≠0 或 failed>0 → `passed:false` + `BLOCKED`，永不因 evidence 翻盘；
  - 无 evidence → `UNKNOWN`（§2.4「缺证据→UNKNOWN」，不拒收、不落 VERIFIED；
    §2.1「gate 必挂 evidence」在裁决层执行：无 evidence 的 gate 永不计通过证据）；
  - `verified!==true` 的 evidence 不计入通过证据 → `PROVISIONAL`；
  - `source∈{mock,fixture,synthetic}` 的 verified evidence 封顶 `PROVISIONAL`
    （BRIEF §3 末条：mock 不计端到端成功，N8 同源规则）；
  - coverage 提供且 `line<80`（COVERAGE_LINE_FLOOR）或 line 缺失/NaN → 封顶
    `PROVISIONAL`；coverage 未提供不参与裁决（null 三态）；
  - 仅 rc=0 + 非 mock verified evidence + coverage 达标 → `VERIFIED`/`verifiable:true`。
- **head 聚合 `summarize(ownerId,head)`**：任一失败 → `BLOCKED`；全 VERIFIED →
  `VERIFIED`；否则 `PROVISIONAL`；零记录 → `UNKNOWN`（空集不可冒充通过）。
- **owner 隔离**（N12）：经 store 的 `owner_id` 前缀查询，跨 owner 读为空集。
- **`evidence.source` 字段说明**：W0 `evidence.schema.json` 冻结无 `source`，
  该字段是 W10 在自有表 `evidence_json` 内的投影注记（§2.2-4 模型来源单独记），
  不改写 W0 schema、不参与 W0 校验边界。

## 覆盖的负面路径（plan §3）

N4（重复幂等原地更新）、N5（GATE_INCOMPLETE：缺 command/rc/head/stream/name、
rc 非整数）、N8 同源（mock evidence 封顶 PROVISIONAL）、N12（owner 隔离）、
§2.4（失败→BLOCKED、缺证据→UNKNOWN、mixed→PROVISIONAL、空集→UNKNOWN）。
超时/断线（N9/N10）属 obs-spans/metrics 职责；恢复重放（N11）的 gate 侧语义
即 N4 幂等更新。

## 验证

### 复跑门禁（本 ask 实测，2026-10-27 provenance 补齐重跑，全部 GREEN）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/gates.test.mjs` | 0 | **24 tests / 24 pass / 0 fail / 0 skipped**；`gates.mjs` line **100.00%** / branch **100.00%** / funcs 100.00%（§5.2 line≥80% 达标；注释修正后复跑同结果） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | **235 tests / 235 pass / 0 fail / 0 skipped**（兄弟模块不破坏） |
| `npm run test:unit` | 1 | **1205 tests / 1196 pass / 7 fail / 2 skip**；失败集合与 plan §0.1 七条逐一相符：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`streamChat accepts typed content deltas…`、`independent authenticated accounts…`、`AI uses selected shared fields…`、`replays a multi-clause recording…`、`tests/unit/voice-pipeline-gateway.test.mjs`——不多不少，无新增失败（rc=1 即该预存集合所致） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过） |
| `cat contracts/agentic/FROZEN` | 0 | `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`（与 plan 头部一致，N15 精神复核） |

未运行：`npm run verify:web`（本模块不改 `web/**`；流级门禁在 G6/终报节点统一
执行，与 obs-store 复跑口径一致——其记录同样未跑该项）。Playwright 不适用
（obs-gates 无 e2e；e2e 属 obs-routes）。

### 历史验证（20322f5 ask；数字被本轮复跑覆盖，仅存档）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/gates.test.mjs` | 0 | 24/24；gates.mjs line/branch/funcs 100%（+3 测试后，branch 95%→100%） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | 225/225（当时全树规模） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 空 |

## 文档-代码差异（AGENTS.md 要求逐条列出）

- `gates.mjs:21` 注释原写「BUILD-PLAN §5: line coverage floor」，但 BUILD-PLAN
  §5（CTO 把关节奏）不含 80% 口径；该口径在 §2.3（「每个模块单测覆盖率 ≥80%」）
  与 §2.4.1（「覆盖率 ≥80%」）。数值 80 正确、仅章节引用错误。处置：按现有
  代码行为（floor=80 不变），修正注释引用为 §2.3/§2.4——行为零变化，复跑同绿。
- plan §4 行 6 幂等键写 `(stream,name,head)`，实现为 `(owner_id,stream,name,head)`
  （N12 owner 隔离所需的多列主键）；与 §3 N12 及 obs-store 模块设计一致，非缺陷，
  按现有代码登记。

## 边界自查

- 本 ask 新增/修改仅 `scripts/agentic/observability/gates.mjs`（1 行注释）与
  `.s2d/impl-obs-gates.md`，全部落在 §2.1 白名单。
- 未触碰 contracts/agentic/**、contracts.mjs、db/index.mjs、他流模块、web/**、
  生产；密钥未涉及（obs-gates 无外部调用）。
- 无新增依赖（仅 node:* 与仓库内 ESM）。
- TDD 说明：本 ask 为复跑核验 + 注释修正，无行为变更，故无新 RED 测试；
  既有 24 测试对全部 plan 要求（N4/N5/N8/N12、四态裁决、幂等键）保持覆盖。
