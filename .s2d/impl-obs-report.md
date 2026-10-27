# impl · obs-report（G6 模块 12）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（FROZEN 本会话 cat 验证 = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> **本 ask（provenance 补齐重跑，2026-10-27）**：对照 plan §4 #12 复审前一轮 `report.mjs`
> （212 行）+ 14 测试，发现 **1 处真实缺陷 + 2 处计划缺口**，按 TDD（先 RED 后 GREEN）补齐：
> 20/20 全绿，line 100.00% / branch 87.80% / funcs 100.00%。

## 模块文件（plan §4 #12）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/report.mjs`（253 行） | scripts/agentic/observability/** | 前轮 212 行落地；本次修前缀丢失缺陷 + 冲突/解析记录 → 253 行 |
| `tests/unit/agentic/observability/report.test.mjs`（20 tests） | tests/unit/agentic/observability/** | 前 14 保持；本次 +6（先 RED 实证 4 失败 + 2 补充） |

职责（plan §4 #12）：矩阵 → Markdown 渲染（含 UNKNOWN 段与冲突记录），落调用方指定路径
（BRIEF §4 七项回报中可复核的逐流证据：HEAD/契约/push/门禁/评审模型/风险/状态/web 证据）。

## 依赖契约（模块 10 本会话实读）

- `matrix.mjs` 行形状（本轮 8803a8e 重写后）：新增 `claimedStatus`、`parseError`、
  `contractCommitPrefix`（全 commit 缺失时唯一契约证据）、`contractRelation:'matches-prefix'`、
  gate `reportedOnly`；unknowns 新增 `STATUS_CONFLICT`/`REPORT_PARSE_FAILED`/`CONTRACT_PREFIX_ONLY` 等；
- `parseStreamReport`（matrix.mjs:401-452）以 report.mjs 逐流明细行为唯一词法来源（往返钉死）；
  本模块新增行（`- 状态冲突:`、`- 解析:`）不匹配其任何识别模式，不破坏往返；
- `vocabulary.mjs`：`isNonEmptyString`/`observabilityError`/`OBS_ERROR_CODES`（REPORT_EXISTS、INVALID_ARGUMENT）。

## 复审发现的缺陷与缺口（TDD 修复）

### 缺陷 1：前缀-only 契约 commit 被渲染成 UNKNOWN（往返断裂）

`renderContract` 只读 `contractCommit`。报告解析派生的行 `contractCommit=null`、
`contractCommitPrefix='b9d9bdf'`、relation=`matches-prefix`，渲染成 `matches-prefix@UNKNOWN`
——前缀丢失；再经 `parseStreamReport` 解析得 prefix=`'UNKNOWN'` → `contractUnknowns` 判
`CONTRACT_DRIFT`(BLOCKED)：**重渲染一份报告即伪造契约漂移**。修复（report.mjs:82-93）：
full commit 缺失时渲染 `contractCommitPrefix` 原文。修复后双重往返
（报告→矩阵→渲染→再解析→再矩阵）prefix 保持、无 CONTRACT_DRIFT、状态稳定 PROVISIONAL。

### 缺口 2：状态冲突只在 ## UNKNOWN 深处，逐流明细无冲突记录（plan §4 #12「含…冲突记录」）

`claimedStatus ≠ derived` 时原渲染只写派生状态。补：明细段新增
`- 状态冲突: claimed=<claim> derived=<derived>`（report.mjs:196-199），与 ## UNKNOWN 的
`STATUS_CONFLICT · claimed=… derived=…` 互为印证；无冲突的流不产生该行。

### 缺口 3：解析失败原因不在逐流明细（§7.2「解析失败即 UNKNOWN」的可读性）

parse 失败合成的行（REPORT_PARSE_FAILED）此前只是一排无解释的 UNKNOWN。补：明细段首行
`- 解析: <parseError>`（report.mjs:175-176），SECTION_NOT_FOUND / MISSING_FIELD:门禁 等
原因就地可见；正常流无该行。

### 附带（覆盖率与字面性）

- 防御渲染测试：畸形行（缺 name/command/rc 的 gate、缺 role 的 actor、缺 id 的 risk…）渲染
  字面 UNKNOWN，绝不空白、绝不 0（对齐 N6「未知显示未知」在报告层的体现）；
- `writeMatrixReport` 空/缺 path → `INVALID_ARGUMENT` 拒绝（report.mjs:213-216，此前无测试）。

## TDD 时间线（本会话实测）

1. **RED**：先写 4 测试（前缀保留 / 双重往返无漂移 / 冲突记录 / 解析记录），跑
   `node --test tests/unit/agentic/observability/report.test.mjs`
   → `# tests 18 / # pass 14 / # fail 4`——not ok 15–18 恰为 4 个新测试，旧 14 全绿；
2. **GREEN**：实现上述三处修改，同命令 `# pass 18 / # fail 0`（一次通过）；
3. **补充**：+2 测试（防御渲染字面性、空路径拒绝）→ 20/20；覆盖率 line 99.11→**100.00**、
   branch 60.53→**87.80**、funcs 100。

## 覆盖的负面路径（plan §3，report 侧）

- **N6**（报告层）缺失计数/风险字段渲染 UNKNOWN，绝不 0 / 绝不空白（degenerate-row 测试）；
- **N13/N14** 渲染保持：`resolved_model=NULL` 字面呈现（旧测试）；报告路径派生状态由
  matrix 侧裁决，本模块只渲染不推导；
- **§7.2 失败路径** parse 失败行的原因在明细可见，行不缺席；
- **冲突记录** claimed≠derived 显式成行，非冲突流零噪音；
- **拒绝路径** 空 path `INVALID_ARGUMENT`；已存在文件未加 `overwrite:true` 拒 `REPORT_EXISTS`
  且原文件不动（旧测试保持）。

## 门禁实测（plan §5，本 ask 命令与输出）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 模块 GREEN | `node --test tests/unit/agentic/observability/report.test.mjs` | `# tests 20 / # pass 20 / # fail 0` |
| 本流全套 | `node --test tests/unit/agentic/observability/*.test.mjs` | `# tests 281 / # pass 281 / # fail 0 / # skipped 0` |
| 覆盖率（§5.2） | `node --experimental-test-coverage --test tests/unit/agentic/observability/report.test.mjs` | `report.mjs line 100.00 / branch 87.80 / funcs 100.00`（无未覆盖行） |
| 全量（§5.3） | `node scripts/test-unit.mjs`（= `npm run test:unit` 脚本体；npm ci 因 sherpa-onnx-win-arm64 平台锁缺项不可装，沿 plan §0 记录） | `# tests 1251 / # pass 1242 / # fail 7 / # skipped 2`；7 条与 §0.1 清单逐一相符（streamChat / independent-authenticated / AI-shared-fields / metric-layout / design-system / multi-clause-replay / voice-pipeline-gateway），不多不少 |
| web（§5.4） | `npm run verify:web` | rc=0，`# tests 227 / # pass 227 / # fail 0`（本流未改 `web/**`） |
| 只读守卫（§5.5） | `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs` | 输出为空 |
| FROZEN | `cat contracts/agentic/FROZEN` | `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓ |
| Playwright（§5.6） | 未启用（本模块纯渲染无路由 e2e） | — |

## 边界与红线自查

- 只改 `scripts/agentic/observability/report.mjs`、`tests/unit/agentic/observability/report.test.mjs`、
  本记录文件——全部在 §2.1 归属内；`git diff --name-only 60fdc73` 顶层仅
  `.s2d`/`scripts`/`tests`（守卫见上表）；
- 无新增依赖（仅 `node:fs`/`node:path` 与同目录 vocabulary）；无密钥；未碰
  Done-Go 主仓/classic/thinkpad/生产/LiteTTM/.env；
- 所有渲染均字面：resolved_model=NULL 显式、UNKNOWN 显式、无 0 冒充未知；
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化，
  只 stage 本模块 3 文件。
