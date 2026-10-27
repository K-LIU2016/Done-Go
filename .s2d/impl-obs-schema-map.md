# impl · obs-schema-map（组1 · 模块2）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 60fdc73（含 FROZEN b9d9bdfa0511905a95b729753b82e5734adab6bb）。
> 实现文件随 61c78e4 入库；本 ask 逐项复跑门禁全部 GREEN，无源码改动。

## 文件（3）

| 文件 | 角色 |
|---|---|
| `scripts/agentic/observability/schema-map.mjs`（171 行） | §2.1 映射编码为数据（`SCHEMA_MAP` 8 契约→obs_* 投影、`modifiesContract:false`、唯一扩展点 `span.attributes`）+ 只读守卫（`parseFrozenContract`/`readFrozenContract` 校 FROZEN 版本与 40-hex commit；`schemaSnapshots` 对 29 个 `*.schema.json` 逐文件 SHA-256；`verifyFrozenContracts` 报 mismatches/missing/unexpected 三类漂移） |
| `scripts/agentic/db/../observability/contract-snapshot.json` | 冻结 hash 快照（29 条），随源码入库 |
| `tests/unit/agentic/observability/schema-map.test.mjs`（13 tests） | N15 守卫：FROZEN pin、畸形 FROZEN 拒绝（CONTRACT_INVALID）、映射完整性、schema 文件存在且可解析、非 span 契约零扩展点、hash 漂移/增/删检测、快照与盘上一致 |

依赖：仅 `vocabulary.mjs`（observabilityError/OBS_ERROR_CODES），组1 内合法（plan §4 模块2 依赖—）。

## 门禁复跑（本 ask 实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 模块单测 | `node --test tests/unit/agentic/observability/schema-map.test.mjs` | 13/13 pass, 0 fail |
| 全 observability 套件 | `node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs` | 211/211 pass；schema-map.mjs line **100.00%** / branch 90.91%（§5.2 line≥80% 达标） |
| 只读守卫 N15 | `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 空输出（未改 W0 冻结面） |
| 全量回归 | `npm run test:unit`（跑两遍：计数+失败名） | 1181 tests / 1172 pass / **7 fail / 2 skip**；失败集合与 plan §0.1 七条逐一相符（metric-layout、design-system、streamChat、accounts/links、AI shared fields、multi-clause replay、voice-pipeline-gateway），无新增失败 |

## 契约映射（plan §2.1 落地核对）

SCHEMA_MAP 8 条全部 `modifiesContract:false`、投影目标全部 `obs_*` 且与 `obs-001/002.sql` 实建表一一对应：span→obs_spans、run→obs_runs、step→obs_steps、spend→obs_spend、evidence→obs_gates、acceptance→obs_acceptances、need→obs_needs、grant→obs_grants。attribute 抽取键不落字面量，集中 `vocabulary.mjs` ATTRIBUTE_KEYS（gen_ai./donego. 命名空间）。

## 与 plan 的偏差（按 AGENTS.md：代码为准，登记差异）

- plan §2.1 表写 `obs_run_metrics`/`obs_step_metrics`/`obs_cost`；实建表与 SCHEMA_MAP 为 `obs_runs`/`obs_steps`/`obs_spend`（与 obs-002 迁移一致，内部自洽）。

## N15 负面路径对照

改 W0 schema/contracts.mjs 的尝试由只读守卫拦截：快照 hash 漂移→`verifyFrozenContracts().ok=false` 并列 mismatches；新增 schema→missing…（注：代码语义为快照未覆盖的盘上文件报 `missing`，快照多余条目报 `unexpected`，test 108-114 覆盖）；FROZEN 畸形→CONTRACT_INVALID。git 层守卫 diff 为空实测通过。
