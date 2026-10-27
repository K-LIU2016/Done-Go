# impl · obs-gates（G3 模块 6）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）

## 模块文件（plan §4 #6）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/gates.mjs` | scripts/agentic/observability/** | 已有（61c78e4），本 ask 审查确认无需改码 |
| `scripts/agentic/db/migrations/obs-002-metrics.sql`（obs_gates 表） | obs-*.sql | 已有（61c78e4），本 ask 未改 |
| `tests/unit/agentic/observability/gates.test.mjs` | tests/unit/agentic/observability/** | 本 ask +3 测试（21→24） |

实现主体已在 `61c78e4` 落地（前一轮中断遗留）；本 ask 以 TDD 视角重验全部
plan 要求（§2.1 evidence 行、§2.4 四终态、§3 N4/N5/N12、§4 行 6 幂等键），
行为与计划一致，未发现缺陷；补齐最后 2 个未覆盖分支的测试，branch 95%→100%。

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
  - 无 evidence → `UNKNOWN`（§2.4「缺证据→UNKNOWN」，不拒收、不落 VERIFIED）；
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

## 本 ask 新增测试（+3，21→24）

1. `createGateRecorder` 无 store → `INVALID_ARGUMENT`（配置错误而非静默 no-op）
2. coverage 缺 `line` / `line=NaN` → `coverageOk:false`、封顶 `PROVISIONAL`
3. 同 head 混合 verified+provisional（无失败）→ 聚合 `PROVISIONAL` 且计数正确

均先跑 RED（改动前 branch 95.00%，两分支未覆盖）再确认 GREEN。

## 覆盖的负面路径（plan §3）

N4（重复幂等原地更新）、N5（GATE_INCOMPLETE：缺 command/rc/head/stream/name、
rc 非整数）、N8 同源（mock evidence 封顶 PROVISIONAL）、N12（owner 隔离）、
§2.4（失败→BLOCKED、缺证据→UNKNOWN、mixed→PROVISIONAL、空集→UNKNOWN）。
超时/断线（N9/N10）属 obs-spans/metrics 职责；恢复重放（N11）的 gate 侧语义
即 N4 幂等更新。

## 验证（本 ask 实测命令与结果）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/gates.test.mjs` | 0 | 24 tests / 24 pass / 0 fail / 0 skipped；`gates.mjs` line **100.00%** / branch **100.00%** / funcs 100.00%（≥80% line 门禁通过） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | 225 tests / 225 pass / 0 fail / 0 skipped（不破坏兄弟模块） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过） |

未运行：`npm run test:unit` 全量与 `npm run verify:web`（属流级门禁 G6/终报
节点，非本模块 ask 范围；本 ask 变更仅 gates.test.mjs 一个文件，全套
observability 已绿）。

## 边界自查

- 新增/修改仅 `tests/unit/agentic/observability/gates.test.mjs` 与本记录文件，
  全部落在 §2.1 白名单。
- 未触碰 contracts/agentic/**、contracts.mjs、db/index.mjs、他流模块（并行 ask
  的 spans.test.mjs 在工作区由其自行提交，本 ask 未 stage）、web/**、生产。
- 无新增依赖（仅 node:* 与仓库内 ESM）。
