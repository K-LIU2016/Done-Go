# obs-provenance（组2 · 模块4）实现记录

- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w10-observability`，分支 `feat/s2d-w10-observability`，基 W0 `60fdc73`（`contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`，本 ask 内 cat 验证）。
- 实现落点（前次会话整体提交 `61c78e4`）。本 ask（provenance 补齐重跑）做规格核对 + 门禁全部复跑 + 本记录刷新；**未改动任何 `.mjs`**（写本文件前 `git status --porcelain` 为空）。

## 交付文件

| 文件 | 行数 | 说明 |
|---|---:|---|
| `scripts/agentic/observability/provenance.mjs` | 163 | 实现 |
| `tests/unit/agentic/observability/provenance.test.mjs` | 189 | 单测（18 用例） |
| `.s2d/impl-obs-provenance.md` | 本文件 | 模块明细 |

依赖：仅 `vocabulary.mjs`（`provenance.mjs:10-15` import `normalizeActor/observabilityError/PROVENANCE/OBS_ERROR_CODES` 四符号，本 ask grep 验证均存在导出），与 plan 模块表「依赖 1」一致；无其它 import，无 I/O、无时钟、无随机——纯函数模块。

## 规格核对（`.s2d/plan.md:117` 模块表行4 + §2.2 四条规则）

职责三项逐一落位（本 ask 实读源码 cite）：

1. **actor/model 解析与 UNKNOWN 标注**：复用 `normalizeActor`（vocabulary，缺失/空白 model → `model=null` + provenance `UNKNOWN`，禁继承）后：
   - `summarizeProvenance`（`provenance.mjs:82-96`）：resolved/unknown/verifiable/mock 计数 + `unresolvedRoles` 清单 + 派生 `evidenceStatus`（`74-79`：空名单或含 UNKNOWN → `UNKNOWN`；全部可验证 → `VERIFIED`；其余 → `PROVISIONAL`，对齐 §2.4 裁决输入）；
   - `assertActorsResolved`（`54-72`）：整份 roster 一次报全所有未解析 actor（`unresolvedRoles` + 逐条 reason）。
2. **`assertActorResolved`**（`provenance.mjs:31-48`）：model 缺失/空白 → 抛 `PROVENANCE_UNRESOLVED`（reason `MODEL_MISSING`）；model 已解析但来源不可验证（mock/fixture/unknown）→ 同码抛出（reason `MODEL_SOURCE_UNVERIFIABLE`）。只认 actor 自身声明，绝不从邻 actor/请求模型回填（继承禁令在 `vocabulary.mjs:183` `normalizeActor(actor, _neighbour)` 刻意忽略 `_neighbour`）——对齐 CTO-DECISIONS §3.3。
3. **`markRunComplete` 闸门**（`provenance.mjs:107-136`）：
   - 任一 actor provenance=UNKNOWN → 抛 `RUN_NOT_VERIFIABLE`（`119-126`），且不改动入参 run（`108` 只读浅拷贝源；N2 测试断言 `run.state` 不变）——run 只能由调用方另行落 `partial`/`unknown`，绝不写 `succeeded`；
   - 目标状态必须在 `['succeeded','partial','unknown']`（`18`、`110-116`），`running` 等非终态 → `RUN_STATE_INVALID`；
   - 通过后返回 `{...run, state, provenance: summary+verifiable, verifiable}`；mock/fixture roster 可完成但 `evidenceStatus='PROVISIONAL'`、`verifiable=false`（`128-135`），满足 §2.2 规则4「mock/fixture 永不计入真实调用成功」。

附带 `actorRoster`（`139-161`）：同 role 去重；同 role 双模型/双来源 → `PROVENANCE_CONFLICT`。

## 覆盖的负面路径（`.s2d/plan.md` §3，本模块份内）

- **N1**（缺失/空 model）：`provenance.test.mjs:15-33`（missing + blank 两态抛 `PROVENANCE_UNRESOLVED`）；「接受写入但标 UNKNOWN」的写入侧由 obs-spans 套件承接（全套件绿）。
- **N2**（UNKNOWN actor 调 `markRunComplete`）：`provenance.test.mjs:68-76` 抛 `RUN_NOT_VERIFIABLE` + 入参 run 不被变异。
- **§2.2 规则4 / BRIEF §3 末条**（mock 不算真实成功）：`:110-119`（mock roster 完成但 PROVISIONAL）、`:151-156`（fixture → PROVISIONAL）、`:165-173`（markRunComplete 不得把 mock roster 升级 VERIFIED）。
- 未知来源（已解析 model + 无 modelSource）拒收：`:35-45`；整 roster 齐报：`:47-61`；空 roster 视为空洞可解析：`:63-66`；非终态状态拒绝：`:102-108`；role 冲突：`:175-189`。

## 检查（本 ask 内执行，均为实际命令，cwd=worktree；节点=本次补齐重跑会话）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-test-coverage --test tests/unit/agentic/observability/provenance.test.mjs` | 0 | `# tests 18 / # pass 18 / # fail 0 / # skipped 0`；`provenance.mjs` line **100.00%** / branch 85.11% / funcs 100% |
| `node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`（`plan.md:146` §5.2 门禁原样） | 0 | `# tests 235 / # pass 235 / # fail 0 / # skipped 0`；`provenance.mjs` line **100.00%** / branch 85.71% / funcs 100%（全套件 all files line 97.55%）。注：235 为本 ask 时点全套件规模（前次记录 211，其它模块 ask 增测后增长），本模块 18 条不变且全绿 |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs`（`plan.md:149` §5.5 只读守卫） | 0 | 输出为空（冻结面零改动）；`cat contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`，与 ask 声明一致 |
| `git status --porcelain`（写本文件前） | 0 | 空 |

覆盖率结论：line ≥80% 达标（模块 100%，模块套件与全套件两口径一致），branch 同时报告（85.11%/85.71%，`plan.md:152` 裁决3 口径）。

## TDD 说明（如实）

- RED 阶段非本 ask 执行：前次会话按先测后码落盘（提交 `2e6dedb` 消息含「re-run tests-first gate against re-derived plan (RED re-verified)」可溯）。本 ask 在实现已在位的前提下复跑 GREEN（上方两表），无法也无意重放 RED。

## 未运行（如实声明，不冒充模块检查）

- `npm run test:unit`（§5.3 全量门禁，失败集合须等于 `plan.md:19-21` 的 7 条基线）与 `npm run verify:web`（§5.4）为流级 G6/终报门禁，属 obs-report/汇总步，本模块 ask 未运行。`npm ci` 在本机 rc=1（`plan.md:13` sherpa-onnx lock 缺失，批次一已登记），模块套件走 `node --test` 不受影响。
- Playwright 未启用（obs-provenance 无路由，`plan.md:150` 条件不触发）。

## 红线核对

- 文件归属：本模块仅涉及 `scripts/agentic/observability/provenance.mjs`、`tests/unit/agentic/observability/provenance.test.mjs`（前次提交落盘，本 ask 未改）与 `.s2d/impl-obs-provenance.md`（本记录，ask 明示）。
- 无新增依赖、无外部网络调用、无 `.env` 读取、无真实网关 key、未碰 Done-Go 主仓/classic/thinkpad/生产/LiteLLM、未改 W0 schema（只读守卫空输出）。
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化。
