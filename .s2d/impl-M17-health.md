# S2D-W13 · M17-health 实现记录（impl-M17-health.md）

- 模块：M17-health（组2/G2 集成件，plan.md §G2 行 101）
- actor：w13·实现·M17-health（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 交付物：`scripts/agentic/integration/health.mjs`（新文件，唯一实现件）+ `tests/unit/agentic/integration/health.test.mjs` 补强（+9 用例）

## 1. 实现内容

`createHealthHandler(context)` → `(req, res, pathname, env) => handled:boolean`（M14 dispatcher 挂载形状；非 GET 或非 `/api/agentic/health` → false 不触碰响应，落回后续 handler/legacy）：

1. **GET /api/agentic/health → 200**（application/json; charset=utf-8 + no-store）：
   - `status:'ok'`、`generatedAt`（组合根确定性时钟**单次调用**捕获——健康报告不引入第二个时间源）；
   - `db:{ ok, migrations }`——W0 单台账 `_migrations` **活探针**（请求时 `SELECT name FROM _migrations ORDER BY name`，非构造期快照）；行对象非字符串/空名过滤；
   - `routes`——`context.handlers` 注册表投影（字符串 prefix 原样、对象取 prefix/name、函数无稳定标签不入表）；
   - `upstreams`——在位性投影：白名单字段 `{ configured, endpoint? }`，其余字段（含任何 key 名）一律丢弃；endpoint 剥 query 后仍带 `sk-…` 形状则整值不报；
   - `container:{ ok, checks }`——六端口自检（clock/auth/idGen/events/traceSink/policyPort/db 形状逐项点名），任一缺失 fail-closed。
2. **任一子系统不健康 → 503 + 冻结信封** `UPSTREAM_UNAVAILABLE`（code 取自 M14 `ERROR_STATUS` 冻结枚举镜像），`details.subsystems` 只点名失败子系统名——**不回显原始异常文本**（防内部路径/栈泄露；broken db 测试锁定 sqlite 报错不外溢）。
3. **免鉴权**：handler 自身不校验 principal（M14 PUBLIC_PATHS 已放行本路径）；`auth()===null` 的 release 探活路径 200 可读（测试锁定）。
4. **构造期接线门**（挂载前就该炸，与 M13 构造哲学一致）：context 缺 auth 函数 / clock.now 函数 / db.prepare 函数 → `IntegrationHealthError` 拒绝创建。
5. **红线 4 自守**（源码审计实测，同 M13 context-seams 规则）：无 `Date.now(`/`new Date(`/环境变量读取/`fetch(`/网络或子进程 import——注释亦不用审计字符串字面量（首版注释含字面量触发自审，已改写）。

## 2. TDD 轨迹（本会话实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/integration/health.test.mjs` | rc=1（ERR_MODULE_NOT_FOUND，实现缺失，测试先行节点已立） |
| GREEN | 同上（实现落地后） | rc=0，**6/6**（RED 组 6 用例逐字未动） |
| 补强 | 同上（+9 补充用例） | **rc=0，15/15** |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/health.test.mjs` | **line 100.00 / branch 97.18 / funcs 100.00**（≥80% 门槛预达标） |
| 目录回归 | `node --test tests/unit/agentic/integration/*.test.mjs` | 169 tests/165 pass/**4 fail**——fail 全为 M19（release-manifest×3）+ M26（release-rollback×1）缺实现的预期 RED（与本模块合入前状态一致），零回归；本模块净变化=health 1 文件加载死→15 pass |
| 语法 | `node --check scripts/agentic/integration/health.mjs` | rc=0 |

TAP 日志：`/tmp/m17-health-tap.log`、`/tmp/m17-health-coverage.log`、`/tmp/m17-integration-dir-tap.log`。

## 3. 补充用例明细（只增强，不放宽；RED 组 6 用例逐字保留）

1. 注册表投影：字符串/空串/`{prefix}`/`{name}`/空标签对象/函数/null 逐形态 deepEqual 锁定。
2. 上游投影卫生学：query 剥离（`?token=sk-…`→裸端点保留）、路径内嵌 `sk-` 形状整值丢弃、非白名单字段（apiKey 名与值）不外溢、非对象配置→`{configured:false}`、空 endpoint 不报。
3. 非对象 upstreams 输入（null/数组/字符串/数字）→ `{}`。
4. 容器缺端口（删 traceSink+idGen）→ 503 + `details.subsystems` 精确点名（fail-closed）。
5. 时钟故障三形态（抛错/非字符串/空串）→ 503 点名 clock，且响应无 `generatedAt`（不可信时间不输出）。
6. 台账行过滤：空名/无名/null 行不入 migrations。
7. GET 异路径 → false 不触碰响应（dispatcher 顺序安全）。
8. 构造期四门（缺 context/auth/clock/db）逐一 assert.throws。
9. **组合互操作**：真实 M13 `createIntegrationContext`（:memory: db + 真迁移）+ 真实 M14 `createAgenticDispatcher` 挂载，未登录 GET 健康路径 → 200（真实 W0 台账可见、generatedAt=注入时钟、routes 来自 context.handlers、upstreams={}、container.ok）；同 dispatcher 受保护路径未登录仍 401（health 免鉴权不影响统一鉴权门）。

测试侧自纠 1 处（补充组内部，非放宽）：补 2 首版把「query 内嵌 token」误期望为整值丢弃——实际契约=query 剥离已消除泄露、整值丢弃只针对剥后仍含 `sk-` 形状者；用例改为双断言（`?token=sk-…`→裸端点保留 / 路径内嵌→丢弃）。补 9 首版误把注册表标签字符串混入 dispatcher handlers（字符串不可调用→500）；修正为 dispatcher 只收函数、标签挂 `context.handlers`（挂载方约定已在实现头注与测试注释固化）。

## 4. 域与红线核对

- 允许域：改动仅 `scripts/agentic/integration/health.mjs`（新）、`tests/unit/agentic/integration/health.test.mjs`（补强）、`.s2d/impl-M17-health.md`（本记录）——`git status --short` 实测无第 4 个路径。
- contracts/agentic：`git diff 60fdc73..HEAD --stat -- contracts/agentic` 0 行、工作树 0 改动、FROZEN=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓。
- 无迁移、无 serve-tango/build-web/web 改动（M18/M19/M20 各自模块）；无真实 gateway/Codex/media/email 调用；无 Playwright；无端口占用。
- 源码红线自审（实测脚本）：`{hasDateNow:false, hasNewDate:false, hasProcessEnv:false, hasFetchCall:false, hasNetImport:false}`。

## 5. 遗留与移交

- 真实挂载归 M18（serve-tango `options.agentic` 注入 dispatcher+health）与 M21 harness；M26 release 健康检查将经 `/api/agentic/health` 读 200/503——本模块已交付真实 M13+M14 组合互操作单测预锁。
- `context.handlers`（注册表标签）与 `context.upstreams`（在位性映射）为挂载方约定字段（M13 组合根不强制构造）；M18/M21 挂载时按测试同款约定填充，health 只做白名单投影不回显值。
- PROVISIONAL/UNKNOWN：本模块无新增；上游仅报在位性（configured 布尔），不试探连通——真实 gateway 连通性验证不在 W13 自动启用范围（需要真实调用者单独标 UNKNOWN+次数+限制）。
