# impl · obs-cache（G3 模块 7）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> **本 ask（provenance 补齐重跑，2026-10-27）**：对照重派生 plan §2.3/N7/N8 复跑全部门禁
> GREEN，无源码改动；仅本记录更新。逐行复审 `cache.mjs`（171 行）+ 全部 26 测试：
> cacheKey 六字段全必填、内容身份优先于年龄、`expired-but-matching` 不计 stale、
> 三桶互斥排除集均与 plan 一致，未发现缺陷，未改一行。

## 模块文件（plan §4 #7）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/cache.mjs`（171 行） | scripts/agentic/observability/** | `61c78e4` 落地；前一轮 `e4d0103` 审查无缺陷未改；本次复跑无改动 |
| `tests/unit/agentic/observability/cache.test.mjs`（26 tests） | tests/unit/agentic/observability/** | `e4d0103` 扩到 26；本次复跑 26/26 全绿 |

## 设计要点（实现审查结论）

- **cacheKey**（plan §2.3）：`sha256(canonicalJson({kind,contractHash,blockRevision,model,effort,inputsHash}))`，
  6 字段全必填（缺/空白字符串 → `CACHE_KEY_INCOMPLETE`，防部分键碰撞）；canonicalJson
  复用 W0 冻结 `contracts.mjs`（只读，schema hash 由 obs-schema-map 守卫）。
- **新鲜度按内容身份，不按时间**：优先级 unverifiable source → 内容漂移（key/字段）→
  无时钟信息 → 仅年龄。`FRESHNESS` 四态 `FRESH/STALE/EXPIRED_BUT_MATCHING/UNVERIFIABLE`。
- **stale 判定**：`entry.key !== cacheKey(current)` 或任一身份字段漂移 → `STALE` +
  reasons 逐字段记录（含仅存 key 不再可重算的损坏键）。
- **expired-but-matching**（plan §2.3 末条）：内容身份一致但超 TTL → 不计 stale、
  `verifiable:true`，`freshness='EXPIRED_BUT_MATCHING'` 标记随条目传播到
  `partition.verified`，下游（bundle/routes）可区分——本次新增测试钉死该桶语义。
- **排除集**（N7/N8）：`partitionCacheEntries` 三桶互斥；`verified` 仅含
  verifiable 且非 stale 条目；`mock`/`fixture`/`unknown` source 与内容漂移条目
  永不进入 verified。reasons 随桶条目传播（防“CACHE_STALE: []”式空口断言）。
- **store 集成**：`assessCacheEntry`/partition 的注记形态（stale/freshness/reasons）
  正好是 `store.upsertCacheEntry` 的入参契约（obs-002 `obs_cache_entries` 表，
  幂等键 `(owner,key)`），未改动任何 store 代码。

## 文档偏差（按 AGENTS.md 保留代码，此处登记）

plan §2.3 公式第 4 项 `entry.modelSource === 'unknown'` 计入 stale；实现把
`unknown`（与 `mock`/`fixture` 一致）归入 `UNVERIFIABLE` 而非 `STALE`。两者都
被排除出 verified 集合并在 bundle 分别以 `CACHE_UNVERIFIABLE`/`CACHE_STALE`
记 unknown，核心不变量（不可验证绝不计成功）不受影响；但 store 的
`listStaleCacheEntries`（`stale=1`）因此只列内容漂移条目，不列 unknown-source
条目（后者经 `freshness='UNVERIFIABLE'` + reasons 可查）。与 obs-store 已提交
注释（"a fresh or unverifiable entry is not stale"）自洽，故从现有代码不改。

## 新增测试（前一轮 `e4d0103` +10，16→26；本次复跑 26/26）

1. `cacheKey` 拒绝非对象输入（null/undefined/数组/字符串/数字）→ `CACHE_KEY_INCOMPLETE`（原 48-49 行 0 覆盖）
2. `cacheKey` 拒绝空白字符串字段值（model='   '），错误信息含字段名
3. `assessCacheEntry` 拒绝非对象 entry → `CACHE_UNVERIFIABLE`（原 87-88 行 0 覆盖）
4. 可验证但缺存键的条目判 STALE（reasons 含 'key'）
5. 有时钟无 TTL：匹配条目不因年龄过期（仍 FRESH）
6. 有 TTL 无时钟：fail-closed → `UNVERIFIABLE`（钉死，绝不悄悄判新）
7. 非数字 `ttlMs` 视为无 TTL（防御性忽略）
8. 不可解析 `now` 字符串 → `UNVERIFIABLE`（reasons 含 'createdAt'）
9. expired-but-matching 落 `verified` 且携带标记，绝不落 `stale`（plan §2.3 末条钉死）
10. `partitionCacheEntries` 非数组输入 → 三空桶（防御）

## 覆盖的负面路径（plan §3）

- **N7**（contractHash 变更判 stale 且排除出 verified）：STALE 判定 + partition.stale
  + verified 集合断言。
- **N8**（modelSource='mock' 判不可验证）：UNVERIFIABLE 桶 + reasons=['modelSource']
  + 不进端到端成功集合。
- 附带 N7 同族的 inputsHash/blockRevision/model/effort 漂移与损坏 key 判 stale。

## 验证（前一轮 `e4d0103` 实测）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/cache.test.mjs` | 0 | 26 tests / 26 pass / 0 fail / 0 skipped；`cache.mjs` line **100.00%**、branch **96.23%**、funcs 100.00%（≥80% line 门禁通过，branch 同步报告） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | 235 tests / 235 pass / 0 fail / 0 skipped（不破坏兄弟模块） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过） |

## 验证（本次重跑实测，2026-10-27 本会话）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/cache.test.mjs` | 0 | `# tests 26 / # pass 26 / # fail 0 / # skipped 0`；`cache.mjs` line **100.00%**、branch **96.23%**、funcs **100.00%**（≥80% line 门禁通过，branch 同步报告；依赖导入实证：`canonicalJson`@contracts.mjs:11、`MODEL_SOURCES`@vocabulary.mjs:27、`VERIFIABLE_MODEL_SOURCES=['gateway','local']`@:28、错误码@:101-102） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | `# tests 235 / # pass 235 / # fail 0 / # skipped 0`（不破坏兄弟模块） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过，N15） |

未运行：`npm run test:unit` 全量与 `npm run verify:web`（流级门禁，非本模块 ask
范围；本模块本次零源码改动，全套 observability 已绿；全量基线 7 失败集合见 plan §0.1）。

## 边界自查

- 本次改动仅本 `.s2d/impl-obs-cache.md` 记录（源码与测试零改动），`cache.mjs`/`cache.test.mjs`
  相对基线的历史变更均在 §2.1 白名单（scripts/agentic/observability/**、
  tests/unit/agentic/observability/**）。
- 未触碰 contracts/agentic/**、contracts.mjs、db/index.mjs、兄弟模块 .mjs、web/**、生产。
- 无新增依赖（node:test、node:assert、node:crypto、仓库内 ESM）。
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化。
