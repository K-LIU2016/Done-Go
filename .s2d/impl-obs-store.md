# impl · obs-store（G2 模块 3）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）

## 模块文件（plan §4 #3）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/store.mjs` | scripts/agentic/observability/** | 本次审查+修补 |
| `scripts/agentic/db/migrations/obs-001-spans.sql` | obs-*.sql | 已有（61c78e4），本次未改 |
| `scripts/agentic/db/migrations/obs-002-metrics.sql` | obs-*.sql | 已有（61c78e4），本次未改 |
| `tests/unit/agentic/observability/store.test.mjs` | tests/unit/agentic/observability/** | 本次 +7 测试 |

实现主体已在 `61c78e4` 落地（前一轮中断遗留）；本 ask 以 TDD 视角重验：发现
`recordNeed`/`recordGrant` 的 `ON CONFLICT DO UPDATE` 只回写 `status`，重放会丢
`answered_at`/`expires_at`/`updated_at`（观测投影丢数据，违反幂等重放语义），已修；
并补齐 0 覆盖的公共方法测试。

## 设计要点

- **表结构**（obs-001/002，纯增量 obs_ 前缀）：`obs_runs/obs_spans/obs_steps/obs_gates/
  obs_cache_entries/obs_spend/obs_acceptances/obs_needs/obs_grants`；每表 `owner_id
  NOT NULL` 且无默认值（测试断言 `PRAGMA table_info` notnull=1、dflt=null）。
- **迁移复用不改**：`applyObservabilityMigrations(db) = migrate(db, OBS_MIGRATIONS_DIR)`
  只跑本流 `obs-*.sql`，词法序、`_migrations` 台账幂等（二次调用返回 `[]`）。
- **幂等键**：span 按 `id`（重复返回 `{duplicate:true}` 且原行不动，N3）；跨 owner
  同 id 抛 `SPAN_OWNER_MISMATCH`（拒绝静默合并）；gate 按 `(owner,stream,name,head)`
  原地更新不双行（N4）；cache 按 `(owner,key)`；run 按 `(owner,id)` upsert。
- **owner 过滤（N12）**：所有读（`getSpan/listSpans/listRunSpans/getRun/listRuns/
  listGates/listCacheEntries/listStaleCacheEntries/listSpend`）先 `requireOwner`
  再带 `owner_id=?`；跨 owner 读一律 `null`/`[]`，不泄露存在性。
- **N5/N6**：gate 缺 `stream/name/head/command` 或 rc 非整数 → `GATE_INCOMPLETE`
  （vocabulary.validateGate）；spend 缺 `costCny` 落 `NULL`，显式 0 落 0，测试断言
  `notEqual`（可区分）。
- **W0 契约只读消费**：`upsertRun` 经 `contracts.mjs` 校验 `run.schema.json`（非法
  state 抛 `CONTRACT_INVALID`）；`recordSpend` 同样校验 `spend.schema.json`。

## 本次修复（缺陷）

`store.mjs` recordNeed/recordGrant upsert 补齐回写列（重放保留最新观测值）：

```sql
-- recordNeed:  status = excluded.status, due_at = excluded.due_at, answered_at = excluded.answered_at
-- recordGrant: status = excluded.status, expires_at = excluded.expires_at, updated_at = excluded.updated_at
```

由新增测试 `recordNeed upserts status and recordGrant upserts status` 先暴露
（RED：answered_at 断言得 null），再改实现转 GREEN。

## 新增测试（+7，21→28）

1. `listSpend` 无 runId 全量且仅本 owner
2. `countRuns` owner 隔离（N12）
3. `listRuns` owner 隔离 + 按 started_at 排序
4. `listGates` head / stream+head 过滤（N12）
5. `recordAcceptance` 同 id 幂等（decision 更新）+ owner 隔离 + OWNER_REQUIRED
6. `recordNeed`/`recordGrant` 幂等回写 status/answered_at/expires_at + OWNER_REQUIRED
7. `parseJsonOr` 空/非法 JSON 回退

## 覆盖的负面路径（plan §3）

N3（span 重复幂等）、N4（gate 幂等）、N5（GATE_INCOMPLETE：缺 command/rc/head、
rc 非整数）、N6（costCny NULL≠0）、N7（listStaleCacheEntries 仅 stale 行）、
N12（全部读路径跨 owner null/[]；SPAN_OWNER_MISMATCH）。N11 恢复重放语义由
need/grant/acceptance 幂等回写覆盖（attempt 级在 spend.recordSpend attempt 列）。

## 验证（本 ask 实测命令与结果）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/store.test.mjs` | 0 | 28 tests / 28 pass / 0 fail / 0 skipped；`store.mjs` line **100.00%**、branch **89.09%**、funcs 100.00%（≥80% line 门禁通过，branch 同步报告） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | 218 tests / 218 pass / 0 fail / 0 skipped（不破坏兄弟模块） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过；`openAgenticDb`/`migrate` 未改动） |

未运行：`npm run test:unit` 全量与 `npm run verify:web`（属流级门禁 G6/终报节点，
非本模块 ask 范围；obs-store 变更仅限 observability 子树，全套 observability 已绿）。

## 边界自查

- 新增/修改文件全部落在 §2.1 白名单（observability/**、obs-*.sql、tests 子树、.s2d 记录）。
- 未触碰 contracts/agentic/**、contracts.mjs、db/index.mjs、他流模块、web/**、生产。
- 无新增依赖（仅 node:* 与仓库内 ESM；node v22.22.2 内置 node:sqlite）。
