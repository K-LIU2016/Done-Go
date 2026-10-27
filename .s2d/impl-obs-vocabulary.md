# obs-vocabulary（组1 · 模块1）实现记录

- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w10-observability`，分支 `feat/s2d-w10-observability`。
- 实现落点（前次会话整体提交 `61c78e4`）：本 ask 对该模块做规格核对 + 门禁复跑 + 本记录补档。本 ask 未改动任何 `.mjs`（工作树在写本文件前为 clean）。

## 交付文件

| 文件 | 行数 | 说明 |
|---|---:|---|
| `scripts/agentic/observability/vocabulary.mjs` | 217 | 实现 |
| `tests/unit/agentic/observability/vocabulary.test.mjs` | 183 | 单测（18 用例） |
| `.s2d/impl-obs-vocabulary.md` | 本文件 | 模块明细 |

## 规格核对（`.s2d/plan.md:130` 模块表行1）

职责五项逐一落位（cite 实现行号）：

1. attribute 键常量 → `vocabulary.mjs:38-54` `ATTRIBUTE_KEYS`（14 键，`gen_ai.`/`donego.` 命名空间；含 §2.1 投影列所需 requestModel/actorRole/actorModel/resolvedModel/modelSource/modelLocal，`plan.md:55` 要求键名常量集中、禁散落字面量）。
2. actor roles → `vocabulary.mjs:14-21` `ACTOR_ROLES`（BRIEF §3 六角色：conductor/block_agent/worker/verifier/reviewer/fixer，冻结顺序）。
3. UNKNOWN 哨兵 → `vocabulary.mjs:11`（字面 `'UNKNOWN'`，注释明确「绝不渲染为 0」，对齐 N6/§2.4）。
4. 模型来源枚举 → `vocabulary.mjs:27-28` `MODEL_SOURCES`（fixture/gateway/local/mock/unknown）+ `VERIFIABLE_MODEL_SOURCES`（仅 gateway/local；§2.2 规则4：mock/fixture 永不可验证）。
5. 错误码 → `vocabulary.mjs:81-92` `API_ERROR_CODES`（镜像冻结 W0 `api-error.schema.json`）+ `vocabulary.mjs:98-115` `OBS_ERROR_CODES`（15 个本流内部拒绝码，含 §2.2 的 `PROVENANCE_UNRESOLVED`/`RUN_NOT_VERIFIABLE` 与 §3 N5 的 `GATE_INCOMPLETE`）。
6. `normalizeActor` → `vocabulary.mjs:183-217`：role 必须在枚举内（否则 `ACTOR_ROLE_INVALID`）；model 缺失/空白 → `model=null` + provenance `UNKNOWN` + `unresolvedReason='MODEL_MISSING'`；第二参数 `_neighbour` 刻意忽略（§2.2 规则2 禁止从相邻 actor 继承）；`modelSource` 越枚举抛 `MODEL_SOURCE_INVALID` 不做猜测式归一。

附带公共件（供他模块消费）：`observabilityError()` `vocabulary.mjs:117-122`（coded Error）、`isNonEmptyString()` `:124-126`、`validateGate()` `:135-165`（N5：缺 stream/name/head/command 或 rc 非整数 → `GATE_INCOMPLETE`）。

W0 枚举防漂移：`SPAN_KINDS/SPAN_STATUSES/RUN_STATES/STEP_KINDS/STEP_STATES`（`:58-78`）由 `vocabulary.test.mjs:58-65` 对活体 schema 文件断言相等，`API_ERROR_CODES` 由 `:67-71` 断言——漂移即测试失败（§2.1「W0 只读消费」的测试面）。

## 覆盖的负面路径（`.s2d/plan.md` §3，本模块份内）

- N1（缺失 model）：`normalizeActor` 标 UNKNOWN（`vocabulary.test.mjs:113-131` 三态：缺失/空/纯空白）；`assertActorResolved` 的抛出归 obs-provenance 模块（其套件绿）。
- N5（gate 缺 command/rc）：`validateGate`（`vocabulary.mjs:135-165`），由 obs-gates 套件行覆盖（见下）。
- §2.2 规则4：mock actor 保持 RESOLVED 但 `verifiable=false`（`vocabulary.test.mjs:166-172`）；未知来源同样不可验证（`:174-182`）。
- 禁止继承：`vocabulary.test.mjs:133-140`。
- 角色非法/actor 非对象/modelSource 越枚举：`:142-164`。

## 检查（本 ask 内执行，均为实际命令）

| 命令（cwd=worktree） | rc | 结果 |
|---|---:|---|
| `node --experimental-test-coverage --test tests/unit/agentic/observability/vocabulary.test.mjs` | 0 | `# tests 18 / # pass 18 / # fail 0 / # skipped 0`；`vocabulary.mjs` line **85.25%** / branch 96.55% / funcs 60%；未覆盖行 125-126、136-165（`validateGate`，由 gates 套件覆盖） |
| `node --experimental-test-coverage --test tests/unit/agentic/observability/*.test.mjs`（`plan.md:146` §5.2 门禁原样） | 0 | `# tests 211 / # pass 211 / # fail 0 / # skipped 0`；`vocabulary.mjs` line **96.31%** / branch 93.33% / funcs 100%（未覆盖仅 137-138、157-162 防御分支）；本流全部 12 个 `.mjs` line 均 ≥93.74% |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs`（`plan.md:149` §5.5 只读守卫） | 0 | 输出为空（冻结面零改动） |

覆盖率结论：line ≥80% 达标（85.25% 模块套件口径 / 96.31% 全套件口径），branch 同时报告（`plan.md:162` 裁决3 口径）。

## TDD 说明（如实）

- RED 阶段非本 ask 执行：前次会话按先测后码落盘（提交 `61c78e4` 消息「TDD: 197-test RED suite written first, all modules implemented to 211/211 green」；文件 mtime：测试 08:36–08:45 早于实现 08:53–09:26）。本 ask 在实现已在位的前提下复跑 GREEN，无法也无意重放 RED。
- `.s2d/tests-red.md` 为 W0 流记录（内容为 contracts 套件），与本模块无关，未引用。

## 未运行（如实声明，不冒充模块检查）

- `npm run test:unit`（§5.3 全量门禁，失败集合须等于 `plan.md:16-29` 的 7 条基线）与 `npm run verify:web`（§5.4）为流级 G6/终报门禁，属 obs-report/汇总步，本模块 ask 未运行。
- Playwright 未启用（obs-vocabulary 无路由）。

## 红线核对

- 文件归属：仅 `scripts/agentic/observability/**`、`tests/unit/agentic/observability/**`、`.s2d/`（本记录，ask 明示）。
- 无新增依赖、无外部网络调用、无 `.env` 读取、无真实网关 key、未碰 Done-Go 主仓/classic/thinkpad/生产/LiteLLM。
- 未推 main、未 force、未 `--no-verify`。
