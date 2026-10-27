# S2D-W13 · M20-web-seam 实现记录（impl-M20-web-seam.md）

- 模块：M20-web-seam（组3/G3 挂载与清单，plan.md §G3 行 106）
- actor：w13·实现·M20-web-seam（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`（基线 6f06ea5=M18 后）
- 交付物：`web/index.html`（M，接缝块 +6/-1：`notifyBlockSyncEvent` 透出函数 + `onEvent` 接线）、`tests/unit/agentic/integration/web-seam.test.mjs`（新，12 用例）

## 1. 核对结论（全部本会话实测，先于任何改动）

1. **W1 已挂 sync.js ✓**：index.html:851-876（现状行号）闭环完整——`save()` 成功后 `notifyBlockSync()`（:849）、三处删除路径 `notifyBlockDelete`（replaceEntry :2650 / draft-del :3014 / del :3038）、`typeof window` 守卫 + `window.TangoCurrentUser` 登录门 + 免构建动态 `import('/agentic/sync.js')` + `.catch` 静默。W1 文本契约由 tests/unit/agentic/blocks/index-hook.test.mjs 锁定（不重复）。
2. **不覆盖旧页面脚本 ✓**：`git diff 60fdc73..HEAD -- web/index.html` = +31/−4，**4 处删除逐行核对全部是同行改造**（save/replaceEntry/draft-del/del 原语义保留、仅追加 notify 钩子）；基线 13 个 `<script src>` 集合与 HEAD 完全一致（`git show 60fdc73:web/index.html` 实取冻结清单，测试 C1 钉死）。
3. **不覆盖既有用户数据 ✓**：STORE_KEY='tango-donego.web.v1' / AGREEMENT_STORE_KEY 字面量不变且仅一处定义；损坏数据保护段（canWriteStorage/replaceWithSnapshot/「原始内容已受保护，禁止覆盖」）原样在位（测试 C2/C3 钉死）。
4. **W5/W11 经 demo/组件页 ✓**：web/agentic/demo.html（挂 ui/app.js，?speed=/?theme=/?block= 参数在 app.js:109-124 实测支持）与 component.html（16 个 ui 模块 + shape registry + fixtures）自足成页；两页引用图全部落盘（按页面目录解析，49 refs 实测零缺失）；不引用 legacy 脚本/存储键；index.html 不引用两页（隔离）。reel 三件（player.js/reel.css/README.md）在位——ui/reel-player.js:25 注释明确的 W11 薄接缝设计（合成运行时不直接被页面引用）。
5. **接缝链在 W13 集成栈上可通 ✓（本模块 A 组实证）**：真实 `attachBlockSync`（web/agentic/sync.js）↔ 临时 HTTP server ↔ M14 `createAgenticDispatcher` ↔ M13 `createIntegrationContext`（临时 sqlite + 确定性时钟 + cookie principal）↔ W1 `createBlockRoutes`（`context.auth.forBlocks` 形状接线）——拉取→上行→删除往返、游标推进、备份先行、统一鉴权门 401 冻结信封、W1 自身 x-tango-client 403 护栏全部生效。浏览器契约（相对路径 /api/blocks(/sync)、cookie 凭证）原样穿过。

## 2. 核对发现的缺口与最小修复（RED→GREEN）

**缺口**：index.html 接缝块 `onEvent: function () {}` noop——冲突/错误/serverChanges 事件在浏览器端被完全丢弃；W1 注释自认「冲突提示 UI 第 3 批（W13）接」，而 W13 plan 未把该半边接缝分配给任何模块。数据不覆盖已由同步引擎保证（W1 测试锁定），缺的是**可观察性**。

**修复（最小接缝，console-free、无 UI、不改存储语义）**：新增 `notifyBlockSyncEvent(event)`——`window.dispatchEvent(new CustomEvent('tango:block-sync', {detail:event}))`，无 window/无 dispatchEvent（tango-web-gaps vm 抽取先例）静默不抛；挂载配置 `onEvent: notifyBlockSyncEvent`。完整冲突提示 UI 仍不在 M20 范围（后续批），M23 PW golden 可直接监听该事件。

## 3. TDD 轨迹（本会话实测；RED 用例逐字未动）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/integration/web-seam.test.mjs` | rc=1，**9 pass / 3 fail**（B1/B2/B3=事件透出缺失；A 链路/C 基线/D 隔离先证绿） |
| GREEN | 同上（index.html 接缝落地后） | rc=0，**12/12** |
| W1 blocks 回归 | `node --test tests/unit/agentic/blocks/*.test.mjs` | rc=0，**50/50**（index-hook 文本契约不被本改动破坏） |
| web-gaps 回归 | `node --test tests/unit/tango-web-gaps.test.mjs` | rc=0，**16/16**（vm 抽取含新函数不炸，B3 行为级锁定） |
| 集成目录回归 | `node --test tests/unit/agentic/integration/*.test.mjs` | rc=1，197/196/**1**——唯一 fail=M26 release-rollback（release.mjs 未实现的预期 RED，M18/M19 记录在案），本模块 +12 零新增失败 |
| verify:web | `npm run verify:web` | **rc=0，227/227** |
| test:unit 全量 | `npm run test:unit` | rc=1，2701/2695/**4 fail**/2 skip——4 条与 M19 记录完全一致（M26 RED 文件 + streamChat typed deltas / independent authenticated accounts / AI uses selected shared fields 三条 BUILD-PLAN 明载基线），零新增 |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/web-seam.test.mjs` | rc=0 12/12；**web-seam.test.mjs line 100.00 / branch 89.29 / funcs 95.24**（≥80；index.html 为 HTML 不入 node 覆盖口径，新函数逻辑由 B2/B3 行为级三分支覆盖：透出/无 window/无 dispatchEvent） |

TAP 日志：/tmp/m20-verify-web.log、/tmp/m20-test-unit.log。

## 4. 设计取舍

- **不重复 W1/M14/M13/M19 已锁内容**：attachBlockSync 行为与 index.html 文本契约归 blocks/index-hook；dispatcher/context 形状归各自套件；发布清单归 tango-release。本文件只补四组增量：真实组合链路、事件透出、基线保留钉、W5/W11 隔离+引用图。
- **基线对照用冻结字面清单而非 git 依赖**：C1 的 13 个 script src 自 `git show 60fdc73:web/index.html` 实取后内联冻结——测试不依赖 git 存在（发布树可跑），语义等价于「一个不少、无新增 eager script」。
- **A 组 listen(0)**：沿 M18 先例，临时端口不占 17701–17719 预算；无 Playwright、无外部调用（仅 localhost）、无真实 gateway/model。
- **测试侧自纠 1 处（fixture 缺陷，非放宽）**：A 组 fetchImpl 首版漏 cookie jar（浏览器 credentials same-origin 语义），flush 401 静默排队导致游标不推进——scratch 阶段发现后改为逐请求附 cookie，断言语义不变（更真实地模拟浏览器）。

## 5. 域与红线核对（本会话实测）

- 允许域：改动仅 `web/index.html`（接缝块内）+ 新测试文件 + 本记录——`git status --short` 实测；serve-tango/build-web/contracts/其它流文件零触碰。
- contracts/agentic：基线以来 delta=0 文件、工作树 0 改动、`FROZEN`=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓；`git diff --check` rc=0。
- 确定性：A 组全部注入时钟（context tick 序列 + sync now 固定值）；无隐藏 wall clock、无第二 db（临时 sqlite 单实例）、无 key/外部调用。

## 6. 遗留与移交（进终报）

1. **serve-tango release 候选未接 `/api/blocks`**（M18 只转发 `/api/agentic/`）：bare serve-tango 下 `/api/blocks` 落 legacy（collaboration 扁平 401/503）→ 登录用户的浏览器同步静默 no-op（sync 是增益不阻断，本地数据无损）。**A 组已证明**：只要挂载方（M21 harness 自建 server / M26 release 装配）把 `/api/blocks` 送进 dispatcher，链路即通——是否扩 serve-tango 转发面归 M21/M26 决策（serve-tango 是 M18 模块文件，M20 不越界改）。
2. 完整冲突提示 UI（W1 注释「提示 UI」半边）：M20 只落事件透出；UI 归后续批。
3. serve-tango `types` 映射无 .mp4/.jpg（serve-tango.mjs:15）——W5 素材在 bare serve-tango 下以 octet-stream 下发（可播放性受浏览器影响）；归 M18/M26 观察项，非 M20 域。
