# impl · obs-bundle（G4 模块 9）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> **本 ask（provenance 补齐重跑，2026-10-27）**：对照重派生 plan §2.4/§2.1 复审前一轮
> `bundle.mjs`（256 行，`61c78e4`）+ 17 测试，发现 **2 处真实缺陷**，按 TDD（先 RED
> 后 GREEN）修复：26/26 全绿，line 100.00% / branch 86.18% / funcs 100.00%。

## 模块文件（plan §4 #9）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/bundle.mjs`（324 行） | scripts/agentic/observability/** | `61c78e4` 落地 256 行；本次修复证据 schema 违规 + 补 §2.4 HIGH 条款 → 324 行 |
| `tests/unit/agentic/observability/bundle.test.mjs`（26 tests） | tests/unit/agentic/observability/** | 原 17（`61c78e4`）；本次 +9 → 26（4 个先 RED 验证失败，5 个补负面路径） |

## 依赖契约（模块 5/6/7/8 输出形状，本会话实读）

- `spans.classifyOutcome().spans[]` = `{id, status, outcome, incomplete}`（spans.mjs:67-80）——`spanUnknowns` 的输入；
- `gates.assessGate()` = `{passed, coverageOk, evidenceStatus∈VERIFIED/PROVISIONAL/UNKNOWN/BLOCKED, verifiable}`（gates.mjs:43-66）；
- `cache.partitionCacheEntries()` 三桶 `{verified, stale, unverifiable}`，条目带 `key/kind/freshness/reasons/modelSource/verifiable`（cache.mjs:142）；
- `metrics.costMetrics()` 输出 `costCny: knownCostRuns===0 ? null : number`、`costStatus`、`unknownCost`（metrics.mjs:203-218）——`costUnknowns` 只读输出键，兄弟流本次对 metrics 的未提交改动（输入拼写加宽 `pick(record,'costCny','cost_cny')`）不改输出键，兼容已由 257/257 共绿实证。

## 复审发现的缺陷与修复（TDD）

### 缺陷 1：证据条目夹带非契约字段 + mock 证据以 verified 旅行（BRIEF §3 违例）

前一轮 `collectEvidence`（旧 bundle.mjs:168-190）：

- gate 证据条目 spread 后加顶层 `gate`/`head`，cache 条目带 `key`，web 条目带 `passed`/`failed`——而冻结 `evidence.schema.json` 是 `additionalProperties:false`（本会话 cat 验证：required `type,title`，`type` 枚举含 `metric`/`test-run`，可选 `uri/detail/verified`）。即 bundle 自己在制造 schema 漂移（plan §2.1 红线精神、N15）；
- 更严重：gates 模块约定用非契约字段 `source:'mock'` 标 mock 证据（gates.test.mjs:125,193），`assessGate` 据此把 gate 压到 PROVISIONAL，但 bundle 的 `item?.verified===true` 放行条件让 **mock 证据条目仍以 `verified:true` 进入 `bundle.evidence`** —— 正是 BRIEF §3「不将 mock…升级为端到端成功」禁止的升级。

**修复**（新 `collectEvidence`）：

- 每条出行证据经 `contracts.mjs` 的 `loadSchema('evidence.schema.json')` + `validate`（只读，与 spans.mjs:20-31 同一模式）校验；不合法条目被**排除**并记 `EVIDENCE_INVALID`（severity PROVISIONAL，带 origin/title/errors）——排除永不静默；
- 归因迁入 schema 合法的 `detail`：cache 条目 `cache key <k> content-identical (<freshness>)`；web 条目 `end-to-end rc=0, passed N, failed N, skipped N`；gate/head 归因保留在 `bundle.gates.items`（结构化，无需走私字段）；
- plan §2.3 语义保持：内容身份一致（非 stale）的 cache 条目可进「已验证」证据集（`type:'metric'`），但 verdict 永不从 cache 推导（`gateSummary`/`webEvidenceUnknowns` 不读 cache）——§2.4「缓存摘要→最高 PROVISIONAL」在裁决层成立。

### 缺陷 2：§2.4 末行「HIGH 未修 → BLOCKED」无输入通道

bundle 作为 §2.4 点名的逐项裁决器，却没有任何方式表达「四路评审存在未修 HIGH」。新增：

- `assembleBundle({..., findings})` 可选入参；`findingUnknowns`（镜像 matrix.mjs:128-136 `riskUnknowns` 语义）：`status==='open'` 且 severity `HIGH|CRITICAL` → `FINDING_OPEN` **BLOCKED**；其他 open → PROVISIONAL；非 open（含 resolved）跳过——**只有显式 open 才算未修，不做启发式猜测**（与 plan §7.2 精神一致）；
- findings 缺省 → 零 unknown、零行为变化（向后兼容，有测试钉死）；
- 新错误码 `EVIDENCE_INVALID`、`FINDING_OPEN` 加入 `BUNDLE_UNKNOWN_CODES`；`BUNDLE_STATUS` 与 `verdictFor` 签名不变（matrix.mjs:19 `import { verdictFor }` 不受影响，matrix 套件 257/257 内全绿实证）。

## TDD 时间线（本会话实测）

1. **RED**：先写 5 测试（schema 合法性 / mock 不旅行 / HIGH 阻断 / MEDIUM 压级+resolved 放行 / 缺省 findings 零变化），跑
   `node --experimental-strip-types --test tests/unit/agentic/observability/bundle.test.mjs`
   → `# tests 22 / # pass 18 / # fail 4`——失败的恰为前 4 个新测试（逐条核对 not ok 18/19/20/21），旧 17 条全绿，缺省-findings 兼容测试天然绿；
2. **GREEN**：上述修复后同命令 → 22/22；
3. **补负面路径**（覆盖 plan §3 防御分支）：过线 gate 零证据→`GATE_INCOMPLETE/NO_EVIDENCE`（§2.1「gate 必挂 evidence」）、`status:'error'` span→BLOCKED（N10 族）、零 gates→UNKNOWN/`NO_GATES`（§2.4「缺 test 命令/rc」）、畸形输入（缺字段 gate / web rc=1 无计数 / metrics 无 cost / cache=null / spans=null / 无 severity open finding）显式降级不崩溃 → 26/26。

## 覆盖的负面路径（plan §3，bundle 侧）

- **N6** costCny 缺失 → `COST_UNKNOWN`，输出保持 `null` 绝不落 0（test 13 + 畸形输入测试）；
- **N10** 不完整/断线 span → `SPAN_INCOMPLETE` UNKNOWN 传播；`timed_out` 单列 `SPAN_TIMED_OUT` 不算成败；`error` span = 已证实失败 → BLOCKED；
- **N13** 只有单测（无 web 证据）→ `E2E_EVIDENCE_MISSING` 强制 ≤PROVISIONAL，永不 VERIFIED；
- **N14 族** 评审 actor `model` 缺失 → `ACTOR_UNRESOLVED` → UNKNOWN；mock source → `ACTOR_NOT_VERIFIABLE` → PROVISIONAL；
- **N15 精神** 出行证据逐条过冻结 schema，走私字段与 mock 标记一律 `EVIDENCE_INVALID`；
- **§2.4 HIGH 未修** → `FINDING_OPEN` BLOCKED；CRITICAL 同级；open MEDIUM → PROVISIONAL；resolved 不计。

## 文档偏差（按 AGENTS.md：从现有代码，此处登记）

1. **plan §2.4 第 3 行「缺 web 证据 → UNKNOWN」**：实现区分两种缺失——web 证据**完全未提供**（如纯单测流）→ `E2E_EVIDENCE_MISSING` **PROVISIONAL**（reason `NO_WEB_EVIDENCE`，服务 N13「只有单测→PROVISIONAL」；旧 test 6 钉死）；**提供了但缺 command/rc** → **UNKNOWN**（reason `NO_RC`）。matrix.mjs（:91 `SINGLE_TEST_ONLY` PROVISIONAL vs :96 `NO_RC` UNKNOWN）同此区分，两个裁决器一致。若 CTO 裁决「任何 web 证据缺失一律 UNKNOWN」，需同步改 bundle+matrix 各一处 severity 与两侧测试。
2. **gates 的 `evidence[].source` 约定**（gates.mjs:25,59）是**非契约字段**（evidence.schema.json 无 `source`，additionalProperties:false）——模块 6 文件域，本模块不改；bundle 侧现在对它 fail-closed（带 source 的条目过不了 schema 守卫 → `EVIDENCE_INVALID`，与 assessGate 压 PROVISIONAL 的方向一致）。
3. 新鲜 cache 条目在 `bundle.evidence` 标 `verified:true`：plan §2.3 明文允许非 stale 条目进「已验证」证据集；§2.4「缓存摘要→最高 PROVISIONAL」由裁决层保证（verdict 只由 unknowns 折叠，cache 永不贡献 VERIFIED）。

## 验证（本会话实测，2026-10-27）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --test tests/unit/agentic/observability/bundle.test.mjs`（RED 阶段） | 1 | `# tests 22 / # pass 18 / # fail 4`（恰为 4 个新测试，见 TDD 时间线） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/bundle.test.mjs`（GREEN） | 0 | `# tests 26 / # pass 26 / # fail 0 / # skipped 0` |
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/bundle.test.mjs` | 0 | `bundle.mjs` line **100.00%**、branch **86.18%**、funcs **100.00%**（≥80% line 门禁通过，branch 同步报告且亦达标） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | `# tests 257 / # pass 257 / # fail 0 / # skipped 0`（含兄弟 obs-metrics 未提交在途改动，共绿；不破坏兄弟模块） |
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`（bundle 行抽查） | 0 | `bundle.mjs 100.00/86.18/100.00`，`metrics.mjs 100.00/84.85/100.00`（兄弟） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过，N15） |

未运行：`npm run test:unit` 全量与 `npm run verify:web`（流级门禁；`npm ci` 自身 EUSAGE 断裂见 plan §0，与 W10 前就存在；全量基线 7 失败集合见 plan §0.1，非本模块 ask 范围）。未用 Playwright（本模块无 e2e）。

## 边界自查

- 本次改动仅 `bundle.mjs`、`bundle.test.mjs`、本记录；`git status` 中兄弟 obs-metrics 的 `metrics.mjs`/`metrics.test.mjs` 在途改动**不属于本提交**（分开提交，见下方提交说明）。
- 未触碰 contracts/agentic/**（只读 loadSchema/validate）、contracts.mjs、db/index.mjs、兄弟模块 .mjs、web/**、生产、密钥。
- 无新增依赖（node:test、node:assert、node:url、仓库内 ESM `../contracts.mjs` 只读复用，spans.mjs 同模式）。
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化。
