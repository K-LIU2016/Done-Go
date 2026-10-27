# S2D-W13 · M18-serve-mount 实现记录（impl-M18-serve-mount.md）

- 模块：M18-serve-mount（组3/G3 挂载与清单，plan.md §G3 行 104）
- actor：w13·实现·M18-serve-mount（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 交付物：`scripts/serve-tango.mjs`（注入 `options.agentic` 挂载分支 + 构造门）+ `tests/unit/agentic/integration/serve-mount.test.mjs`（新，14 用例）

## 1. 实现内容（scripts/serve-tango.mjs，两处改动）

1. **构造门**（createTangoServer 头部）：`options.agentic` 提供但 `.handle` 非函数 → 构造期抛错（接线错误在挂载前就炸，与 M13/M14/M17 构造哲学一致）。
2. **挂载分支**（置于 collaboration `/api/` 鉴权块**之前**、URL 解析之后）：
   - 只吃 `/api/agentic/` 前缀；`options.agentic` 缺省时分支完全不参与（legacy 逐字节不变）。
   - **origin 门与既有 API 分支同款**（collaboration.requestAllowed / allowedHosts+origin 匹配，:106-112 先例）——外方 Host / mismatched Origin → 403 origin-rejected。
   - `await options.agentic.handle(req,res,pathname)`：真值=已处理（响应已写完，立即返回）；**falsy=未处理 → 还原 `apiRequest=false` 后落回 legacy**（body 未读、响应未触碰，collaboration 鉴权/静态语义如同分支未运行——测试双服务器比对锁定 503/404 两种落回与不挂载时逐字节一致）。
   - 置于 collaboration 鉴权块之前的理由：dispatcher 的冻结错误信封（`{error:{code,...}}`）与 `/api/agentic/health` 免鉴权探活（M17/M26 release 检查）不得被 tango 扁平 401 抢答；同时避免双重鉴权（dispatcher 统一鉴权门每请求恰好一次 `context.auth`）。
   - 外层安全头（nosniff/CSP 等，:83-86 setHeader 先于分支）经 writeHead 合并保留——测试锁定。
   - **CLI 入口不自动装配**：真实 gateway/model 一律由 harness/release 显式注入，绝不因环境变量静默启用（红线 9）。

挂载约定（与 M14 返回形状 1:1）：`createTangoServer({ agentic: createAgenticDispatcher({...}) })`；路由注册表标签挂 `context.handlers`（M17 约定）。

## 2. TDD 轨迹（本会话实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/integration/serve-mount.test.mjs` | **rc=1，14 tests/3 pass/11 fail**（挂载组全 RED：mount 未实现→404/401-tango/no-throw；无配置组 3 例同时锁绿基线） |
| GREEN | 同上（实现落地后） | **rc=0，14/14** |
| 语法 | `node --check scripts/serve-tango.mjs` | rc=0 |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/serve-mount.test.mjs` | 测试文件 **line 100.00 / branch 86.79 / funcs 95.00**；serve-tango.mjs 单文件视角 line 50.36 / branch 60.42 / funcs 20.69（该文件主体由既有 tango-* 套件覆盖，见 §3；M24 做 aggregate 对账） |

TAP 日志：`/tmp/m18-serve-mount-red.log`、`/tmp/m18-serve-mount-green.log`、`/tmp/m18-serve-mount-final.log`、`/tmp/m18-coverage.log`。

**测试侧自纠 2 处（fixture 缺陷，非放宽）**：首版注册密码 36 字符撞 collaboration 8–15 字符策略（INVALID_PASSWORD）→ 改合规密码；origin-mismatch 用例漏发 Host 头（node 对无 Host 的 HTTP/1.1 直接 400，到不了 handler）→ 显式带合法 Host。两处均为测试自身 fixture 错误，断言语义不变。

## 3. 回归（本会话实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| serve-tango 全部引用方 | `node --test tests/unit/{tango-ai-server-guard,tango-ai-visitor-daily-limit,tango-assistant-routes,tango-collaboration-http,tango-email-entry,tango-r1-acceptance,tango-service,tango-release,tango-static-gzip}.test.mjs` | **37 tests/35 pass/2 fail**——2 fail = `tango-collaboration-http` 两条 INVALID_PASSWORD，**已证实预存基线**（W2/W6/W8 报告记载；W6 曾在 60fdc73 原始 worktree 复现同两例） |
| CLI spawn | `node --test tests/unit/auth-start-smoke.mjs` | rc=1（`/api/auth/register` INVALID_CODE）——**pathspec stash 仅回退本模块 serve-tango 改动后同 rc=1 复现 → 预存，非本模块回归**（该路径不触碰 /api/agentic/） |
| 集成目录 | `node --test tests/unit/agentic/integration/*.test.mjs` | 185 tests/184 pass/**1 fail**——fail=M26 release-rollback（release.mjs 未实现的预期 RED）；M19 三例已因并行模块落地转绿 |
| **verify:web（模块指定门禁）** | `npm run verify:web` | **rc=0，227/227**（含 `node --check scripts/serve-tango.mjs` 与 tango-release）——「无配置时 legacy 行为不变」以既有套件佐证 ✓ |
| 契约 | `git diff 60fdc73..HEAD --stat -- contracts/agentic`＝0 行；工作树 0 改动；`cat contracts/agentic/FROZEN`＝`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`；`git diff --check` OK | ✓ |

并行说明：G3 同组 M19（build-web/tango-release）在本会话期间完成并提交（9f87967）；本模块文件域与其零交叉，提交用 flock 串行化。

## 4. 测试矩阵（14 用例）

- A 无配置基线×2：裸服务器 agentic 路径 404；collaboration 下未登录 401 **tango 扁平信封**（锁定不被抢答的前提）。
- B 挂载接管×3：health 未登录 200 冻结体+generatedAt=注入时钟+nosniff 保留；collaboration 同挂时 health 仍 200（分支先于鉴权块）；受保护路径未登录 401 **冻结信封**（error 为对象）。
- C 落回 legacy×2：无 collaboration 未处理→裸 404（apiRequest 还原，非 503）；collaboration 同挂未处理→与不挂载服务器**同答 503**（双服务器比对）。
- D origin×2：外方 Host 403；合法 Host+恶意 Origin 403（真实 socket，node:http setHost:false）。
- E legacy 不受扰×1：/api/status 200、静态 / 200 html、collaboration 注册 200。
- F 真实 socket 过 dispatcher×3：POST body 经 env.readBody+principal 回显、未登录 401；maxBodyBytes=256 超限→413 信封 details.limitBytes；SSE 帧与 headers 原样透传（不注入 [DONE]）。
- G 构造门×1：`{}`/`{handle:'nope'}` 均 throws /agentic/。

端口全部 `listen(0)` 临时分配，不占 17701–17719 预算；无 Playwright、无外部调用、无真实 gateway/model。

## 5. 遗留与移交

- M21 harness 将经本 seam 挂载完整 dispatcher（fixture 登录→`context.auth` 适配 collaboration cookie 的桥接归 M13 auth 注入方）。
- M26 release 健康检查经 `/api/agentic/health` 探活：本模块已锁定「collaboration 同挂仍免鉴权 200」。
- PROVISIONAL/UNKNOWN：本模块无新增；预存基线失败（collaboration-http×2、auth-start-smoke、npm lock 缺口等）原样保留，归 M25 全量对账。
