# S2D-W6 impl · preview-routes（组4 · 模块9）

- 日期：2026-10-27 · 实现 actor：w6·实现·preview-routes（模型 GLM-5.3）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w6-preview` @ `feat/s2d-w6-preview`
- 基线：RED 测试 `d6858f3`（10 用例）；W0 冻结 `b9d9bdf` 为 HEAD 祖先；前序 G1–G3 五提交（store/discussion/confirm/parser/apply/timeline）已在链上
- 输入规格：`.s2d/plan.md` §3 模块9 + §2 负面路径 + `tests/unit/agentic/preview/routes.test.mjs` + BUILD-PLAN §2.1（路由不挂 serve-tango，`createXxxRoutes({db,auth,...})` → `(req,res,pathname)=>handled:boolean`）

## 产出文件（2）

| 文件 | 内容 |
|---|---|
| `scripts/agentic/preview/routes.mjs`（新增） | `createPreviewRoutes({db,auth,parsePatch,now})` → `(req,res,pathname)=>handled:boolean`；6 路由 + api-error 信封 + 注入式 auth/parsePatch/clock |
| `tests/unit/agentic/preview/routes.test.mjs`（追加 7 测） | 原 10 个 RED 用例零改动；追加默认依赖内核 / discussion 404-vs-空回放 / 未知字段与坏类型 / 超大 body / auth 抛错 INTERNAL / 空 missionId / 跨 owner versions 空列表 |

## 路由表（PRD §10.4 子集，本流所有权）

| 方法+路径 | 行为 | 成功响应 |
|---|---|---|
| `GET /api/missions/:id/preview` | 最新 live 版本（owner 过滤） | `{id,missionId,version,revision,preview,createdAt,updatedAt}` |
| `GET /api/missions/:id/preview/versions` | 整条不可变链 | `[{id,missionId,version,revision,createdAt,updatedAt}]`（轻量，不含 payload） |
| `GET /api/missions/:id/preview/timeline` | `projectTimeline(latest.preview, {previewId,revision,…})` — 冻结契约→W11 VM 的唯一接缝 | timeline VM（shots/tracks/narration.segments/samples/fallbacks/source） |
| `POST /api/missions/:id/discuss` | `applyPatch(...)` 全链（重放→门→解析→版本→消息+change record 同事务） | `{replayed, preview, message, changeRecord}` |
| `GET /api/missions/:id/discussion` | 线程回放 + 合同变更记录 | `{thread, messages, changeRecords}`；有 preview 无线程 → `{thread:null,messages:[],changeRecords:[]}` |
| `POST /api/missions/:id/confirm` | `confirmEntry.record(...)`（幂等键=owner+mission+version+actor+decision） | 确认记录（含 `event.type='contract-draft-request'`，仅存储不派发） |

SSE seam：模块头注释块声明 GET preview 的「SSE 分层渲染进度」升级点（PRD §10.4）——W6 只出持久化快照 JSON，渲染进度归 W11/W5，不进冻结契约。

## 设计锚点

1. **handled 同步判定**：`(method, path)` 表匹配即 `true`（含 method 不匹配→`false`，他人路径→`false`）；响应异步写。body 监听器在**首个 await 之前**同步挂上（`collectBody` 先缓冲后解析），避免 harness/真实服务下 `data`/`end` 事件先于 await 链丢失；GET 不消费该 promise 且挂了 detached `.catch` 防未处理拒绝。
2. **错误信封**：所有异常 → 冻结 `api-error.schema.json` `{error:{code,message,details?,requestId?}}`；`STATUS_BY_CODE` 映射全枚举（NEED_HUMAN→428、BUDGET_EXCEEDED→402 等），未知 code/裸 Error → `INTERNAL_ERROR` 500 且消息不外泄（requestId=randomUUID 供 W10 追踪）。`details` 仅在 `error.errors[]`/`error.currentVersion` 存在时携带（CONFLICT 带当前版本号）。
3. **认证 fail-closed**：`auth` 注入（sync/async 皆可）；返回 null/无 `ownerId` → 一律 401 `AUTH_REQUIRED`；`actor` 缺省回落 `ownerId`。未注入 `auth` → 全部 401（默认 `()=>null`）。
4. **不泄露存在性**：跨 owner 读经 store 的 owner 过滤 → 单资源 `NOT_FOUND`(404)、versions 列表 `[]`；discussion 无 preview 上下文时同样 `NOT_FOUND`（committed spec test 5 要求跨 owner discussion 404；与「无 preview 无讨论上下文」统一）。
5. **discuss 请求门**（顺序）：auth → body JSON 对象 → 字段 allow-list（`utterance`/`baseVersion`，未知键 400）→ `utterance` 类型 → `baseVersion` 缺省=当前 live 版本（非整数→400；无 live→404）→ `applyPatch`（重放/过期 409/解析 503/系统 wont 403 均由 G3 门禁，零半应用）。超长 utterance 由 apply 的 `MAX_UTTERANCE_LENGTH` 拒。
6. **body 上限**：64KB 流式计数，超过即刻 `CONTRACT_INVALID`（不再续读）；空 body/非对象/坏 JSON 同码。`reject(error)` 用预构建错误对象（GREEN 期修复：`reject(fail(...))` 中 `fail` 同步 throw 会逃逸进事件发射器、reject 永不调用 → await 挂起+uncaughtException）。
7. **missionId 门**：路径段空/超 200 字符 → 认领并 400 `CONTRACT_INVALID`（plan §2「missionId 为空」路径；`/api/missions//preview` 不静默 404）。不可解码 `%` 段 → 不认领。
8. **confirm 透传**：字段 allow-list（`previewVersion`/`decision`/`note`）后全部校验交 `confirm.mjs` 单一真源（坏 decision 400、未知/软删/跨 owner 版本 404、重放同 id+`replayed:true`）；`contract-draft-request` 事件仅落库（W3 接口），无任何派发/外部副作用。
9. **零外部副作用/零新增依赖**：默认 `parsePatch`=patch-parser 确定性规则内核（无 LLM、无 IO、无网络）；`now` 注入贯穿三 store；仅 node 内置（`crypto.randomUUID`）。

## 规格说明（无 committed-spec 修改）

原 10 个 RED 用例**零改动**全绿。追加测试中 2 处初稿缺陷在 GREEN 前修正（自建测试修正，非删测换绿）：
- `GET discussion` 语义按 committed test 5（跨 owner → 404）收敛为「无 live preview → NOT_FOUND；有 preview 无线程 → 200 空回放」；
- 一处 `res.res` 解构笔误。
GREEN 期实现修复 1 处（第 6 条 reject 缺陷），不影响任何断言。

## 门禁（本节点实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/preview/routes.test.mjs`（实现前） | 10/10 fail（ERR_MODULE_NOT_FOUND routes.mjs）；追加用例后复跑 17/17 fail |
| GREEN | 同上（实现后） | **17/17 pass**（10 原测 + 7 追加） |
| W6 全套 | `node --test --experimental-test-coverage "tests/unit/agentic/preview/*.test.mjs"` | **102/102 pass**；`routes.mjs line 95.28 / branch 84.21 / funcs 93.75`（≥80 达标；未覆盖=防御分支：details 合并、decodeSegment catch、writeHead 后错误守卫等）。全流文件均 ≥80% |
| 全量单测 | `npm run test:unit` | `# tests 1086 / # pass 1081 / # fail 3 / # skipped 2`；3 失败=**基线已知三例**（streamChat typed deltas / independent authenticated accounts / AI uses selected shared fields），无新增失败（前序节点为 3 基线+10 routes-RED，本节点吸收 10） |
| 语法/空白 | `node --check` ×2、`git diff --check` | rc=0 |

## 红线核对

- 文件归属：仅 `scripts/agentic/preview/routes.mjs`（新增）、`tests/unit/agentic/preview/routes.test.mjs`（追加）、本文件；未碰 contracts/、serve-tango.mjs、build-web.mjs、W0/W3/W4/W11 文件。
- 不挂载 serve-tango（BUILD-PLAN §2.1，W13 统一挂载）；W0 schema 零改写。
- 真实外部调用 0（无网关/模型/Codex；parsePatch 注入或确定性内核）；无新增依赖。
- P0→contracted：confirm 只记录决定与事件，不触发执行；讨论变更记录走 apply→discussion-store 同事务路径。
- 提交：`feat: preview-routes …` + `Co-Authored-By: ZCode`，flock 串行化，不推 main。
