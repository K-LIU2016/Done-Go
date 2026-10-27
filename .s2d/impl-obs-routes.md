# impl · obs-routes（G5 模块 11）

> worktree `/Users/chillbit/Proj/Done & Go/s2d/w10-observability` @ `feat/s2d-w10-observability`
> 基线 `60fdc73`（含 FROZEN `b9d9bdfa0511905a95b729753b82e5734adab6bb`）
> **本 ask（provenance 补齐重跑，2026-10-27，绑定模型 `b5c1cfc7-f526-421b-9f6d-010a794d37d7/glm-5.3`）**：
> 对照重派生 plan §4 #11 / §2.4 / §3 复审前一轮 `routes.mjs`（176 行，`61c78e4`）+ 15 测试，
> 发现 **1 处真实缺陷**（activity 双计数 + N9 缺失），按 TDD（先 RED 后 GREEN）修复：
> 19/19 全绿，line **100.00%** / branch **87.10%** / funcs 100.00%。

## 模块文件（plan §4 #11）

| 文件 | 归属 | 状态 |
|---|---|---|
| `scripts/agentic/observability/routes.mjs`（193 行） | scripts/agentic/observability/** | `61c78e4` 落地 176 行；本次修复 activity 计数 + SLA 闸门 → 193 行 |
| `tests/unit/agentic/observability/routes.test.mjs`（19 tests） | tests/unit/agentic/observability/** | 原 15（`61c78e4`）；本次 +4（3 个先 RED 验证失败，1 个补 malformed 路径） |

规格符合性（plan §4 #11 逐项，本会话实读复验）：
`createObservabilityRoutes({db,auth})` → `(req,res,pathname)=>handled`（routes.mjs:144-152 签名保持，
新增可选第三键 `activitySlaMs` 不破坏两键调用——test 19 钉死 arity 3 dispatcher）；
`GET /api/runs/:id/trace`（:183-188）、`/api/runs/:id/activity`（:189-191）、`GET /api/cache/stale`（:170-174）；
owner 过滤 + 非本 owner 与未知 run **字节相同** 404（N12，test 6/8 断言 `body` 全等）；
不挂 serve-tango——本会话 `grep -n observability scripts/serve-tango.mjs` 零命中 +
`git diff --stat 60fdc73 -- scripts/serve-tango.mjs scripts/build-web.mjs web/` 输出为空。

## 依赖契约（模块 5/7 输出形状，本会话实读）

- `spans.classifyOutcome({ownerId,runId,now,slaMs})`（spans.mjs:144-162）：返回
  `{spans:[{id,status,outcome,incomplete}], counts:{succeeded,failed,timed_out,incomplete,running}}`，
  其中 `incomplete`=全部未终态 span 总数、`running`=SLA 内、`timed_out`=超 SLA（N9/N10 语义）；
  `slaMs` 非有限非负或 `now` 不可解析 → `INVALID_ARGUMENT`；
- `spans.buildTree`（spans.mjs:115-134）：roots+orphans，孤儿 span 不从 trace 消失且显式列出；
- `store.listStaleCacheEntries(ownerId)`（store.mjs:368-372）：只取 `stale=1` 行——
  `EXPIRED_BUT_MATCHING`/`UNVERIFIABLE` 不入 stale 列表（模块 7 bucket 语义，见下「文档偏差 2」）。

## 复审发现的缺陷与修复（TDD）

### 缺陷：`activityCounts` 对同一未终态 span 双计数，且无法表达 N9 `timed_out`

前一轮 `activityCounts`（旧 routes.mjs:103-114）：非 `ok`/`error` 的 span 同时
`running+=1` **和** `incomplete+=1`——两个计数永远相等，读数者会得出「N 个在跑 + N 个不完整
= 2N 个未终态」而实际只有 N 个；且该端点完全没有 `timed_out` 通道（plan §3 N9
「计 timeout 并标 timed_out，不算失败也不算成功」在活动视图不可见）。而 obs-routes 的
**声明依赖模块 5**（plan §4 #11 依赖列「5,6,7,10」）已提供语义正确的
`classifyOutcome`，前一轮却用劣化副本绕开了依赖。

**修复**（新 `activityPayload`）：

- 活动视图计数**全部委托** `recorder.classifyOutcome`（`now`=请求墙钟，`slaMs`=挂载配置），
  与 metrics/bundle 消费方共享同一分类——`counts` 变为
  `{succeeded,failed,timed_out,incomplete,running}`，不变式 `running+timed_out===incomplete`
  有测试钉死（每个 span 恰落一桶，总数不重复计）；
- 每个 item 新增 `outcome` + `timedOut`（N9「标 timed_out」落到条目级）；
- 工厂新增可选 `activitySlaMs`（默认 `DEFAULT_ACTIVITY_SLA_MS=60_000`，与 spans/bundle
  测试套一致的单位值，显式导出、W13 可覆写）；非法值（负/NaN/字符串/null）在
  **挂载时**抛 `INVALID_ARGUMENT`（镜像 spans.mjs:145-146 的校验），不把坏配置拖到每请求。

### TDD 时间线（本会话实测）

1. **RED**：先写 3 测试（SLA 切分+不变式+条目标记 / 默认 SLA 生效 / 工厂拒非法 SLA），跑
   `node --experimental-strip-types --test tests/unit/agentic/observability/routes.test.mjs`
   → `# tests 18 / # pass 15 / # fail 3`——失败的恰为 3 个新测试（`not ok 10/11/12` 逐条核对），旧 15 条全绿；
2. **GREEN**：上述修复后同命令 → 18/18；
3. **补负面路径**：malformed 百分号编码路径（`/api/runs/%/trace`）落 `segments()` catch
   → 返回未处理而非 500（routes.mjs:69-71 原为覆盖空洞）→ 19/19。

## 覆盖的负面路径（plan §3，routes 侧）

- **N9** running 超 SLA → `timed_out` 桶 + 条目 `timedOut:true`，`succeeded`/`failed` 均为 0；
- **N10** 未终态 span → `incomplete` 总数（与 running/timed_out 为总-分关系，不双计）；
- **N12** 跨 owner trace/activity → 与未知 run 字节相同 404（不泄露存在性）；
- auth 抛异常/空 session → 统一 401，异常消息（含 token）不进 body；
- 非 GET / 非本流路径 / 空 id / 未知子路径 / malformed URI → `handled:false` 落回挂载方；
- `/api/cache/stale` owner 域内过滤（他人 stale 条目不可见）+ query string 容忍。

## 文档偏差（按 AGENTS.md：从现有代码，此处登记）

1. **PRD §10.4 写 `GET /api/runs/:id/activity` 为 SSE**；本实现返回 JSON 快照——
   plan-of-record §4 #11 定义的是无 http.Server 依赖的同步 dispatcher 工厂
   （`(req,res,pathname)=>handled`，W13 统一挂载时再定传输形态），SSE 属挂载层职责。
   若 CTO 裁决 activity 必须 SSE，改造点在 W13 挂载处（包一层事件流），本工厂的
   counts/items 语义不变。
2. **plan §2.3 字面公式 `modelSource==='unknown'` 计 stale**：模块 7（cache.mjs:90-100）
   将不可验证来源单列 `UNVERIFIABLE` 桶（`stale:null`）而非并入 stale，N8 的
   「mock 不得进端到端成功」由 bucket 语义保证。`/api/cache/stale` 因此只列真 stale 行；
   UNVERIFIABLE 行存在于 store（freshness 列）但不进该端点——沿模块 7 既有裁决，本模块不改写。
3. trace 端点的 `run`/`spans` 返回原始 snake_case 行（attributes_json 为字符串），
   与 activity/cache 的 camelCase 投影不一致——前一轮的既定选择，面向 owner/admin 调试
   保留原始列，未发现违反 plan 条款；如需统一投影留 W13 消费方反馈后处理。

## 验证（本会话实测，2026-10-27）

| 命令 | rc | 结果 |
|---|---:|---|
| `node --experimental-strip-types --test tests/unit/agentic/observability/routes.test.mjs`（RED 阶段） | 1 | `# tests 18 / # pass 15 / # fail 3`（恰为 3 个新测试） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/routes.test.mjs`（GREEN） | 0 | `# tests 19 / # pass 19 / # fail 0 / # skipped 0` |
| `node --experimental-strip-types --experimental-test-coverage --test tests/unit/agentic/observability/routes.test.mjs` | 0 | `routes.mjs` line **100.00%**、branch **87.10%**、funcs **100.00%**（≥80% line 门禁通过，branch 同步报告且亦达标） |
| `node --experimental-strip-types --test tests/unit/agentic/observability/*.test.mjs` | 0 | `# tests 275 / # pass 275 / # fail 0 / # skipped 0`（含兄弟 obs-matrix 未提交在途改动，共绿；计数 257→275 由本模块 +4 与兄弟 matrix 扩测共同贡献） |
| `npm run test:unit` | 1 | `# tests 1245 / # pass 1236 / # fail 7 / # skipped 2`——失败集合与 plan §0.1 **逐条全等**（metric-layout / design-system / streamChat / independent-accounts / AI-shared-fields / multi-clause-replay / voice-pipeline-gateway），不多不少 |
| `npm run verify:web` | 0 | `# tests 227 / # pass 227 / # fail 0`（本流未改 web/**，`node --check` 全过） |
| `git diff --stat 60fdc73 -- contracts/agentic scripts/agentic/contracts.mjs scripts/agentic/db/index.mjs scripts/serve-tango.mjs scripts/build-web.mjs web/` | 0 | 输出为空（只读守卫 + 未挂载守卫通过，N15） |

未用 Playwright（本模块无 e2e；工厂纯单测，无 http.Server 依赖），未占 17691–17699 端口段。

## 边界自查

- 本次提交仅 `routes.mjs`、`routes.test.mjs`、本记录；`git status` 中兄弟 obs-matrix 的
  `matrix.mjs`/`matrix.test.mjs` 在途改动**不属于本提交**（兄弟会话所有，分开提交）。
- 未触碰 contracts/agentic/**、contracts.mjs、db/index.mjs、serve-tango.mjs、build-web.mjs、
  web/**、他流目录、生产、密钥；`auth` 为注入函数，本模块不经手任何真实 key。
- 无新增依赖（node:* 与仓库内 ESM：store/spans/vocabulary 只读复用）。
- 未推 main、未 force、未 `--no-verify`；提交经 `flock /tmp/donego-s2d-w10-git.lock` 串行化。
