# 探戈 Done&Go · AI 接力 v2 · UI/UX 定稿规格

定稿人：Claude（Done-Go CEO，JC 授权"你决定就行"）· 2026-10-24
定稿依据：JC 方向（AI 接力；与留白无任何交叠；面向没用过 AI 的人）、Kira 反馈（简单，所有人能用，复杂包在后面）。
原型：`design/relay-v2/prototype.html`（`?s=home|match|running|result|passport|discover|more|fail`）
截图：`design/relay-v2/shots/m-*.png`（手机 390 宽）、`d-home.png`、`d-result.png`（桌面 1280 宽）；总览：`relay-v2-board.png`

**实现必须与截图视觉一致**：间距、字号、颜色、圆角、文案都以原型为准。原型里没有覆盖的状态，按本规格补齐。

---

## 1. 产品原则（不可违背）

1. **一个问题开头**：首页只问"今天要做什么？"。首页和主流程不出现任何时间网格、时间预算、留白、优先级坐标或时间树。
2. **三步接力**：① 说清楚 → ② AI 先做 → ③ 你来接棒。每一屏顶部都有步骤条。
3. **不用会写提示词**：用户只说事、贴材料；提示词由系统按"用法"模板生成。
4. **AI 只给初稿**：结果统一标"AI 生成 · 请你核对"，可以编辑、复制、再来一版。
5. **省时由用户自评**：三档（😀省了不少 / 🙂省了一点 / 😐没省时间）。**禁止**显示模型估算的分钟数；relay 输出契约里删除 `estimatedSavedMinutes`。
6. **接力棒**：结果页和失败页都要提供"带着提示词去自己常用的 AI 里做一次"，并有"✓ 我自己做到了"按钮（记一次毕业）。
7. **访客优先**：不登录也能完成全流程，记录存在本设备；只在保存或跨设备时提示登录。
8. **发送前一句话隐私提示**（见原型 ②），只有点击主按钮才会发送。

## 2. 信息架构与路由

| 入口 | hash 路由 | 说明 |
|---|---|---|
| 开始 | `#/start`（默认，`#today` 和空 hash 都重定向到这里） | 首页 |
| 接力流程 | `#/relay` | 步骤 ①②③，以及失败态 |
| 我的用法 | `#/me` | 护照：统计、学会的用法、历史 |
| 发现 | `#/discover` | 按人群分类的场景卡 |
| 更多 | `#/more` | 账号、语言、外观、我们用了哪些 AI、隐私与数据、实验室 |
| 实验室 | `#/lab/today`、`#/lab/line`、`#/lab/review`、`#/lab/agreements` | **原有的旧页面原样保留在这里**，只从"更多 › 实验室"进入。旧的 `#line`、`#review`、`#agreements` 也重定向到对应的 `#/lab/*` |
| 账号相关 | 沿用现有 `#settings`、`#users`（管理员）、`#assistant` | 只从"更多"进入 |

- 手机（<900px）：底部三栏 tab（开始 / 我的用法 / 发现）；右上角"⋯"进入更多。
- 桌面（≥900px）：顶栏三个 tab；内容单列，最大宽 720px，居中。
- 顶栏右侧显示身份徽标：访客显示"访客"，登录后显示称呼首字。

## 3. 设计 token（定稿，实现必须使用同名 CSS 变量，并挂到新的 `web/relay/relay.css`）

```
--bg:#FAF8F3  --surface:#FFFFFF  --sunk:#F3F0E8  --ink:#252722  --ink2:#64665D  --ink3:#8E9086  --line:#E4E2D8
--brand:#E95432  --brand-soft:#FDECE6  --forest:#335D4B  --forest-soft:#E7F0EA  --gold:#E8B04B  --gold-soft:#FBF1DC
--ok:#2F7D57  --warn:#B7791F  --err:#B4432F
--r-lg:20px --r-md:14px --r-sm:10px  --shadow:0 1px 2px rgba(37,39,34,.05),0 8px 24px rgba(37,39,34,.06)
字号：hero 28 / h2 20–22 / body 16 / sm 14 / xs 12；最小点击区 48px
```
五种外观主题要映射到这组 token（`[data-appearance]` 下重定义同名变量）；designer 主题是深色，需保证对比度 ≥ 4.5:1。

## 4. 界面规格

### ① 开始 `#/start`
- 问候语（按本地时间）→ H1"今天要做什么？" → 副文案"说一件手头的事，探戈帮你交给合适的 AI。"
- 输入条：单行（手机）/ 自动增高（桌面）+ 🎤（复用 `speech-capture.js`，不可用时隐藏）+ "开始 →"。回车等同点击。空输入时按钮置灰。
- 人群切换：学生 / 老师 / 上班族 / 长辈（记住选择；首次默认"学生"）。
- 场景卡 6 张（2 列；桌面 3 列），来自场景库里当前人群 `featured=true` 的条目；点击后带着预填的事件和用法进入 `#/relay`。
- "我学会的用法"：最多 3 个徽章，右侧"全部"进入 `#/me`；没有时显示空状态文案"完成第一次接力，这里会出现你学会的第一个用法"。

### ② 说清楚（`#/relay` step=1）
- 返回"‹ 换一件事"。卡片依次为：
  - kicker"这件事适合交给 AI"；
  - "你说的是：<事件原话>"；
  - 用法标题（例如"整理会议纪要"）；
  - "AI 会先做"三个绿色标签（来自用法的 `does[]`）；
  - 材料输入框：label 来自 `materialLabel`，placeholder 来自 `materialHint`；工具"说给我听"和"从剪贴板粘贴"；
  - 隐私一句话；
  - 主按钮"让 AI 先做一版"；
  - "不太对？换成 <备选用法1> 或 <备选用法2>"。
- 匹配置信度低（<0.5）时，标题改为"你想让 AI 帮哪一种？"，并列出 3 个用法供用户选择。
- 材料最多 8000 字，超过时提示"太长了，先贴最重要的一段"；为空时主按钮置灰。

### ③ AI 先做（流式）
- 顶部"● AI 正在整理…"和计时"已用 N 秒"；正文逐段出现；骨架行；按钮"先停一下"（中止请求并回到 ②，材料保留）。
- 下方说明："一般 5–15 秒。你的内容都留着，随时可以停。"
- 超过 20 秒时追加文案："它想得有点久，再等一下或换到下面的'自己接力'"，同时显示接力棒的入口。

### ④ 结果与接力棒
- 结果卡：标题"AI 先做好的一版" + 标签"AI 生成 · 请你核对"；按 `sections[]` 渲染小标题和有序列表；`contenteditable`，编辑结果参与保存。
- 按钮：复制（复制纯文本）、直接改、再来一版；微调 chips 为"更短一点 / 更正式 / 加上时间"，点 chip 会带上该要求重新生成。
- "这次帮上忙了吗？"三档自评（必选一次才算这次接力完成，未选不阻止离开）。
- "你学会了"金色卡（来自 `learned`）。
- 接力棒卡（黑边框）：
  - 应用选择：豆包（默认）· DeepSeek · 通义千问 · Kimi · 元宝；"更多"展开海外 ChatGPT · Claude · Gemini；
  - 提示词预览（虚线框，带复制按钮），内容为用法模板加上用户材料的前 200 字；
  - 主按钮"复制并打开 <应用名>"：先复制，再新标签打开官方入口；
  - 文字按钮"✓ 我自己做到了"：记一次毕业，然后跳到 `#/me` 并高亮这个用法。
- 访客显示提示条："已存到这台设备。登录后换手机也能看到。[登录]"

### ⑤ 我的用法 `#/me`
- 三个统计：学会的用法 / AI 接力次数 / 自己做到的次数（第三个用绿色）。
- 学会的用法卡片（2 列）：已毕业的用金色奖章，否则用绿色；卡片上写"接力 N 次 · 自己做到 M 次"，并有"再做一次 →"或"去试一次 →"。
- 最近记录：自评 emoji、事件、日期和用法，已毕业的打"自己做到"标签。点开可查看当时的结果（只读）并复制。
- 底部"导出我的记录（JSON）"。

### ⑥ 发现 `#/discover`
- 人群切换同首页；按分类分组（写 / 读 / 整理 / 计划 / 翻译 / 生活）显示场景卡；点击后进入 ②。

### ⑦ 更多 `#/more`
- 分组一：账号（访客显示"去登录"）/ 语言 / 外观。
- 分组二：我们用了哪些 AI（说明使用网关 `auto`，以及外部应用清单和官方出处）/ 隐私与数据（导出、删除本机记录）。
- 实验室：时间记录与回顾、约定与小组（标"旧版"）。

### ⑧ 失败态（同处于 `#/relay`）
- 左侧橙色边条卡片，标题"AI 这次没接上"。原因按类型给出：
  - 未配置："AI 暂时没开，先自己接力试试"
  - 超时："它想得太久了（超过 60 秒）"
  - 限流："今天的体验次数用完了，明天再来"
  - 上游失败："AI 服务这会儿忙"
  - 格式错误："AI 回答乱了，再试一次"
- 均附"不是你的问题"和"✓ 你填的内容都还在"；主按钮"再试一次"（限流时不显示）。
- 下方一定有接力棒卡："不想等？自己接力"，内容为复制提示词并打开豆包。

## 5. 数据与接口契约

### 5.1 场景 / 用法库 `web/relay/scenes.zh.json`
```json
{ "version": 1, "usages": [ {
  "id": "meeting-notes", "title": "整理会议纪要", "category": "整理",
  "does": ["列出重点", "拆出待办和负责人", "标出没说清的地方"],
  "materialLabel": "把会议内容给我", "materialHint": "把聊天记录、笔记或转写文字粘贴到这里……",
  "learned": "把会议材料交给 AI，先要「重点、待办、没说清的地方」。",
  "externalPrompt": "请把下面的会议内容整理成三部分：1. 会议重点；2. 待办（写清负责人）；3. 没说清、需要追问的地方。只根据内容整理，不要补充没提到的信息。\n会议内容：{{material}}",
  "keywords": ["会议","开会","纪要","组会","周会","例会","录音"],
  "personas": { "student": {"featured": true, "title": "整理组会纪要", "hint": "重点、待办、待补充"}, "worker": {"featured": true} }
} ] }
```
- 至少 **48 个场景**：4 个人群 × 12 个，每个人群 6 个 featured。用法可以跨人群复用。
- 内容要求：白话、具体、不夸大、不承诺省时；长辈人群的文案更短、字更大。

### 5.2 外部 AI 应用 `web/relay/external-apps.js`
`[{id, name, initial, color, url, region:'cn'|'global', note}]`。国内 5 家：豆包 `https://www.doubao.com/chat/`、DeepSeek `https://chat.deepseek.com/`、通义千问 `https://www.qianwen.com/`、Kimi `https://www.kimi.com/`、元宝 `https://yuanbao.tencent.com/`。海外 3 家：ChatGPT、Claude、Gemini 的官方网址。
**每个 URL 都要实际打开核对**，并写入 `verifiedAt`。

### 5.3 relay 输出契约（服务端 `scripts/ai-assistant.mjs`）
```json
{ "sections": [ {"title": "会议重点", "items": ["…", "…"]} ], "learned": "一句话", "followups": ["更短一点", "更正式", "加上时间"] }
```
- 删除 `estimatedSavedMinutes`。`sections` 为 1–5 组、每组 ≤10 条、每条 ≤300 字；超限截断。
- 新增 **`stream:true` 支持**：边生成边渲染，最后一帧做完整校验。
- 请求体：`{mode:'relay', stream:true, prompt}`。prompt 由客户端按用法模板组装，事件和材料放在不可信标签里（沿用现有的防注入写法）。
- 新增 `mode:'route'`（light 档）：输入事件文本，输出 `{usageId, confidence, alternatives:[usageId,usageId]}`，只能从场景库的 id 中选。

### 5.4 本地记录 `tango-donego.relay.v2`（必须纳入 `TangoAccountStorage` 账号作用域）
```json
{ "v": 2, "records": [ { "id": "uuid", "at": "ISO", "event": "原话", "usageId": "meeting-notes",
  "result": "用户编辑后的纯文本", "rating": "much|little|none|null", "graduated": false, "graduatedApp": null,
  "failed": null } ] }
```
- 最多 200 条；在 `ai-relay.v1` 存在时做一次迁移（`estimatedSavedMinutes` 丢弃，rating 设为 null）。
- 未知版本时不覆盖，放进隔离区并提示用户。

### 5.5 漏斗计数 `POST /api/metrics`（只计数，不带任何内容）
事件名：`start_submit`、`scene_click`、`match_shown`、`match_switch`、`relay_send`、`relay_ok`、`relay_fail:<type>`、`stop`、`rate:<much|little|none>`、`baton_copy:<app>`、`graduated:<app>`、`signup_nudge_click`。
服务端按天和事件名做内存计数加每日落盘 JSON；不记录用户 ID、IP 或文本。管理员可以通过 `GET /api/metrics?day=` 查看。

## 6. 非功能
- **性能**：首页首屏新增 JS ≤ 60KB；relay 首字 ≤ 3 秒、p95 总时长 ≤ 15 秒（前提是 light/standard 档切到快速模型，见 §7）；场景库按需加载。
- **无障碍**：所有按钮有可读名称；键盘可走完全流程；焦点可见；`prefers-reduced-motion` 时关闭动画。
- **移动端**：微信内置浏览器（iOS/Android）可以完成全流程；剪贴板读取失败时降级为提示"长按粘贴"。
- **多语言**：新增文案集中放在 `web/relay/i18n.js`，先做 zh 和 en，其余语言回退到 en；阿拉伯语从右到左时布局不能乱。
- **主题**：五种外观都不能破版。

## 7. 依赖与环境
- 快速模型：donego key 当前只允许 `auto`。JC 授权给 key 加快速模型后，light 和 standard 档改用快速模型（通过环境变量配置，不写死在代码里）。在此之前流程照常可用，只是慢。
- 生产部署由 CTO 发令，开发只在 `feat/relay-v2` worktree 内进行。
