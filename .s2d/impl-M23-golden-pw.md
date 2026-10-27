# S2D-W13 · M23-golden-pw 实现记录（impl-M23-golden-pw.md）

- 模块：M23-golden-pw（组5/G5 黄金场景，plan.md §G5 行 108；依赖 M21 harness 基座）
- actor：w13·实现·M23-golden-pw（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`（基线 2e58059=M21 修复轮后，兄弟节点 M22 并行在途）
- 交付物（全部新文件，零修改既有文件）：
  - `tests/agentic/integration/golden-release.test.mjs`（场景 8，2 用例）
  - `tests/agentic/integration/fixtures/golden-8-release.json`（期望值源；与 M22 的 fixtures/golden-scenarios.json 分文件，防并行 add/add）
  - `tests/agentic/integration/pw-server.mjs`（PW golden harness 服务）
  - `tests/agentic/integration/pw-golden.spec.ts`（最小 PW golden，2 用例）
  - `tests/agentic/integration/playwright.golden.config.ts`（自包含配置，17704）

## 1. 盘点结论（本会话实测，先于任何改动）

1. **页面/接缝面**：web/agentic/ 下 W1 sync.js+index.html 挂载（:851-876）、W5 demo.html（ui/app.js 装配，?speed= 任意正数快进，app.js:118-119）+component.html+21 个 ui 模块+7 素材、W11 reel 三件——M20 已证 index.html 透出 `tango:block-sync` CustomEvent（「M23 PW golden 可直接监听该事件」）。
2. **PW 先例**：W1 index-hook harness-server.mjs（fixture 登录 /api/auth/status|me + cookie + createBlockRoutes + 静态 web/，端口 17601-17609）；W5 config（helpers/serve.mjs 静态，17621-17629）；W13 段=17701-17719（M21 harness 17701-17709，release 17711-17719）。Playwright 1.64.1 + Chromium 缓存在位（node_modules 实测）。
3. **接缝链**：M20 web-seam A 组已证 attachBlockSync ↔ M14 ↔ M13 ↔ W1 routes（context.auth.forBlocks）；M18 serve-tango options.agentic 先例（:107-112）；M19 buildRelease 导出含 web/agentic/** + scripts/serve-tango.mjs + package.json。
4. **域切分**：M22=场景 1-7（golden-scenarios.test.mjs 在途 RED 7 条，兄弟节点）；M26=release.mjs 校验器（release-rollback.test.mjs 预留 RED，ERR_MODULE_NOT_FOUND）；本模块=场景 8 + 最小 PW golden，不碰两者。

## 2. 实现与 TDD 轨迹（本会话实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 场景 8 首跑（测试+fixture 落地，无配套实现） | `node --test tests/agentic/integration/golden-release.test.mjs` | rc=0，2/2 **即绿**——验收型锁定：被测 seam（M13/M14/M17/M18/M19）已在前序模块过门禁；如实记录无 RED，价值=把 §5.8 三断言钉成回归门（候选缺 web/agentic/health 断路/manifest 漂移/上一候选被改写即翻红）。证据 JSON（W13_GOLDEN_EVIDENCE_DIR）实测 86 文件 SHA 复算、17711/17712 四路 HTTP 200、rollbackVerified=true |
| PW RED | `flock -w 900 /tmp/donego-s2d-pw.lock npx playwright test -c tests/agentic/integration/playwright.golden.config.ts`（pw-server.mjs 未写） | `MODULE_NOT_FOUND …pw-server.mjs` → webServer exit 1，PLAYWRIGHT_RC=1 → evidence/s2d-w13-pw-golden-red.log |
| PW GREEN | 同命令 | `2 passed (11.3s)`（W1 sync 1.9s + W5 UI 8.8s），PLAYWRIGHT_RC=0 → s2d-w13-pw-golden-green.log |
| 目录对账 | `node --test tests/agentic/integration/*.test.mjs` | rc=1，35/28/7——7 失败全为 M22 golden-scenarios（兄弟在途，非本模块）；本模块 +2 全绿 |
| 单测对账 | `node --test tests/unit/agentic/integration/*.test.mjs` | rc=1，198/197/1——唯一失败=release-rollback（M26 预留 RED），零新增 |
| verify:web | `npm run verify:web` | rc=0（TA2 保持绿） |

GREEN 过程实现修正（未删测试未放宽断言，两处均实现侧）：
- pw-server 首版把所有路径送进 dispatcher → 静态 `/` 被 401（首导航无 cookie）；改为**仅 `/api/*` 进 dispatcher**（M18 serve-tango 同款前缀分流；静态免鉴权先载、API 侧 401 信封照旧）。烟测：`/`200 `/agentic/demo.html`200 `/agentic/sync.js`200 `/api/blocks` 无凭证 401/带 cookie 200。
- 端口段内顺延会使 config 静态探活 url 与实际监听口错位（静默超时）→ 改为被占即失败、`S2D_W13_PW_PORT` 显式换口重跑。

## 3. 设计取舍

- **场景 8 与 M26 分工**：本场景=临时目录 build 双候选+从候选树 import serve-tango 启动+健康探针+回滚回读（golden 验收口径，fixture 驱动）；M26=npm run build:web 全量门禁+release.mjs 校验器+release 健康编排。本模块不实现/不改 release.mjs。
- **PW golden=「最小」**：不复刻 W5 golden.spec.ts 的深链（need 弹窗/超时默认/追加修改轮/移动端，360s 级）；增量价值=同一批页面跑在 **W13 集成栈**上（M13 单一组合根/M14 统一鉴权门/M20 事件透出/临时 SQLite/确定性时钟），review 入口用零回调取消（不动 ready 态）保最小链路。
- **fixture 分文件**：golden-8 期望值独立 json，避免与并行 M22 的 golden-scenarios.json 产生 add/add 或编辑冲突。
- **测试密闭性**：golden-8 证据落盘走 `W13_GOLDEN_EVIDENCE_DIR` opt-in（默认不写库外路径）；pw-server 临时 SQLite 在 mkdtemp，SIGTERM/SIGINT/exit 三路清理。

## 4. 域与红线核对（本会话实测）

- 允许域：`git status --porcelain` 实测仅本模块 5 个新文件（tests/agentic/integration/**）；contracts/agentic delta=0，`FROZEN`=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`；`git diff --check` rc=0。
- 红线 4（统一 composition context）：PW golden 走 M13 组合根单一 db/auth/clock（注入式确定性时钟）；集成路径无第二 db/隐藏墙钟/读 key/外部调用（localhost harness 与 Playwright 为白名单例外）；PW 进程全程 `flock -w 900 /tmp/donego-s2d-pw.lock`（本会话 3 次 PW 级命令均持锁，≤2 进程约束满足）。
- 红线 8：本记录+证据明细落 evidence/（s2d-w13-golden-8.md、s2d-w13-pw-golden.md、TAP/JSON 日志、2 张辅助截图），ask 返回≤30 行摘要+路径。
- 红线 9：零真实 gateway/Codex/media/email 调用；无 UNKNOWN 需标（本模块无真实上游需求项）。
- 提交：`flock /tmp/donego-s2d-w13-git.lock git add <5 文件+本记录> && git commit`；不 push（M27 收口）。

## 5. 遗留与移交（进终报）

1. 根 `playwright.config.ts`（testDir ./tests、15s 超时、vite 5199）会收集 agentic 侧 **.spec.ts——W1/W5 合入起即如此（各套件以自带 `-c` 运行为约定，BUILD-PLAN §2.1），非本模块引入；裸 `npx playwright test` 对 agentic spec 不适用，属既有观察项。
2. golden-8 的「无 RED 即绿」性质已如实记录（验收型锁定）；M26 落 release.mjs 后 release-rollback.test.mjs 转绿，与本场景断言互补不重复。
3. W11 reel 播放深链浏览器用例仍归 W5/W11 套件；W13 侧仅证 reel 三件随候选发布（golden-8 prefixCounts reel/=3）与 demo 页 `[data-reel]` 入口在位（W5 spec 域）。
