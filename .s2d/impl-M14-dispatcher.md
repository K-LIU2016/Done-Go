# S2D-W13 · M14-dispatcher 实现记录（impl-M14-dispatcher.md）

- 模块：M14-dispatcher（组2/G2 集成件，plan.md §G2 行 98）
- actor：w13·实现·M14-dispatcher（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 交付物：`scripts/agentic/integration/dispatcher.mjs`（新文件，唯一实现件）

## 1. 实现内容

有序 prefix 路由复用器 `createAgenticDispatcher({ context, handlers, legacy?, maxBodyBytes?, requestId? })` → `{ handle(req,res,pathname) }`，挂载约定与 serve-tango 既有 `options.collaboration.handle` 先例同构（scripts/serve-tango.mjs:106-112 @60fdc73）：

1. **有序复用**：按注册顺序调 `handler(req,res,pathname,env)`，真值即 handled；全部未处理 → `legacy(req,res,pathname)`（body 未读、原样可用）；无 legacy → 返回 false 且不触碰响应。
2. **统一鉴权门**：每请求恰好一次 `context.auth(req)`（测试锁定 authCalls===1）；受保护路径未登录 → 401 AUTH_REQUIRED，不进任何 handler；`/api/agentic/health` 免鉴权（M17 public 路径），principal=null 仍传入 env。鉴权器抛错按未登录处理。
3. **统一 body 上限**：`env.readBody()` 惰性+缓存（多次读只解析一次）；超 `maxBodyBytes`（默认 1 MiB）→ 排空剩余后抛 413（信封 details.limitBytes）；坏 JSON → 400 CONTRACT_INVALID。
4. **冻结错误信封**：`ERROR_STATUS` 导出为冻结 README「错误码与 HTTP 建议」表（contracts/agentic/README.md:79-90）的唯一 JS 镜像，测试 deepEqual 锁定；信封 `{error:{code,message,details?,requestId?}}` 严格符合 api-error.schema.json（additionalProperties:false）；未枚举错误 → 500 INTERNAL_ERROR + 通用 message，绝不回显内部信息（测试锁定不泄露 key/模块路径）。
5. **SSE**：headers/frames 透传；已发 event-stream 头后失败 → 最后一帧携带冻结信封并 end，绝不补 [DONE]（headers 探测兼容真实 `res.getHeader()` 与测试 fake `res.headers`——补充组新增真实形状测试锁定）；客户端断开（res 'close' 且未写完 / req 'aborted'）→ `env.signal` abort + `context.events.emit({type:'client_disconnect', outcome:'UNKNOWN', ...})`，断开与 UNKNOWN 不吞（不监听 req 'close'，避免 body 读尽自动销毁误判）。
6. **无隐藏 wall clock**：时间戳仅 `context.clock.now()`；不读 key；无外部调用；requestId 来源=注入 generator 或 `context.idGen.next('req')`，生成失败不影响请求。

## 2. TDD 轨迹（本会话实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/integration/dispatcher.test.mjs` | rc=1，1 fail（ERR_MODULE_NOT_FOUND，文件加载即死） |
| GREEN | 同上（实现落地后） | rc=0，26/26 |
| 补强 | 同上（补充组 +12 用例后） | **rc=0，38/38** |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/dispatcher.test.mjs` | **line 100.00 / branch 95.45 / funcs 100.00**（均 ≥80%，M24 门槛预达标） |
| 目录回归 | `node --test tests/unit/agentic/integration/*.test.mjs` | 63 tests/55 pass/8 fail——fail 全为 M13(context)/M15(w1-adapter)/M16(projection)/M17(health)/M19(release-manifest×3)/M26(release-rollback) 缺实现的预期 RED，逐一确认 ERR_MODULE_NOT_FOUND/断言 RED；与基线 26/17/9 的差异仅 dispatcher 1 fail→38 pass，零回归 |

TAP 日志：`/tmp/m14-dispatcher-tap.log`、`/tmp/m14-integration-dir-tap.log`、`/tmp/m14-dispatcher-coverage.log`。

## 3. 测试基建修复（3 处，非放宽，逐条记录）

实现前文件加载即死（RED），实现后 4 fail 定位到**测试侧缺陷**（任何正确实现都无法通过）：

1. `dispatcher.test.mjs` makeDispatcher：`options.principal ?? OWNER_A` 把显式 `principal:null` 复活成 OWNER_A → 未登录 401 与 public-path 两场景不可达。修复为仅 `undefined` 时缺省（断言不变，场景从不可达变可达=增强）。
2. `_helpers.mjs` assertErrorEnvelope：无参调用时 `assert.equal(res.statusCode, undefined)` 恒败。修复为 `if (status !== undefined)` 才断言（与既有 code 参数同款守卫；显式传 status 的断言不变）。
3. `_helpers.mjs` fakeRes.writeHead：header 名未归一化（读 'content-type' 写 'Content-Type' 不匹配）。修复为按 node 语义小写归一化（12 流路由实测全部小写 'content-type' 写法）。

另有实现侧自查修复 1 处：sendError 的 SSE headers 探测原只读 `res.headers`（fake 专属）——真实 `http.ServerResponse` 无 `.headers` 属性，M21/M22 真服务器挂载时 SSE 错误帧路径不可达；改为 `res.getHeader?.()` 优先 + `.headers` 回退，并用真实形状（getHeader、无 .headers）测试锁定。

## 4. 域与红线核对

- 允许域：改动仅 `scripts/agentic/integration/dispatcher.mjs`（新）、`tests/unit/agentic/integration/dispatcher.test.mjs`（补强+1 处修复）、`tests/unit/agentic/integration/_helpers.mjs`（2 处修复）——全部在 plan §G2/允许域清单内；`git status --short` 实测无第 4 个路径。
- contracts/agentic：`git diff 60fdc73..HEAD --stat -- contracts/agentic` 0 行、工作树 0 改动、FROZEN=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓。
- 无迁移、无 serve-tango/build-web/web 改动（M18/M19/M20 各自模块）；无真实 gateway/Codex/media/email 调用；无 Playwright。
- W10 同步 auth 兼容：dispatcher 对 auth 结果 `await`，同步解析器（W10 要求）零额外微任务成本语义不变；principal 解析形状归 M13。

## 5. 遗留与移交

- 挂载归 M18（serve-tango `options.agentic`）；context 真实实现归 M13（本模块测试用 stubContext，形状已对齐）；M21 harness 将以真实 http.ServerResponse 复验 SSE/断开路径（本模块已加真实形状单测预锁）。
- PROVISIONAL/UNKNOWN：本模块无新增；`client_disconnect` 事件 outcome 恒 UNKNOWN（断开时外部副作用不可证明），由 W10 trace 汇与对账队列消费。
