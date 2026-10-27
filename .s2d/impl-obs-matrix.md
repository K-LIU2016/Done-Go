# impl · obs-matrix（G5 模块 10）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> **本 ask（provenance 补齐重跑，2026-10-27）**：对照 plan §2.4/§3/§7.2 复审前一轮
> `matrix.mjs`（268 行，`61c78e4`）+ 20 测试，发现 **1 处计划缺口 + 2 处真实缺陷**，
> 按 TDD（先 RED 后 GREEN）补齐：34/34 全绿，line 97.41% / branch 84.47% / funcs 100.00%。

## 模块文件（plan §4 #10）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/matrix.mjs`（500 行） | scripts/agentic/observability/** | `61c78e4` 落地 268 行；本次补 §7.2 报告解析路径 + 两缺陷修复 → 500 行 |
| `tests/unit/agentic/observability/matrix.test.mjs`（34 tests） | tests/unit/agentic/observability/** | 原 20（`61c78e4`）；本次 +14 → 34（先 RED 实证 14 失败） |

## 依赖契约（模块 9 等输出形状，本会话实读）

- `bundle.verdictFor()`（bundle.mjs:257-263）：unknowns severity 集合 → BLOCKED>UNKNOWN>PROVISIONAL>VERIFIED，本模块行/汇总状态仍只经它推导（plan §4 #10「只按 §2.4 推导」）；
- `gates.assessGate()`（gates.mjs:43-66）：`{passed, evidenceStatus, verifiable}`——`gateUnknowns` 只读不改；
- `vocabulary.normalizeActor()`（vocabulary.mjs:183-217）：缺失 model → `provenance=UNKNOWN`、`model=null`，`MODEL_SOURCE_INVALID`/`ACTOR_ROLE_INVALID` 照抛；
- `report.mjs` 逐流明细渲染格式（report.mjs:165-187）：本次解析器的**唯一**词法来源——`- HEAD:`/`- 契约: <relation>@<commit7>`/`- push:`/`- 门禁:`/`- 评审模型:`/`- 风险:`/`- web 证据:`/`- 状态:`，往返测试钉死两者不漂移。

## 复审发现的缺口与缺陷（TDD 修复）

### 缺口 1（计划 §7.2）：报告解析数据源路径缺失

§7.2 裁决「两路都支持」，但前一轮只实现了结构化 JSON（`createMatrix`）。本次新增：

- `parseStreamReport({name, content})`：纯函数、零磁盘 IO；按 `### <name>` 定位逐流明细段，
  只识别 report.mjs 实际渲染的行格式（往返 round-trip 测试）。**缺 HEAD 或门禁行、缺整段、
  content 非字符串 → `ok:false` + `parseError`**；其余字段缺失保持 null，绝不推断散文。
- `createMatrixFromReports({ownerId, frozen, generatedAt, reports})`：`reports=[{name,content}]`，
  校验与 `createMatrix` 同源（ownerId/frozen/重复流名/缺 name 全拒绝），内部映射后复用
  `createMatrix` 单一推导路径——两路数据源、一个裁决器。
- 解析失败行 **不缺席不猜造**（§7.2「解析失败即 UNKNOWN」）：合成 `head:'UNKNOWN'`、空
  gates/actors 的行 + `REPORT_PARSE_FAILED`(UNKNOWN)，仍占一行参与汇总。
- 契约列截断语义：报告只带 7 字符 commit 前缀。前缀与冻结基线不符 → `CONTRACT_DRIFT`
  (BLOCKED)；相符仍不能证全等 → `CONTRACT_PREFIX_ONLY`(PROVISIONAL)——**纯报告路径永远
  到不了 VERIFIED**（BRIEF §3 不把报告升级为端到端成功）。
- 报告里的 `- 状态:` 是 claim 不是输入：`claimedStatus` 仅存档；与推导不一致 →
  `STATUS_CONFLICT`(PROVISIONAL) 入 unknowns（冲突记录），推导永不采信报告声明。
- 报告引用的 gate 计数（rc/pass/fail/skip）标 `reportedOnly:true` → `GATE_INCOMPLETE/
  REPORTED_ONLY` 压 PROVISIONAL（有数字但无一手证据，§2.4 阶梯「单测→最高 PROVISIONAL」）。

### 缺陷 2：空 gates 数组可静默 VERIFIED（§2.4 违例）

前一轮 `deriveRow` 对 `gates: []` 不产生任何 unknown——一条 web 证据齐全但**零门禁记录**的流
可判 VERIFIED，违反 §2.4「缺 test 命令/rc → UNKNOWN」。修复：`gates.length===0` →
`TEST_EVIDENCE_MISSING/NO_GATES`(UNKNOWN)（与 bundle 侧 `NO_GATES` 语义对齐，bundle.mjs 复审
同轮发现同族缺陷）。

### 缺陷 3：零评审 actor 名单可静默 VERIFIED（红线 7 违例）

前一轮 `reviewActors: []` + `fixActors: []` 不产生 unknown。但「没有任何 actor 声明」≠
「评审通过」——BRIEF §4 要求四路评审与修复 actor 真实模型（含 NULL 与否）。修复：两名单
皆空 → `REVIEW_MISSING/NO_REVIEW_ACTORS`(UNKNOWN)。有 actor 但 `resolved_model=NULL` 仍走
`REVIEW_MODEL_UNRESOLVED`(UNKNOWN)（N14，原有行为保持）。

## TDD 时间线（本会话实测）

1. **RED**：先写 14 测试（空 gates / 零 actor / 往返 / 前缀封顶 / N14 报告路径 / N13 报告路径 /
   报告 BLOCKED / 前缀漂移 / claim 冲突 / 解析失败降级 / 关键行缺失 / 重复报告名 / 入参校验 /
   零风险不造数），跑 `node --test tests/unit/agentic/observability/matrix.test.mjs`
   → `# tests 34 / # pass 20 / # fail 14`——not ok 21–34 恰为 14 个新测试（逐条核对），旧 20 条全绿；
2. **GREEN 迭代**：首轮 31/34；3 剩余失败中 2 个为实现语义（报告 gate 无 evidence 应压
   PROVISIONAL 而非 UNKNOWN——加 `reportedOnly`），1 个为**测试自伤**（往返报告自洽，
   claim 冲突场景须手工注入 `- 风险: R9 severity=HIGH status=open` 行；已改测试并在测试内注释
   原因）→ 同命令 `# pass 34 / # fail 0`。

## 覆盖的负面路径（plan §3，matrix 侧）

- **N5** gate 缺 rc/name → `GATE_INCOMPLETE`(UNKNOWN)（旧测试保持 + 报告路径同规则）；
- **N13** 只有单测 → `SINGLE_TEST_ONLY` ≤PROVISIONAL——结构化与报告路径双测试；
- **N14** 评审 `resolved_model=NULL` → `REVIEW_MODEL_UNRESOLVED`(UNKNOWN)、`resolvedModel:null`
  原样呈现——reviewer/fixer 与报告路径三测试；
- **重复** 流名/报告名 → `MATRIX_INCOMPLETE` 拒绝（N3/N4 同族的矩阵侧幂等键）；
- **§7.2 失败路径** 段缺失/content 非串/HEAD·门禁行缺失 → `ok:false` + 行级 `REPORT_PARSE_FAILED`
  (UNKNOWN)；未识别的门禁片段占位为 `rc:null` → `GATE_INCOMPLETE`（不静默消失）；
- **不猜造** 零风险行 → `risks:[]` 且无 `RISK_OPEN`；风险字段缺失不发明 id/severity。

## 门禁实测（plan §5，本 ask 命令与输出）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 模块 GREEN | `node --test tests/unit/agentic/observability/matrix.test.mjs` | `# tests 34 / # pass 34 / # fail 0`（43–48ms） |
| 本流全套 | `node --test tests/unit/agentic/observability/*.test.mjs` | `# tests 274 / # pass 274 / # fail 0`（首跑 271/274，3 失败为兄弟节点 obs-routes 并行 RED，会话内其转绿后复跑全绿；非本模块文件） |
| 覆盖率（§5.2） | `node --experimental-test-coverage --test tests/unit/agentic/observability/matrix.test.mjs` | `matrix.mjs line 97.41 / branch 84.47 / funcs 100.00`（未覆盖仅防御分支） |
| 全量（§5.3） | `node scripts/test-unit.mjs`（= `npm run test:unit` 脚本体，npm ci 缺 sherpa 平台锁条目无法装依赖，直接跑 node 入口） | rc=1，`# tests 1244 / # pass 1235 / # fail 7 / # skipped 2`；7 条与 §0.1 清单**逐一相符**（metric-layout / design-system / streamChat / independent-authenticated / AI-shared-fields / multi-clause-replay / voice-pipeline-gateway），不多不少 |
| web（§5.4） | `npm run verify:web` | rc=0，`# tests 227 / # pass 227 / # fail 0`（本流未改 `web/**`） |
| 只读守卫（§5.5） | `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 输出为空（FROZEN 与 schema/DB 入口未动） |
| Playwright（§5.6） | 未启用（本模块纯数据无路由 e2e） | — |

## 边界与红线自查

- 只改 `scripts/agentic/observability/matrix.mjs`、`tests/unit/agentic/observability/matrix.test.mjs`、
  本记录文件——全部在 §2.1 归属内；`git diff --stat 60fdc73 HEAD` 范围未变（终验见上表只读守卫）；
- 无新增依赖（仅 `node:*` 与同目录 ESM）；无密钥；未碰 Done-Go 主仓/classic/thinkpad/生产/LiteLLM/.env；
- 所有 actor 显式绑定模型或显式标 UNKNOWN（`resolvedModel:null` 原样入行数据与报告渲染）；
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化，
  只 stage 本模块 3 文件（并行兄弟节点 obs-routes 的 routes.mjs/routes.test.mjs 未提交改动不入本提交）。

## 与兄弟节点的并发事实（供 report 汇总）

- 会话内 `routes.mjs`/`routes.test.mjs` 由 obs-routes 节点并行修改（其 RED 阶段致本流全套首跑
  3 失败）；本模块未触碰该两文件，最终全套 274/274 时其已 GREEN；
- 一次诊断用 `git stash`/`stash pop` 完整还原（含兄弟未提交改动），终态 `git status` 确认无损。
