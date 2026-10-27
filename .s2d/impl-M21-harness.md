# impl-M21-harness（G4 · 组4）

- 节点：M21-harness（plan.md §G4）· w13·实现·M21-harness · 模型 zai-api/GLM-5.3$max（工作流统一绑定）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`（基线 58e79e4，M20 之后）
- 交付：`tests/agentic/integration/harness.mjs`（787 行，实现）+ `tests/agentic/integration/harness.test.mjs`（571 行，24 用例）
- 允许域核对：两文件均在 `tests/agentic/integration/**`（红线 3）；工作树零其它改动（`git status --short` 实测仅这 2 个新增文件）；`contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` 未动。

## 交付面（对 plan.md §G4 逐项）

| plan 要求 | 落点（harness.mjs） |
|---|---|
| fixture 登录 | `FIXTURE_PRINCIPALS`（primary/secondary=不同 owner；device-a/device-b=同 owner 双设备，golden-6 前提）+ `createFixtureAuth`（x-fixture-token → principal{ownerId,actor,id,device}，同步，principal 自带 id 供 W1/W12 路由） |
| dispatcher 挂载 | `createGoldenHarness`：M13 `createIntegrationContext`（单 db/确定性 clock/idGen/events/traceSink/policyPort 缺省 deny-all fail-closed）→ M14 `createAgenticDispatcher`（health 先挂→场景 handlers→legacy 兜底，未处理且 legacy 不接 → 冻结 404 信封）→ 真实 `http.Server` 只绑 127.0.0.1 |
| 假模型 transport（W7 注入位） | `createFakeModelTransport`：可直接作 W7 modelCaller（`bindRuntimePorts.validateModelCaller` 只要求函数）；脚本队列、逐 run 台账；`successfulResultsFor`=ok&&model≠null 才计（resolved_model=NULL 永不变真实成功）、`retryCount`=attempt>1 |
| 假 checker（W9 注入位） | `createFakeCheckers`：dod/citation/command/injection 四 checker（kind 对齐 verifier/shape.mjs），默认 PASS/LOW，`script(name, checkOrFn)` 覆盖，全调用入台账 |
| 假 gateway（W8 注入位） | `createFakeGateway`：`send()` 全记录、脚本应答、耗尽回退确定性默认；纯内存零网络 |
| W12 vision mock | `createVisionMock`：忠实 `pipeline.start` 契约 `{done, attribution}`（perception/routes.mjs:199 实读）；emit card.created→card.upgraded；done 永不 reject；enqueueCard/setDone/setAttribution 脚本化 |
| 临时 SQLite | `mkdtemp` + `openAgenticDb`（经 M13 组合根，W0 `migrate()` 单 `_migrations` 台账，R-9）；`close()` 关 server+db+删临时目录 |
| 端口 17701–17709 | `HARNESS_PORT_RANGE` + `pickHarnessPort`：段内探测可绑（先 preferred 后顺延）；段外 preferred 拒绝；九口全占 → `no free port left`（绝不静默离段）；17711–17719 留给 release |
| SSE 收集器 | `createSseCollector`：事件流响应头即返回、帧增量解析；非事件流（JSON 401/文本）不误报为帧；`close()` 掐断 → dispatcher 记 `client_disconnect outcome=UNKNOWN`（断开不吞）。事件序列/HTTP 台账/最终状态 → `evidence()`，`evidenceDir` 时 close() 原子落盘 JSON |
| 执行层闸门（M15 接线） | `harness.adapt(dto, ownerKey)` → M15 `adaptW1DtoToBlock`（owner 取 fixture 会话）；ok → 进 `executionLayerBlocks()` + `block.execution_ready` 事件；缺字段 → `block.stays_in_sync_layer`（outcome=UNKNOWN+missing），不进执行层 |
| 场景扩展位（M22 用） | `options.handlers`（(req,res,pathname,env)=>handled）+ `options.legacy/policyPort/modelTransport/checkers/gateway/vision/maxBodyBytes/evidenceDir/port/principals/startIso`；`withJsonBody` 把 dispatcher `env.readBody` 桥成 `req.json()`（W3/W9 流路由形状） |

## TDD 记录（RED→GREEN，不删测试不放宽校验）

- RED（实现前，`node --test tests/agentic/integration/harness.test.mjs`）：`# tests 19 # pass 0 # fail 19`，全部 `ERR_MODULE_NOT_FOUND`（逐用例独立 RED：惰性 `load()` import 模式）。
- GREEN 过程修过 3 个实现/测试缺陷（全部记录在案）：
  1. SSE 收集器非事件流应答从不 resolve（外层 Promise 只在事件流分支 settle）→ 补 `settleOuter` 于 end/close/error；隔离探针 `/tmp/w13-sse-probe.mjs` 定位（"unauth status 401" 前挂死）。
  2. 副作用台账 `perform` 返回 `{status,effect}` 与测试直取 `effect.effectId` 不符 → 改为直接返回 effect（fence executor 语义不变）。
  3. 测试内 `assert.throws(/ms/i)` 不匹配 "milliseconds"；源码注释含 `Date.now()`/`process.env` 字面量触发自审 → 注释改写为中文描述（审计保持 `Date.now(`/无参 `new Date()`/`process.env`/`fetch(` 禁令；带参 `new Date(epochMs)` 为确定性换算，白名单）。
  4. 测试 SSE 探针同步 `return true` 会让 dispatcher 在 handle 返回后拆断开监听（`finally detach()`），丢 `client_disconnect` → 探针改为保持未决直到 abort（这正是 M14 SSE 语义下场景 handler 的正确写法，已写入测试注释）。
- GREEN：`# tests 24 # pass 24 # fail 0`（初版 19 用例 + 守卫/边界 5 用例）。

## 覆盖率（node --experimental-test-coverage，本模块）

```
#    harness.mjs | line 98.09 | branch 85.31 | func 96.43 | uncovered 648-649 654-655 660-668 737-738
```

未覆盖行为 server 请求路径的防御性 catch（URL 解析失败/auth 抛错/dispatcher 极端抛错收敛 500）与 db.close 容错——纯防御分支，不放宽。

## 周边套件影响（新鲜命令）

- `node --test tests/unit/agentic/integration/*.test.mjs` → `# tests 197 # pass 196 # fail 1`：唯一失败 `release-rollback.test.mjs`，直接运行实测 `ERR_MODULE_NOT_FOUND: scripts/agentic/integration/release.mjs` —— **fd6b129 RED-first 既有状态，归 M26-release**（我的工作树未动它）。
- `node --test tests/agentic/integration/*.test.mjs` → `# tests 31 # pass 24 # fail 7`：7 失败全部是 M22 `golden-scenarios.test.mjs`（场景 handler 未挂，404 no-handler）——依赖序正确（G5 依赖 G4）；失败模式已从「harness 缺失 ERR_MODULE_NOT_FOUND」推进为「harness 在位、场景语义待接」，未删/未放宽任何断言。

## 红线自守

- 源码自审测试锁定：禁 `Date.now(`、禁无参 `new Date()`、禁 `process.env`、禁 `fetch(`、禁 child_process；`listen(...)` 必须绑 `'127.0.0.1'`；HTTP 客户端只打 `hostname: url.hostname`（即 baseUrl=127.0.0.1）。
- 时间戳一律注入时钟：journal/事件/副作用 at 均来自 `clock.now()`；idGen 用 M13 缺省（时钟+序号，确定性）。
- 零真实外呼：模型/checker/gateway/vision/副作用全为内存假件；W4 fence 配对实测 A5 → `A5_NEVER_AUTOMATIC` + 零副作用。
- 端口纪律：只在 17701–17709 分配（段外拒绝、段尽抛错）；未触碰 17711–17719。

## 交接 M22

`createGoldenHarness({ scenario, handlers, ... })` 即 golden-scenarios.test.mjs 头部契约（port/baseUrl/as()/clock/events()/externalEffects()/modelTransport/adapt()/executionLayerBlocks()/close() 全部在位并经自测锁定）。场景语义（/api/blocks/sync 真路由挂载、/api/contracts·actions、/api/missions/:id/runs、/api/artifacts、/api/runs/:id/trace 等场景面）由 M22 经 `handlers` 注入；`withJsonBody` 供 req.json() 形状流路由搭桥。
