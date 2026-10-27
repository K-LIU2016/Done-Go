# S2D-W13 · M13-context 实现记录（impl-M13-context.md）

- 模块：M13-context（组2/G2 集成件，plan.md §G2 首项）
- actor：w13·实现·M13-context（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 实现基线 HEAD：`80939bc`（M14-dispatcher 并行落地后）；本模块提交前的 `git status --short` 仅含本模块三文件（context.mjs / context-seams.test.mjs / 本记录），零越域文件

## 1. 交付物

| 文件 | 域 | 说明 |
|---|---|---|
| `scripts/agentic/integration/context.mjs` | W13 允许域（integration/**） | 组合根：createIntegrationContext + adaptClockForRuntime + adaptPolicyPortForRuntime |
| `tests/unit/agentic/integration/context-seams.test.mjs` | W13 允许域（tests/unit/agentic/integration/**） | 补充规格测试 30 例（已提交 RED 主规格 context.test.mjs 12 例之外的新增接缝规格，RED 先行实测 ERR_MODULE_NOT_FOUND） |

**API（与已提交 RED 规格 `context.test.mjs`（fd6b129）逐条对齐）**：

- `createIntegrationContext({ db | dbFile, migrationsDir?, now, auth, idGen?, events?, policyPort?, policy?, ownerOfSpan? })`
  → `{ db, appliedMigrations, clock, idGen, events, traceSink, policyPort, auth }`
- **单一 db**：注入 db verbatim 复用（`context.db === db`）；或 `dbFile` 显式 `openAgenticDb` 打开；两者都给/都不给 → 拒绝构造（无隐藏 db）。migration 只走 W0 `migrate()` 单 `_migrations` 台账（R-9：不碰 W2 `_engine_migrations` 旁路），`appliedMigrations` 返回实际应用清单（预迁移库二次构造 = []，幂等实测）。
- **确定性 clock**：`now` 注入必需（缺省即抛）；构造期探测必须返回可解析 ISO-8601；`clock.now()`=ISO（W6/W9/W12/W4 形状）、`clock.nowMs()`=epoch ms（同一源 Date.parse 派生，W7/W8 形状）——一个时间源服务全部流形状，覆盖 W6/W8 缺省墙钟（R-8）。
- **auth 适配层**：单一同步 principal 解析器 → 四种冻结形状（plan §0.3 实测表）：本体可调用（M14 dispatcher 要求 `typeof context.auth === 'function'`，`dispatcher.mjs:97` 实读）+ `forBlocks`（W1 authenticate→principal.id）/`forPerception`（W12 auth.authenticate→{id}）/`forMission`（W3 auth.ownerId→string|undefined，未认证=undefined 锁定）/`forPreview`/`forBridge`/`forDelivery`/`forInbox`/`forObservability`（auth(req)→{ownerId}|null）。异步解析器构造期拒绝（AsyncFunction tag 检测）+ 运行期 thenable 守卫（响亮抛错，绝不静默当匿名）；解析器抛错=未认证（null/undefined）；W10 同步兼容锁定（`instanceof Promise === false` 断言）。
- **idGen**：注入（函数或 {next}）归一为 `{next(prefix?)}`；缺省 = clock+序号确定性生成器（唯一性断言）。
- **events sink**：注入 verbatim；缺省内置有序台账 `{emit(event), recorded()}`——emit 拒绝无 type 垃圾事件，recorded() 发副本。
- **traceSink → W10 store**：惰性 `createSpanRecorder(createObservabilityStore({db}))`（同一 db 投影，无第二实例）。契约形状 span 原样过 W0 span.schema.json 校验入 `obs_spans`（同 id 幂等、跨 owner SPAN_OWNER_MISMATCH 硬拒）；W7 引擎事件 span（`{type, runId, actor, recordedAt}`，engine.mjs:107-108/453/504/572 实读）映射为契约形状：run.started/resumed→`running`、run.finished succeeded→`ok`+endedAt、failed→`error`+endedAt、**paused/unknown→`running` 非终态 + attributes.runOutcome 保留**（W10 分类永不计成功，UNKNOWN 不吞不升级——红线 5/§4.6）。`record` 无 owner 绑定即抛（绝不无主落库）；`forOwner(ownerId, runId)` 产出 W7 spanSink 形状 `{record(span)}`。
- **policyPort**：注入 verbatim 优先；`policy: {resolvePolicyInput(ctx,action), phase?}` → W4 `evaluateAction` 桥（fail-closed）：allowed→`{allowed:true}`；needs_confirmation→`{allowed:false, need/reason:'A4_CONFIRMATION_REQUIRED'}`（A4 逐次确认，绝不自动放行）；blocked→`{allowed:false, reason:<W4 code>}`；**UNKNOWN→`{allowed:false, reason, unknown:true}`**（ACTOR_MODEL_UNKNOWN 等保留可见，进对账口径）；resolver 抛错/返回缺上下文→`POLICY_INPUT_RESOLVER_FAILED`/`CONTEXT_INVALID`（与 W4 自己的缺上下文判决同码，不伪造细因）；evaluateAction 抛错→`POLICY_EVALUATION_FAILED`。时间一律 context clock（决策随确定性时钟移动，WINDOW_OUTSIDE 用例锁定）。两者皆缺省 → deny-all 端口（check 永不 allowed，reason=POLICY_PORT_UNBOUND）。
- **runtime 适配导出**：`adaptClockForRuntime(clock)`→`{now()→epoch ms}`（过 W7 `validateClock`）；`adaptPolicyPortForRuntime(port)`→`{check}`（`allowed`→`allow` 映射，过 W7 `validatePolicyPort`/`readPolicyDecision`；port 抛错原样上抛交 W7 policyCheck fail-closed）。
- **红线 4 自审固化**：源码扫描测试锁定 context.mjs 无 `Date.now(`、无 `new Date(`、无 `process.env`、无 `fetch(`、无 node:http/https/net/dns/child_process import（context-seams.test.mjs 末例）。时间解析只用 `Date.parse`（纯解析）。

## 2. 新鲜门禁（本会话实测）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | RED 确认（实现前） | `node --test tests/unit/agentic/integration/context.test.mjs`（及 context-seams.test.mjs） | 双双 ERR_MODULE_NOT_FOUND → 1 fail（RED 保全，无测试删除/放宽） |
| 2 | 模块 targeted 全绿 | `node --test tests/unit/agentic/integration/context.test.mjs tests/unit/agentic/integration/context-seams.test.mjs` | **rc=0，42 tests / 42 pass / 0 fail**（主规格 12 + 补充规格 30） |
| 3 | 与 M14 并行模块联动 | `node --test tests/unit/agentic/integration/context*.test.mjs tests/unit/agentic/integration/dispatcher.test.mjs` | **rc=0，79/79**（真实 context 过 createAgenticDispatcher 鉴权门 401 信封端到端用例含内） |
| 4 | 模块覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/context*.test.mjs` | `context.mjs`：**line 94.44 / branch 87.50 / function 100.00**（≥80% 三维达标，M24 判据） |
| 5 | 全 integration 目录（本模块不污染他人 RED） | `node --test tests/unit/agentic/integration/*.test.mjs` | 104 tests / 97 pass / **7 fail = M15(w1-adapter)/M16(projection)/M17(health)/M19(release×3+rollback) 未实现的既定 RED**，与本模块前状态一致（M12 记录时点 9 fail 中 dispatcher 2 例已由 M14 转绿，context 0 例新增失败） |
| 6 | 语法 | `node --check scripts/agentic/integration/context.mjs` | rc=0 |
| 7 | FROZEN/契约零变化 | `git diff --name-only 60fdc73..HEAD -- contracts/agentic \| wc -l` + `git diff --name-only -- contracts/ \| wc -l` + `cat contracts/agentic/FROZEN` | 0 / 0 / `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓ |
| 8 | 白空格 | `git diff --check` | rc=0 |

## 3. 设计决策与依据

1. **db 注入而非自开为主路径**：RED 主规格（fd6b129，测试先行节点产出）以注入 db 为契约（`context.db === db` verbatim 断言）；`dbFile` 为组合根自营路径（openAgenticDb+migrate），两者互斥显式化。单台账由"构造即 migrate（幂等）"保证，而非依赖调用方自觉。
2. **auth 本体可调用 + forX 属性**：M14 dispatcher（80939bc，`dispatcher.mjs:97/171`）要求 `typeof context.auth === 'function'` 且 `await context.auth(req)`；主规格要求 `context.auth.forBlocks(req) === PRINCIPAL`（同引用 verbatim）。函数挂属性同时满足两侧，跨模块端到端用例（§2 #3）锁定。
3. **W7 事件 span→契约 span 的 UNKNOWN 语义**：span.schema.json status 枚举仅 running/ok/error 且 additionalProperties:false；run.finished 的 paused/unknown 无诚实枚举位 → 记 `running`（非终态，W10 `spanOutcome` 分类为 incomplete/timed_out，永不计成功）+ `attributes.runOutcome` 保留原始结局。这是"UNKNOWN 不吞、不升级为成功"（红线 5、brief §4.6）在 trace 维度的实现；failed→error / succeeded→ok 则按原语义闭合。
4. **policy 桥缺省 deny-all 而非缺省 W4**：W4 决策需要 mission/contract/grant 上下文，无 resolver 时任何"评估"都是伪造 → 缺省即 `POLICY_PORT_UNBOUND` 硬拒；提供 resolver 才接 evaluateAction（决策逻辑 100% 复用 W4，本模块零复制）。P0 缺省 phase（外部效果硬拒）。
5. **ownerOfSpan 可选解析器**：W7 spanSink.record(span) 不带 owner（engine.mjs:107-108 实读），跨 owner 场景由组合根注入 `ownerOfSpan(span)` 解析；无绑定无解析 → OWNER 硬错，绝不猜默认 owner（与 db/index.mjs "no hidden default owner" 立场一致）。

## 4. 未尽事项 / 交接

- `forPerception`/`forBlocks` 透传 principal 原对象：W1/W12 路由读 `user.id`，故服务这两流的 principal 解析器须自带 `id` 字段（已在 context.mjs JSDoc 注明）；M21 harness/M22 golden 组装时遵守。
- 跨流 policyInput 的真实 resolver（W3 mission + W2 grant 联查）归 M16-projection/M21-harness 组装域，本模块只交付桥与 fail-closed 语义。
- integration 目录尚余 7 例兄弟模块 RED（§2 #5），非本模块范围。
- 本记录与实现以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。证据明细：`argus-cto/projects/donego/evidence/s2d-w13-context.md`。
