# obs-vocabulary（组1 · 模块1）实现记录

- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w10-observability`，分支 `feat/s2d-w10-observability`。
- 实现落点：前次会话整体提交 `61c78e4`；记录补档 `0d578c1`。
- **本轮（provenance 补齐重跑）**：plan 已由当前绑定模型在 `2e6dedb` 重新派生（同 12 模块 DAG、同 N1–N15），本 ask 按 `.s2d/plan.md:115` 重核规格并复跑门禁；本 ask 未改动任何 `.mjs`（写本文件前工作树 clean），仅更新本记录。

## 交付文件

| 文件 | 行数 | 说明 |
|---|---:|---|
| `scripts/agentic/observability/vocabulary.mjs` | 217 | 实现 |
| `tests/unit/agentic/observability/vocabulary.test.mjs` | 183 | 单测（18 用例） |
| `.s2d/impl-obs-vocabulary.md` | 本文件 | 模块明细 |

## 规格核对（`.s2d/plan.md:115` 模块表行1，对照重派生后 plan 逐项实读）

职责六项逐一落位（cite 实现行号，本 ask 内 Read 全文核对）：

1. attribute 键常量 → `vocabulary.mjs:38-54` `ATTRIBUTE_KEYS`（14 键，`gen_ai.`/`donego.` 命名空间；含 §2.1 投影列所需 requestModel/actorRole/actorModel/resolvedModel/modelSource/modelLocal，键名常量集中、无散落字面量）。
2. actor roles → `vocabulary.mjs:14-21` `ACTOR_ROLES`（BRIEF §3 六角色：conductor/block_agent/worker/verifier/reviewer/fixer，冻结顺序）。
3. UNKNOWN 哨兵 → `vocabulary.mjs:11`（字面 `'UNKNOWN'`，注释明确「Never rendered as 0」，对齐 N6/§2.4）。
4. 模型来源枚举 → `vocabulary.mjs:27-28` `MODEL_SOURCES`（fixture/gateway/local/mock/unknown）+ `VERIFIABLE_MODEL_SOURCES`（仅 gateway/local；§2.2 规则4：mock/fixture 永不可验证）。
5. 错误码 → `vocabulary.mjs:81-92` `API_ERROR_CODES`（镜像冻结 W0 `api-error.schema.json`）+ `vocabulary.mjs:98-115` `OBS_ERROR_CODES`（15 个内部拒绝码，含 §2.2 的 `PROVENANCE_UNRESOLVED`/`RUN_NOT_VERIFIABLE` 与 N5 的 `GATE_INCOMPLETE`）。
6. `normalizeActor` → `vocabulary.mjs:183-217`：role 必须在枚举内（否则 `ACTOR_ROLE_INVALID`）；model 缺失/空白 → `model=null` + provenance `UNKNOWN` + `unresolvedReason='MODEL_MISSING'`（N1）；第二参数 `_neighbour` 刻意忽略（§2.2 规则2 禁止从相邻 actor 继承）；`modelSource` 越枚举抛 `MODEL_SOURCE_INVALID`，不做猜测式归一。

附带公共件（供他模块消费）：`observabilityError()` `vocabulary.mjs:117-122`、`isNonEmptyString()` `:124-126`、`validateGate()` `:135-165`（N5：缺 stream/name/head/command 或 rc 非整数 → `GATE_INCOMPLETE`）。

W0 枚举防漂移：`SPAN_KINDS/SPAN_STATUSES/RUN_STATES/STEP_KINDS/STEP_STATES`（`:58-78`）由 `vocabulary.test.mjs:58-65` 对活体 schema 文件断言相等，`API_ERROR_CODES` 由 `:67-71` 断言——漂移即测试失败（W0 只读消费的测试面）。

## 覆盖的负面路径（`.s2d/plan.md` §3，本模块份内）

- N1（缺失 model）：`normalizeActor` 标 UNKNOWN（`vocabulary.test.mjs:113-131` 三态：缺失/空/纯空白）；`assertActorResolved` 抛出归 obs-provenance 模块（其套件本轮 235/235 内全绿）。
- N5（gate 缺 command/rc）：`validateGate`（`vocabulary.mjs:135-165`），由 obs-gates 套件行覆盖（全套件口径 `vocabulary.mjs` 未覆盖行仅剩 137-138、157-162 防御分支）。
- §2.2 规则4：mock actor 保持 RESOLVED 但 `verifiable=false`（`vocabulary.test.mjs:166-172`）；未知来源同样不可验证（`:174-182`）。
- 禁止继承：`vocabulary.test.mjs:133-140`。
- 角色非法/actor 非对象/modelSource 越枚举：`:142-164`。

## 检查（本 ask 内执行，cwd=worktree，均为实际命令）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-test-coverage --test tests/unit/agentic/observability/vocabulary.test.mjs` | 0 | `# tests 18 / # pass 18 / # fail 0 / # skipped 0`（41.7ms）；`vocabulary.mjs` line **85.25%** / branch 96.55% / funcs 60%；未覆盖行 125-126、136-165（`validateGate`，由 gates 套件覆盖） |
| `node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`（`.s2d/plan.md:131` §5.2 门禁原样） | 0 | `# tests 235 / # pass 235 / # fail 0 / # skipped 0`（计数经 `node --test … \| grep '^# …'` 复核）；`vocabulary.mjs` line **96.31%** / branch 93.33% / funcs 100%；本流全部 12 个 obs `.mjs` line 均 ≥96.09% |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs`（`.s2d/plan.md:134` §5.5 只读守卫） | 0 | 输出为空（冻结面零改动） |
| `git diff --name-only 60fdc73 HEAD \| grep -cvE '^(\.s2d/\|scripts/agentic/observability/\|scripts/agentic/db/migrations/obs-\|tests/unit/agentic/observability/)'` | 0 | 输出 `0`——分支全部 28 个改动文件都在 §2.1 归属内 |

覆盖率结论：line ≥80% 达标（85.25% 模块套件口径 / 96.31% 全套件口径），branch 同时报告（`.s2d/plan.md:146` 裁决3 口径）。

## TDD 说明（如实）

- RED 阶段非本 ask 执行：前次会话先测后码（文件 mtime：测试 08:36–08:45 早于实现 08:53–09:26）；本轮 tests 节点在 `2e6dedb`（本 ask 经 `git show 2e6dedb` 读到提交信息）对重派生 plan 重验 RED——12 个实现模块移开后 rc=1、0 pass/235 fail、全部 `ERR_MODULE_NOT_FOUND`——随后恢复复验 GREEN。本 ask 在实现已在位的前提下复跑 GREEN，无法也无意重放 RED。
- `.s2d/tests-red.md` 为 W0 流记录（内容为 contracts 套件），与本模块无关，未引用。

## 未运行（如实声明，不冒充模块检查）

- `npm run test:unit`（§5.3 全量门禁，失败集合须等于 §0.1 的 7 条基线）与 `npm run verify:web`（§5.4）为流级 G6/终报门禁，属 obs-report/汇总步，本模块 ask 未运行。
- Playwright 未启用（obs-vocabulary 无路由，无需 `/tmp/donego-s2d-pw.lock`）。

## 红线核对

- 文件归属：本 ask 仅写 `.s2d/impl-obs-vocabulary.md`；分支历史改动全部位于 `scripts/agentic/observability/**`、`scripts/agentic/db/migrations/obs-*.sql`、`tests/unit/agentic/observability/**`、`.s2d/`。
- 无新增依赖、无外部网络调用、无 `.env` 读取、无真实网关 key、未碰 Done-Go 主仓/classic/thinkpad/生产/LiteLLM。
- 未推 main、未 force、未 `--no-verify`。
