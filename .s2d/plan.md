# W5 前端 · 规划 DAG（s2d-w5-plan）

> 规划员生成 · 2026-10-26 · 只读规划，未改任何产品代码
> 依据：PRD.md v0.2（§3.2/§4/§5/§6.8.2/§10.3–10.6/§14–15）、BUILD-PLAN.md（§2 全局规则、§3 W5 小节、§4 模型绑定）、prototype.html（2026-10-26 19:04 版，653 行，唯一视觉/交互标准）、worktree 实况（基线 65efc27）。

## 0. 环境事实（本 ask 实测）

- `npm ci` **rc=1**：`Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`。根因：`package-lock.json` 的 `packages` 段缺 `node_modules/sherpa-onnx-win-arm64` 条目（有 win-ia32/win-x64，无 win-arm64，但 sherpa-onnx-node 的 optionalDependencies 引用了它）；npm 12.1.0 校验全部 optional 引用必须有条目 → EUSAGE。lock 最后改于 9a85b96（早于基线 65efc27），**基线固有缺陷，非本流引入**；worktree 对 package.json/package-lock.json 零改动。
- `npm ci --omit=optional` 同样 EUSAGE（校验先于 omit）。`bun install --frozen-lockfile` 也失败（bun.lock 同步失步，同一根因）。
- **可用安装路径（已验证）**：`npm install --no-save --no-package-lock` → node_modules 齐全（react/vite/@playwright/typescript/ws/sherpa-onnx-node+darwin-arm64 全在），`git status --porcelain` 0 行（不碰任何跟踪文件）。后续批次安装一律用此命令。
- **待 CTO 裁决**：lock 修复权不在 W5（§2.1 禁碰），建议 CTO 在基线补 lock 提交。
- `web/agentic/` 目前不存在（全新目录）；`tests/agentic/` 不存在；worktree `design/` 无 `schedule-to-delivery/`（截图时新建 `design/schedule-to-delivery/shots/w5/`）。
- 素材（只读复制源）：`Done-Go/design/schedule-to-delivery/assets/` 7 文件：bookshelf-done.jpg、illus-lesson.jpg、photo-craft.jpg、photo-whiteboard.jpg、scene-classroom-poster.jpg、scene-classroom.mp4、slide-qwen.jpg。
- 端口段 17621–17629；Playwright 全局锁 `flock -w 900 /tmp/donego-s2d-pw.lock`，同时 ≤2 spec 进程。
- 测试基建实况：`npm run test:unit` = scripts/test-unit.mjs **递归收集 tests/unit/**/*.test.mjs**；playwright.tango.config.ts 用 webServer（tests/helpers/email-server.mjs）+ desktop/mobile(390) 双 project + `reducedMotion:'reduce'`——W5 自建配置沿用此模式但端口/目录独立。tests/helpers/ 不归 W5，harness 一律放 tests/agentic/ui/。

## 1. 架构决策（全部可溯源）

1. **组件形态**：`web/agentic/ui/*.js` 原生 ES 模块，每个组件 `mount(el, props) → handle`，`handle.update(props)` 增量更新（BUILD-PLAN §3 W5.1；PRD §5.2 末"原型实测教训"——整块重绘会让按钮失效/为什么收起/字幕冲掉；prototype L328 `setHTML` 即此模式的样例）。
2. **纯核 + DOM 壳双层**：每组件拆「纯渲染函数（HTML string builder / 状态归约，node --test 可测，无 DOM）」+「mount/update/事件壳（浏览器）」。覆盖率 ≥80% 用 `node --test --experimental-test-coverage` 打在纯核上；DOM 行为用 Playwright 组件页测（BUILD-PLAN §3 W5.4 "jsdom-free：用 Playwright 组件页测"）。
3. **Kira 设计变量**：不改 web/index.html（§2.1 禁碰）；`web/agentic/agentic.css` 顶层重声明 index.html:24-50 同名 token（--bg/--surface/--k-create/--k-explore/--spring/--paper/--deep/--font-serif…）+ prototype 新增 token（--you/--ok/--warn/--bad/--add/--del/--chg）+ 深色两路（media query + `[data-theme]`）+ `prefers-reduced-motion` 全局降级 + 900/720/560px 断点（prototype L8-19/L44/L100/L184/L185 逐条对应）。
4. **fixtures 先行**：`web/agentic/ui/fixtures.js` 按 PRD §3.2 黄金场景 + §10.3 Preview JSON 字段名自建（W0 未冻结；§3 W5.2 明示"W0 交付前用 PRD 样例自建"）；字段名严格照 §10.3（shape.kind/blocks[].type、storyboard、narration、boundary、diff、samples[].layout/text/image/watermark、reel、scene.status）——收尾 merge W0 后加一致性测试（§2.2）。
5. **W11 接缝**：预演片播放器归 W5（§3 W5.1），W11 的 `web/agentic/reel/` 是合成运行时（data-start/duration/track 时间轴）。W5 播放器只吃 `shots[]`（fixtures 静态 HTML），并预留"检测 data 属性时间轴则按其驱动"的薄接口；接缝说明写进终报。
6. **测试 harness 自建**（§2.1：服务端路由不挂 serve-tango.mjs，测试用自建 harness）：`tests/agentic/ui/helpers/serve.mjs` 静态服务 `web/agentic/` 于 17621+；`tests/agentic/ui/playwright.config.ts`（desktop 1280 + mobile 390×844 双 project、reducedMotion 可切换、flock 由外层命令保证）。
7. **XSS 基线**：所有外部字符串经 `esc()`（prototype L329 模式，v3-panel.js 同款五实体版）；fixtures 里的样张 HTML 是受控白名单（figure/frame/wm 结构由代码生成，图片 URL 只允许 ui/assets/ 相对路径）。
8. **提交纪律**：`feat|test|fix: …` + `Co-Authored-By: ZCode`；不推 main 不 force；每模块 TDD（先 spec 后实现）。

## 2. 模块 DAG

> group 小的先做；同 group 可并行。依赖列明"需先完成"。

### Group 0 · 地基（串行最先）

**M01 ui-utils + agentic.css 设计变量层**
- files: `web/agentic/ui/utils.js`、`web/agentic/agentic.css`、（纯核测试）`tests/unit/agentic/ui/utils.test.mjs`*
- subtasks: esc 五实体转义；`setHTML(el, html)` 内容比对跳过重写（增量更新基石，prototype L328）；hm/time 工具（T/HM/pct，L244-247）；`on(el, sel, fn)` 事件委托；tokens：Kira 变量重声明 + prototype 扩展变量 + 深色双路 + reduced-motion 全局禁动画 + 900/720/560 断点 + :focus-visible/.sr；`h(tag, attrs, children)` 极简构建器（可选）
- 依赖：无
- \*归属待裁决见 §4-2

**M02 fixtures + 素材 + 测试 harness**
- files: `web/agentic/ui/fixtures.js`、`web/agentic/ui/assets/*`（从设计目录只读复制 7 文件）、`tests/agentic/ui/helpers/serve.mjs`、`tests/agentic/ui/playwright.config.ts`、`tests/agentic/ui/component.html`、`tests/agentic/ui/smoke.spec.ts`、`tests/unit/agentic/ui/fixtures.test.mjs`*
- subtasks: 黄金场景数据（5 blocks：r/c/f/b/s 对应 prototype L249-255；previews×2 态 patched/unpatched L260-294；boundaries+SYS_WONT L296-303；script 执行剧本 L306-322；storyEvents L415-418；narration L426-433；samples（cover/slide/img/route 四 kind）L354-364；needs n1/n2/n3；trace 文本 L493-504）——字段名对齐 PRD §10.3；serve.mjs：--port 参数、静态 web/agentic/、零依赖 http；playwright.config：desktop 1280×900 + mobile 390×844(isMobile/hasTouch)、timezone Asia/Shanghai、webServer 起 serve.mjs（17621）；component.html：`?c=<组件名>` 挂载单组件 + `window.__props` 注入；smoke spec：页面可达 + esc 注入安全冒烟
- 依赖：无（与 M01 并行）

### Group 1 · L0 骨架渲染器（纯核为主）

**M03 shape 渲染器 A：文本结构类**
- files: `web/agentic/ui/shape/registry.js`、`web/agentic/ui/shape/text-shapes.js`（outline/facts/caveat/table/cards）、`tests/unit/agentic/ui/shape-text.test.mjs`*、`tests/agentic/ui/shape-text.spec.ts`
- subtasks: 每类型 `render(block, ctx) → html`（纯函数）+ registry 注册；数据形状照 PRD §10.3 blocks[]；outline 支持 add/del/chg 差异类（prototype L396）；facts→dl.kv（L398）；caveat 带 ⚠（L404）；unknown type → 纯文本降级（PRD §10.3 末行）；node 测：每类型 2 fixture + 未知降级 + esc；Playwright 测挂载/更新不闪变
- 依赖：M01

**M04 shape 渲染器 B：富媒体/清单类**
- files: `web/agentic/ui/shape/rich-shapes.js`（checklist/timeline/slides/diffSummary/mapRoute/personCard/sample）、`tests/unit/agentic/ui/shape-rich.test.mjs`*、`tests/agentic/ui/shape-rich.spec.ts`
- subtasks: checklist（含完成态）；timeline（横向刻度 + 事件点）；slides 缩略（prototype .slide 结构 L147-151）；diffSummary（新增绿/删除线/变更黄，token --add/--del/--chg）；mapRoute（.route 结构 L159-161）；personCard；sample（一页样张，Markdown 子集：b/列表/段落，白名单标签）；同款双测
- 依赖：M01（与 M03 并行）

### Group 2 · 预演面（drawer 预演 tab 及其子件）

**M05 交付徽标 + 块卡列表**
- files: `web/agentic/ui/block-card.js`、`tests/agentic/ui/block-card.spec.ts`
- subtasks: 时间/标题/类型 chip/可交付度 chip(hi/mid)/「需要你 N」chip/状态 chip + 状态点（prep/live/need/ready/done + pulse 动画，prototype L58-64、L342-351）；kind 左边条色（--k-*）；选中态；PRD §5.1「交付徽标 = 类型图标 + 可交付度 + 状态点 + 需要你 N 角标」；reduced-motion 下点不闪
- 依赖：M01、M02

**M06 块抽屉壳（五标签 + 阶段条 + 移动底部抽屉）**
- files: `web/agentic/ui/drawer.js`、`tests/agentic/ui/drawer.spec.ts`
- subtasks: tabs role=tablist 键盘左右切换 + aria-selected（prototype L211-218、L533-536）；预演/边界/进行中/交付物/追踪五 section 显隐；stepper ①说②看③定④交 状态类 on/done（L331-337）；≤720px 底部抽屉（上滑把手、Esc 关）；mount(el,{block})/update 增量——切块不重建 tab 面板 DOM
- 依赖：M01、M02

**M07 预演四档进度 + 场景片异步卡**
- files: `web/agentic/ui/tiers.js`、`web/agentic/ui/scene-card.js`、`tests/agentic/ui/tiers.spec.ts`
- subtasks: tiers 形✓/样✓/动▶/真（off→go 按钮 / gen 生成中 / ok✓，prototype L373-377）——「动」按钮触发 reel 事件回调 onReel()；scene-card：off（不渲染）/queued/generating（进度条 .bar i width 过渡）/ready（16:9 video poster + controls + 「示意 · AI 生成」角标，L378-382、L162-164）；aria-live=polite 状态播报；PRD §5.2.1 四档语义 + D-9 默认关
- 依赖：M01、M02

**M08 样张画廊**
- files: `web/agentic/ui/gallery.js`、`tests/agentic/ui/gallery.spec.ts`
- subtasks: `mount(el,{samples})`；每样张 figure.samp>.frame（4:3）+ figcaption；kind=cover/slide/img/route 四模板（prototype L366-372：封面 meta+nums、幻灯片 txt+pic 双栏、纯图、路线）；统一右下「示意」水印 .wm（PRD §5.2.1 规则"所有生成画面右下角标示意"）；代码排版 vs 整页生成并列（c 块样例：slide 与 img 并排）；图片仅限 ui/assets/ 白名单；update 换样张不整绘
- 依赖：M01、M02、M03（sample shape 复用）

**M09 分镜轴 + 旁白控件**
- files: `web/agentic/ui/storyboard.js`、`tests/agentic/ui/storyboard.spec.ts`
- subtasks: rail：事件两行交错（i%2 定 top，clampX 8–92%，prototype L419-425）+ 播放头 .head + you 事件高亮；narr：▶ 听旁白/停 + .subtitle 字幕（L426-450）；speechSynthesis 有则逐句播（rate 1.1、onend 推进）、无则 2.4s 定时降级；播放中映射 map[i] 点亮对应事件；update(litIdx) 只动 class 不重绘；reduced-motion：无动画直接静态步进；W11 接缝：字幕行可由外部时间轴驱动（handle.setLine(i)）
- 依赖：M01、M02

**M10 讨论框 + 差异高亮**
- files: `web/agentic/ui/discuss.js`、`tests/agentic/ui/discuss.spec.ts`
- subtasks: 例句 chips（data-say）+ 输入行（Enter 提交，prototype L648）+「改」按钮；onSay(text) 回调；patchNote 结果区：`已按「…」更新：新增/删除/变更` + .add/.del/.chg 高亮（L452-459）+ aria-live=polite；输入值 esc；空输入忽略；更新后不丢焦点
- 依赖：M01、M02

### Group 3 · 边界/可观测面

**M11 边界卡与签约**
- files: `web/agentic/ui/boundaries.js`、`tests/agentic/ui/boundaries.spec.ts`
- subtasks: 四栏 bound（我会做/我不会做+SYS_WONT 系统默认禁止项（不可合同覆盖，PRD §8.1）/需要你/花费与上限；prototype L296-303、L461-469）；≤720px 四栏→2×2；签约按钮（primary，文案含块数）+ 已签约态（chip hi + hash 等宽字体 + 撤回 danger）+ onSign/onRevoke 回调；hash 显示 `sha256:…`；打扰策略脚注；键盘可达
- 依赖：M01、M02

**M12 活动流（可展开「为什么」）**
- files: `web/agentic/ui/activity-feed.js`、`tests/agentic/ui/activity-feed.spec.ts`
- subtasks: 顶部 cost 行（agent 组成/模型调用次数/状态，L471-476）；feed 条目 time+icon+text，有 why 用 `<details>` 原生展开（L118-122）；新条目 .rise 入场动画且只对最新一条；倒序渲染但 update 追加不重排旧行（增量约束）；max-height 360 滚动；未签约空态文案；reduced-motion 无 rise
- 依赖：M01、M02

**M13 验收页 + 追踪层**
- files: `web/agentic/ui/acceptance.js`、`web/agentic/ui/trace-view.js`、`tests/agentic/ui/acceptance.spec.ts`
- subtasks: 验收：artifact 标题/规模 + .evidence 证据区（引用核验/DoD 结果/来源）+ 接受(primary)/要求修改/拒绝 三操作 + 接受后 .gain「计入为你腾出的时间」（PRD §5.6、prototype L479-489）；onAccept({opinion}) 回调（要求修改带意见，保留旧版本语义）；追踪：等宽 pre span 树（invoke_agent/execute_tool/chat/donego.need，OTel GenAI 命名，L491-505、PRD §10.5）；纯文本可复制
- 依赖：M01、M02

**M14 「需要你」收件箱**
- files: `web/agentic/ui/inbox.js`、`tests/agentic/ui/inbox.spec.ts`
- subtasks: 顶栏铃铛按钮 + 计数 b 徽标（有未决才显示，L515-523）；面板 fixed 卡片（.inbox）：need 卡（标题/正文/所属块/截止时刻/超时默认/选项按钮组，L526 上下文 + L515-523）；onAnswer(needId, value) 回调；已处理态降透明度 +「已处理：…」；超时默认态（`超时 · 按默认`，L607）；aria-label；Esc/关闭钮；空态文案
- 依赖：M01、M02、M05（所属块标题查询可由 props 注入解耦→实际可与 M05 并行）

### Group 4 · 跨块面板

**M15 交付台泳道**
- files: `web/agentic/ui/board.js`、`tests/agentic/ui/board.spec.ts`
- subtasks: 纵轴块泳道 120px+track；seg 色类 r/w/v/u/d/g（L107-116）；块时间窗虚线框；nowline 当前时刻竖线（you 色）；时间轴刻度 13:00–19:00；toolbar：全部暂停（danger，未运行禁用）/速度 ×1×4/simState 文案（L222-231、L507-513）；onPauseAll/onSpeed 回调；50 块 60fps——update 只挪 seg/nowline 样式不重建行；移动端（≤560）纵向时间线降级（PRD §5.8）；pulse 类动画 rm 降级
- 依赖：M01、M02、M05

**M16 「📷 拍一下」入口 + 建议卡（快→深升级）**
- files: `web/agentic/ui/capture-card.js`、`tests/agentic/ui/capture-card.spec.ts`
- subtasks: 入行（标题「现场感知」+说明+📷 按钮，L383-392）；快卡：缩略图 + `即时 · <model> <t>` + 一句话 seen；深卡升级：同卡原地换态（边框转 --ok、`已升级 · <model> <t>`、change + 建议文本 + 动作组「⏱ 提醒/步骤卡跳步/记下来」，L386-390）；升级动画（aria-live=polite；rm 降级为直接切换）；动作回调 onAction(timer|step|note) → capNote ✓ 反馈；PRD §6.8.2 ContextDelta 字段（blockId/seen/change/risk/evidence）作为 props 形状；≤560 单列
- 依赖：M01、M02

**M17 预演片全屏播放器**
- files: `web/agentic/ui/reel-player.js`、`tests/agentic/ui/reel-player.spec.ts`
- subtasks: role=dialog aria-label「今日预演片」全屏遮罩（.reel L165-177）；16:9 stage；shots 轮播：opacity 过渡 + Ken Burns `kb` 7s 推近（仅 .on，L167-172）；字幕区 aria-live=polite（小标 at + 正文，L173-174）；顶部 3px 进度条；控制排：暂停/继续、重播、关闭（L176、L562-579）；Esc 关闭（L648）；旁白驱动：speechSynthesis 逐句、无 TTS 4.5s/句降级、9s 兜底 fin；「示意」水印；收尾自动变「重播」；W11 薄接缝：shots[].body 允许外部合成 HTML（含 data-start/duration 时优先按时间轴驱动——留 TODO 注释，不实现 W11 运行时）；rm：无 Ken Burns 无 opacity 过渡，直接切
- 依赖：M01、M02、M08（shot body 复用 sample 模板）

### Group 5 · 集成与门禁

**M18 demo.html 黄金场景**
- files: `web/agentic/demo.html`、`web/agentic/ui/app.js`（组装/状态机，仅 demo 用）
- subtasks: 引 agentic.css + 全组件；左块列表 + 右抽屉 + 交付台 + 收件箱 + 预演片入口 + 主题切换（data-theme）；模拟时钟剧本（script 数组驱动 status/feed/needs/超时默认，prototype L592-615 tick 逻辑）；阶段条 say→see→sign→run；讨论→patched 态切换（两套 preview 数据）；签约→hash→startSim；验收/要求修改闭环；全程增量渲染（setHTML）；`?speed=`/`?theme=`/`?block=` URL 参数便于测试与截图
- 依赖：G0–G4 全部

**M19 e2e 黄金场景 + a11y 规格**
- files: `tests/agentic/ui/golden.spec.ts`、`tests/agentic/ui/a11y.spec.ts`
- subtasks: golden：desktop 1280 + mobile 390 双 project 走完「说→看（讨论补丁→差异高亮）→签（hash 出现）→执行（feed 推进、need 弹出并作答、超时默认）→交付（接受/要求修改）」全链（PRD §3.2 黄金场景表逐行）；a11y：键盘走查（tab/arrow/Enter/Esc）、焦点可见、aria-live 播报（subtitle/patchNote/capcard/needs）、reduced-motion 下 computedStyle 无 animation、深色两路切换、拍一下快→深升级、reel 播放/Esc；全部走 flock 锁 + 17621 端口
- 依赖：M18

**M20 截图五组**
- files: `design/schedule-to-delivery/shots/w5/*`（worktree 内新目录）
- subtasks: 五组：A 预演（抽屉预演 tab：骨架+样张画廊+分镜+旁白）/ B 边界签约 / C 执行可观测（交付台+进行中活动流）/ D 需要你收件箱+拍一下卡 / E 预演片播放器+场景片卡；每组 × {1280×900, 390×844} × {浅,深}（data-theme 强制）+ 每组一张 reduced-motion 变体；Playwright screenshot 存 shots/w5/`<组>-<宽>-<主题>[-rm].png`；对照 prototype 供 CTO 视觉验收（§5 CTO 把关）
- 依赖：M18、M19

**M21 门禁 + 契约合并 + 终报**
- files: 报告 `/Users/chillbit/.claude-code-router/argus-cto/projects/donego/s2d-w5-report.md`
- subtasks: ①新增单测全绿 + 覆盖率 ≥80%（`node --test --experimental-test-coverage` 打 tests/unit/agentic/ui + 纯核模块清单）②`npm run test:unit` 除 3 个基线已知失败外零新增 ③`npm run verify:web` 全过 ④merge `feat/s2d-w0-contracts` → fixtures/字段一致性测试（W0 冻结晚则标注待 W0 不阻塞）⑤核对 §2.4.5 截图齐全 ⑥报告：分支 HEAD/门禁命令与退出码/覆盖率/外部调用 0 次/依赖申请（无新增运行时依赖）/未修项/给第 2·3 批接口说明（组件 props 契约表）/待裁决清单
- 依赖：M19、M20

## 3. 执行约束（每模块必守）

- TDD：先写失败 spec → 实现 → 绿；提交粒度=模块，`feat|test: w5(ui): <模块>` + `Co-Authored-By: ZCode`。
- 只新增 §2.1 四路径内文件；`git status` 出现越界路径即回退。
- Playwright 一律 `flock -w 900 /tmp/donego-s2d-pw.lock npx playwright test -c tests/agentic/ui/playwright.config.ts …`，端口 17621–17629，用完 kill PID。
- 安装用 `npm install --no-save --no-package-lock`（见 §0），绝不提交 lock 变更。
- 无外部真实调用（§2.3 本流配额为零）；密钥不涉及（纯前端 fixtures）。
- 组件 HTML 转义统一走 utils.esc；样张 HTML 白名单结构由代码生成。

## 4. 待 CTO 裁决（不停工，按推荐方案先做）

1. **基线 lock 损坏**：package-lock.json 缺 sherpa-onnx-win-arm64 条目、bun.lock 失步 → `npm ci`/`bun i --frozen-lockfile` 均失败。W5 无权改 lock。**已用 `npm install --no-save --no-package-lock` 顶上（已验证可用、零跟踪文件改动）**。建议 CTO 在集成分支修 lock；若其他流同样失败可统一此法。
2. **`tests/unit/agentic/ui/**` 归属**：BUILD-PLAN §2.3 L62 说单测放 `tests/unit/agentic/<流>/`（会被 test:unit 递归收集），但 §2.1 W5 行只列 `tests/agentic/ui/**`。**推荐**：按 §2.3 允许 W5 建 tests/unit/agentic/ui/（纯核 node 测试放这里，test:unit 自动收集）；若 CTO 不同意，改为 `node --test tests/agentic/ui/unit/` 自跑（test:unit 不收集，覆盖率命令单独执行，门禁 2 天然不涉）。本 DAG 文件清单按推荐方案标注（M01/M02/M03/M04 中带 * 号文件）。
3. **W0 冻结时点**：fixtures 按 PRD §10.3 自建先行；若本流收尾时 W0 未冻结，M21④ 一致性测试标注「待 W0」写入报告，不阻塞其余门禁（§2.5 遇待裁决不停工）。

## 5. 风险与对策

- **增量更新回归**（PRD §5.2 末明训）：每个 DOM 组件 spec 必含「update 后展开态/焦点/滚动位置不丢」断言；utils.setHTML 单测覆盖字节级跳过逻辑。
- **prototype 是 19:08 更新版**：以本次通读的 653 行版本为准（含四档进度/样张画廊/播放器/场景片卡/拍一下）；若 CTO 再更新，M18 前重读差异。
- **与 W11 播放器重叠**：接缝已定义（§1.5）；终报附 props 契约表供 W11/第 3 批对接。
- **移动端 390**：prototype 断点 900/720/560 全部落 agentic.css；mobile project 每组件至少 1 条布局断言。
- **npm run test:unit 收集范围**：若裁决 2 采推荐案，新增 tests/unit/agentic/ui 会进 test:unit——首模块落地后立刻全量跑一次确认不破坏门禁 2 基线（3 个已知失败外零新增）。
