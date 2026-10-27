# impl · obs-metrics（G4 模块 8）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> **本 ask（provenance 补齐重跑，2026-10-27）**：对照重派生 plan §2.1/§2.4/§4#8/§5 与
> 负面路径 N6/N9/N10/N11 逐行复审前轮 `metrics.mjs`（313 行）+ 21 测试，发现 5 处与
> plan 精确文字不符的缺陷/缺口 → 先写 13 条 RED 测试再修实现（本会话 TDD 全程留痕）。

## 模块文件（plan §4 #8）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/metrics.mjs`（313→410 行） | scripts/agentic/observability/** | `61c78e4` 前轮落地；本次修复 5 处并加双形态行读取器 |
| `tests/unit/agentic/observability/metrics.test.mjs`（21→34 tests） | tests/unit/agentic/observability/** | 本次新增 13 条（先 RED 后 GREEN） |

## 复审发现的缺陷与修复（全部先 RED 后码）

1. **N11 重放重复计数（真缺陷）**：plan §2.1「重试 = 同 inputHash 的 attempt>0；
   **重放不重复计数**」。前轮 `retryMetrics` 按 *行数* 统计 attempt>0 —— 恢复重放
   重录 (inputHash,attempt) 相同行时 totalRetries 翻倍；且 `finalState` 取数组末行
   而非最高 attempt（乱序输入会把已恢复的组误报未恢复）。修复：组内 attempt 去重
   （Set），finalState 取最高 attempt 行的 state。
2. **store 行接缝（真陷阱）**：指标函数只读 camelCase 契约字段；直接喂 store 返回的
   `obs_steps`/`obs_spend` SQL 行（`started_at`/`cost_cny`/`local_share`…）会静默算
   错：所有行被判 incomplete、`local_share` 丢弃、`reconcileSpendReplay` 对混合形态
   无法去重（`step_id` vs `stepId` 生成不同键）。修复：集中 `pick()` 读取器接受契约
   形态与 SQL 形态（契约名优先；`!== undefined` 而非 `??`，**SQL NULL 保留为
   "未知"而非"缺字段"**）。
3. **DAG 边 obs-spans→obs-metrics 落地**：span 行用 `endedAt/ended_at`（非
   `finishedAt`）；`spans.classifyOutcome` 输出 `{status,outcome,incomplete}` 无
   `state`。修复：latency 接受 `endedAt/ended_at` 终点；outcome 用
   `resolveState`（`outcome`∈{succeeded,failed} 映射为 state、`outcome==='timed_out'`
   映射超时、`incomplete`/`timed_out` 布尔容忍 SQL 0/1 整型）。
4. **N10 精确化**：「有 startedAt 无终态 → 计 incomplete」。前轮把**从未启动**（缺
   startedAt）的 step 也计 incomplete，而 running 且 `finished_at IS NULL` 的 store 行
   反而不计。修复：latency 拆 `notStarted`（缺起点）与 `incomplete`（有起点无终态）；
   `stepOutcomeMetrics` 对「有起点、无终点、非终态(state∉{succeeded,failed,skipped})」
   派生 incomplete（显式旗标仍优先）。
5. **N9 优先级**：「超时不算失败也不算成功」。前轮 `timedOut` 行若 `state='failed'`
   仍计 failed。修复：timedOut 行不计入 failed/succeeded 任何一个桶。
6. **need 超时率补全（小项）**：plan §2.1 把 `need.expired` 映射到「超时」指标，前轮
   只有 `defaultRate`。修复：新增 `expiredRate`（计数的 `expired` 本已有）。

保持不变（复审通过）：`percentile` nearest-rank 与 1..100 拒绝；UNKNOWN 哨兵绝不落 0
（p50/p90/max/费率/成本/localShare 空样本一律 UNKNOWN，`costCny===0` 显式免费与
NULL 未知严格区分，PARTIAL/KNOWN/UNKNOWN 状态）；`runMetrics` 八态枚举越界抛
`CONTRACT_INVALID`（枚举与 FROZEN run.schema.json 逐字核对一致，本会话实测）；
acceptance 仅 `accepted` 计收益（枚举 accepted/revision_requested/rejected 与
acceptance.schema.json 一致）；need 五态、grant 六态与 need/grant.schema.json 一致；
`buildMetrics` 任何数据只到 PROVISIONAL（§2.4：指标不是端到端证据）。

## 覆盖的负面路径（plan §3）

- **N6**：`cost_cny NULL` → unknownCostRuns+1、costStatus UNKNOWN、costCny null、绝不落 0；
  `cost_cny 0` → KNOWN+freeRuns=1（store 形态新增两测钉死）。
- **N9**：timed_out 三通道（`timedOut:true` / SQL `timed_out:1` / `outcome:'timed_out'`）
  均「不算失败也不算成功」。
- **N10**：有 startedAt 无终态 → incomplete（store 行派生 + span 投影旗标）；缺起点 →
  notStarted 不混入；UNKNOWN 传播由 bundle 消费 metrics.cost/latency 形态（字段只增未改）。
- **N11**：attempt 去重（重放不重复计数）、恢复判定按最高 attempt 与行序无关、
  `reconcileSpendReplay` 跨形态 (stepId,attempt) 去重、`input_hash` 分组。

## 验证（本会话实测，2026-10-27）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --test tests/unit/agentic/observability/metrics.test.mjs`（实现前） | 1 | 21 pass + **13 fail**——新增 13 条全部 RED，原 21 条不破（RED 留痕） |
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/metrics.test.mjs` | 0 | `# tests 34 / # pass 34 / # fail 0 / # skipped 0`；`metrics.mjs` line **100.00%**、branch **84.85%**（基线 79.61%）、funcs **100.00%**（≥80% line 门禁通过，branch 同步报告） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | `# tests 256 / # pass 256 / # fail 0 / # skipped 0`（含同 worktree 并行的 obs-bundle agent 未提交改动，兄弟兼容无回归；G3 收口时为 235） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 0 | 输出为空（只读守卫通过，N15） |
| 枚举核对（python3 读 FROZEN schema） | 0 | acceptance/need/grant/step/run 枚举与实现逐字一致 |

未运行：`npm run test:unit` 全量与 `npm run verify:web`（流级门禁，归 G6 obs-report
收口；本模块全套 observability 已绿，全量基线 7 失败集合见 plan §0.1）。

## 边界自查

- 本次改动仅 `metrics.mjs`、`metrics.test.mjs`、本记录；同 worktree 并行 agent 的
  `bundle.mjs`/`bundle.test.mjs` 未提交改动**未纳入本次提交**（选择性 stage）。
- 未触碰 contracts/agentic/**、contracts.mjs、db/index.mjs、兄弟模块 .mjs、web/**、生产。
- 无新增依赖（node:test、node:assert、仓库内 ESM）。
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化。

## 文档偏差（按 AGENTS.md 保留代码，此处登记）

plan §4 #8 依赖标注「5,6」（obs-spans/obs-gates）：实现上 metrics 不 import 这两个
模块（纯函数、零耦合），依赖体现为**数据形态兼容**——本次正是把该边落地（读
classifyOutcome 投影与 store 行）。gate 数据不进 metrics（门禁记录/评估归 obs-gates，
矩阵归 obs-matrix），与 §4 #6/#10 职责划分一致，故不改。
