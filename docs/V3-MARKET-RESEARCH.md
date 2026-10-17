# Tango Done&Go V3 市场研究与证据边界

> **历史研究边界（2026-10-16）**：本文保留 V3 市场研究与竞争判断，供追溯与后续研究使用。它不定义当前产品入口、当前实现或上线标准。当前唯一产品基准是 http://localhost:5207/#today，主架构以 DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md 为准。

日期：2026-09-13。用途：为下一大版本 PRD 提供方向和反证，非市场规模报告、投资结论或竞品实测榜单。主稿见 [PRD-V3](PRD-V3.md)。

## 1. 结论先行

现有产品已经覆盖多视图任务日历、工作负荷规划、自动排程、专注保护、AI 操作与人工确认。Tango Done&Go 不应把“AI 会排日历”“可以看预览”“保护专注时间”单独说成独有能力。最近邻是官方仍标为私测的 Reclaim 2.0，以及偏主动规划的 Sunsama：两者让“控制感”本身也不是无人竞争的概念。

建议检验的组合差异是：面对一项侵占私人时间的真实责任，明确本人到底接受了什么、哪些条件尚未知、选择把负担移到哪里、系统究竟能做什么，并在处理完成后减少索取注意力。这个组合是否足以促成使用、迁移和付费，仍是 HYPOTHESIZED。

研究支持 V3 优先补真实数据和可核验动作，不支持先扩成任务/笔记/团队/全能代理套件。官方文档未提及某能力，不足以证明竞品没有；本报告不作“市场唯一”的断言。

## 2. 方法与可信范围

证据分三层：

- O1：本轮主控经 Codex 内置浏览器直接阅读的官方页面。可证明当日页面所述内容，不等于实际账号能力。
- O2：前阶段并行研究的官方资料摘要，从本任务连续上下文恢复。可作为有来源的研究输入；当前成稿阶段未逐页重开，不与 O1 混称当日全量复核。
- I/H：由这些材料形成的推导或产品假设。需要后续用户研究和真实使用反证。

源表共 23 个文档、8 个注册域，主要是 6 个直接竞品、1 组 Microsoft 工作研究、1 组 Google 接口文档。它们不是 23 个独立样本，也不是广泛市场覆盖。没有竞品付费账号实操、用户访谈、愿付费测试、留存数据、获客数据或独立市场规模估算。Morgen、Routine、Structured、Amie、Apple 生态工具及中文区域产品未完成系统深比，列为覆盖限制。

前阶段逐波日志不完整，已在研究 journal 说明恢复过程。web 搜索工具曾返回空内容，没有把空响应记成读过来源；最新四页以允许的内置浏览器读取。后续 refinement agent 路由失败，不虚构新的独立复核。

## 3. 竞争能力与对 Tango Done&Go 的影响

| 产品 | 官方材料支持的能力边界 | 对 V3 的含义 | 不可外推的结论 |
|---|---|---|---|
| Todoist | 任务与日历整合；直接连接与任务日历有账户/编辑边界，外部事件并非都可在应用中编辑 [S01/O2] | 日历连接必须说明账号、读写范围及任务与外部事件关系 | 不能假定任务进入独立日历就占用了本人主日历的 busy |
| TickTick | 天周月/列表、任务、习惯、专注和协作等成熟功能面；隐私页包含 AI 相关说明 [S02–S04/O2] | 多视图、快速编辑和基本可靠性是预期能力，不能让 V3 只有概念图 | 隐私政策提及 AI 不证明所有账号已获得同一 AI 功能 |
| Sunsama | 每日规划、工作量/延期/收尾；Sunny 可在明确交互下辅助任务/事件操作 [S05–S06/O2] | 控制节奏、延期和收尾已有参照，必须降低主流程负担 | 供应商关于用户幸福/负担的数据不是随机试验因果结论 |
| Motion | 基于截止、时长、优先级、拆分等自动排程；某些硬截止可能使安排超出通常工作时段；另有 AI 会议材料 [S07–S09/O2] | 自动排程的约束优先级必须显式，Tango Done&Go 不静默牺牲本人保护区 | 不应概括为 Motion 所有场景都忽视边界，具体以配置/模式为准 |
| Reclaim 2.0 | 私测介绍包含 AI agents、日历 sandbox、Preview 与 Review & apply；任务以建议方式进入，部分自动排程仍标开发中 [S10/O1]；FAQ 与旧 1.0 smart meetings 行为需要区分 [S11–S13/O2] | 是最接近的比较对象；人工确认、保护专注与预览不能作为单独独创点 | 私测功能不等于普遍可用；旧 1.0 的自动行为不能套到 2.0 |
| Akiflow | Aki 捕获/执行助手与 MCP 操作接口，支持任务/日历相关操作，部分涉及参会者或通知 [S14–S15/O2] | 工具连接会放大权限后果，必须显示收件者/参会者/通知和动作许可 | 日历邀请不是双方接受同一条款，工具接口可用也不是安全协商机制 |

### 3.1 最近邻反证：Reclaim 2.0

本轮直接读取官方 overview：页面写明 private beta，包含 Planner、AI agent、日历预览和用户审阅应用变更；任务当前是建议安排，部分自动功能仍在开发。因此 PRD 已删除“人类在环确认就是差异化”的暗示。要比较的是一个真实工作流中谁更少误解责任、谁更少要求监督、谁更诚实对待未实现的边界，而不是比概念词数量。

后续应使用同一脚本实测：一个不可侵占时段、一个固定会议、两个可调整责任、一个需要他人同意的截止变更；记录控制步骤、默认行为、无解行为、未来负担、外部效果与恢复。未执行该试验前，不宣称 Tango Done&Go 优于 Reclaim。

### 3.2 竞争策略的范围约束

不以连接器数量追逐平台；P0 选择一个真实 provider。不要为追赶会议记录产品而新增录音转写主线，也不要为追赶任务管理而新增习惯/积分。用户已经有日历和工作工具，Tango Done&Go 应减少其边界决策的负担，而不是要求把全部工作迁到另一个系统。若研究发现用户确实只需要简单日历整理，应缩小 Episode 流程而非坚持复杂理念。

## 4. 需求证据与谨慎推导

| 资料 | 可以支持 | 不支持 | 对应 PRD 选择 |
|---|---|---|---|
| Microsoft “infinite workday” [S18/O2] | 工作打断和工作时间蔓延是值得研究的问题 | 报告的 275 次打断口径涉及高通知量群体及全天窗口，不能说平均每人每个 8 小时工作日都被打断 275 次 | 注意力预算与主动提示节制，但不拿数字营销 |
| Sunsama 2025 工作与幸福报告 [S19/O2] | 供应商/客户样本对规划、负担、体验的自报线索 | 不能把关联归为产品因果效果、临床益处或全体劳动者统计 | 用本人反馈检验价值；写清样本来源、未反馈与退出 |
| Microsoft Research/CHI AI 与批判思考研究 [S20/O2] | 319 名知识工作者的自报研究提示 AI 信任、努力和任务条件之间存在关系 | 不是 AI 导致认知衰退的实验结论 | 来源、人工复核和不确定性提示，但不能制造每一步都点确认的负担 |
| Sunsama/Akiflow/TickTick 隐私材料 [S04/S16/S17/O2] | 不同厂商对 AI 处理与数据政策有说明 | “不用于训练”不等于不向模型传输，也不等于全部提供方零保留 | 材料范围、处理方、配置变化与个人披露同意分开管理 |

## 5. 首个连接器的可行性建议

Google 官方 create-events 页直接说明 events.insert 所需 calendarId 与起止字段、timed/all-day 的不同语义、写入权限与自定义 event ID；自定义 ID 可帮助处理后端已成功但响应失败的重复创建风险。参会者和 sendUpdates 会影响邀请/邮件。Tango Done&Go P0 因而只建议私人无参会人块，并保留稳定外部 ID 与读回。[S21/O1]

Google scopes 页直接列出 calendar.events.readonly、calendar.calendarlist.readonly、calendar.events.owned、calendar.app.created 与更广泛的 calendar；建议最小权限，并说明某些公共应用访问用户数据需要验证。应用只选择一个日历，不代表 OAuth token 只拥有这个日历权限。创建专用副日历也不自动证明主日历可用性受到保护。[S22/O1；后一判断为 INFERRED]

Google Events resource 页补充了提醒、忙闲、可见性和事件类型的字段语义：`reminders.useDefault=false` 且无 overrides 才能把“无提醒”写成可读回的明确状态；`transparency=opaque` 表示 busy，`visibility=private` 显式选择私密，`eventType=default` 保持普通事件语义。提醒变化不能仅靠 `updated` 字段判断，因此 V3 要求读回提醒设置本身。[S23/O1；接口文档事实，不是账号实调]

建议只比较两个有边界的方案：

| 选项 | 优点/适配性判断 | 要先验证的条件 |
|---|---|---|
| Google：选定 owned 主日历，Tango Done&Go 私人块 | 服务端接口、稳定对象 ID 与权限文档较明确；适合当前 Web/Node 原型演进（INFERRED） | 首批用户确实使用；OAuth 实际授予与审核；无提醒字段效果；外部改动与 unknown 恢复 |
| Apple：延续早期已确认方向 | 保持既有生态意图，可能更贴近本人使用（HYPOTHESIZED） | EventKit/CalDAV 选型、主机/原生权限、后台与多用户隔离、真实读写与恢复；本轮未做充分 API 对比 |

Google 推荐是待 D03 审批的先后顺序，不是已批准替换 Apple。不能用当前 Google 文档更多就推导它一定更适合目标用户。

## 6. 假设、反证和下一轮研究

| 假设 | 最低成本验证 | 应放弃或修订的信号 | 产品影响 |
|---|---|---|---|
| H1 用户愿意围绕“保留一段时间”而非任务列表决策 | 8–12 人近期情境访谈；用本人过去一次冲突重建流程 | 多数没有调整权限，或只能接受固定要求 | 换更有裁量空间的用户/情境，别扩大 AI 自动化 |
| H2 精确差异和有限授权增加控制感且不增加监督负担 | 原型对比自己手工处理的步骤/主动时间/理解 | 需反复解释状态、比手工更慢且无价值补偿 | 合并主路径，减少无需后果的确认 |
| H3 未来负担账能改善本人选择 | 同一责任多次延期的纵向访谈和回顾 | 用户只觉得是羞辱/绩效追踪，不帮助判断 | 调整表达和可见范围，不做负担评分 |
| H4 一个真实日历动作足以支持重复使用 | 授权小规模真实试用，记录无连接能力导致的放弃 | 关键来源长期缺失；只创建 busy 块无法改变情境 | 追加必要来源或更换第一连接器，重新评估范围 |
| H5 双人协商有独立价值 | 先观察已有双方协商，不自动发邀请 | 协商已在原工具解决，新增产品只增加一轮动作 | 延后 P1，避免团队化 |

商业研究尚待进行：用户用什么替代、为什么会切换、谁付费、能接受的本地托管可靠性、真实模型成本和可持续收费。不能从厂商标价直接推断 Tango Done&Go 定价。本 PRD 不给虚构 TAM/SAM/SOM 或未来收入曲线。

## 7. 官方来源清单

访问口径为本任务 2026-09-13 研究窗口。O2 不代表下列页面均在成稿阶段重新打开；S10/S21/S22/S23 为主控直接内置浏览器复核。相对“本周更新”不转写成虚构精确发布日期。

| ID | 官方来源 | 证据等级与使用限制 |
|---|---|---|
| S01 | Todoist：Use the calendar integration — https://www.todoist.com/help/todoist/integrations/use-the-calendar-integration-rCqwLCt3G | O2；连接/编辑边界，非账号实测 |
| S02 | TickTick 产品首页 — https://ticktick.com/ | O2；官方功能介绍 |
| S03 | TickTick Changelog — https://ticktick.com/public/changelog/en.html | O2；版本更新信息，不等于全账号 rollout |
| S04 | TickTick Privacy — https://ticktick.com/privacy?language=en_US | O2；隐私/AI 处理边界 |
| S05 | Sunsama：Daily planning, the basics — https://help.sunsama.com/docs/getting-started/basics/daily-planning-the-basics/ | O2；规划/工作量流程 |
| S06 | Sunsama：Sunny — https://help.sunsama.com/docs/usage-guides/sunny/ | O2；AI 功能说明，不等于实际测试 |
| S07 | Motion：Auto-scheduling how-to guide — https://www.usemotion.com/help/time-management/auto-scheduling/auto-scheduling-how-to-guide | O2；自动排程流程 |
| S08 | Motion：What auto-scheduling considers — https://www.usemotion.com/help/time-management/auto-scheduling/reference-auto-scheduling/what-auto-scheduling-considers | O2；约束与优先级边界 |
| S09 | Motion：AI Notetaker — https://www.usemotion.com/help/knowledge-management/ai-notetaker | O2；邻近能力，不建议复制主线 |
| S10 | Reclaim：Reclaim.ai 2.0 overview — https://help.reclaim.ai/en/articles/14846468-reclaim-ai-2-0-overview | O1；私测、预览/批准/建议；显示 Updated this week |
| S11 | Reclaim：Reclaim 2.0 FAQ — https://help.reclaim.ai/en/articles/15280604-reclaim-2-0-faq | O2；须与 1.0 区分 |
| S12 | Reclaim：Managing Smart Meetings — https://help.reclaim.ai/en/articles/5617432-managing-smart-meetings-on-your-calendar | O2；旧版本语义，不推给 2.0 |
| S13 | Reclaim：Getting started — https://help.reclaim.ai/en/articles/5224992-getting-started-with-reclaim | O2；来源设置/隐私说明 |
| S14 | Akiflow：Aki — https://akiflow.com/aki | O2；AI 产品能力 |
| S15 | Akiflow：MCP — https://product.akiflow.com/en/help/articles/4302815-akiflow-mcp | O2；工具动作边界 |
| S16 | Sunsama Privacy — https://www.sunsama.com/privacy | O2；政策声明不等于零传输 |
| S17 | Akiflow Privacy Policy AI Addendum — https://akiflow.com/privacy-policy-ai-addendum | O2；模型处理/保留边界 |
| S18 | Microsoft WorkLab：Breaking down the infinite workday — https://www.microsoft.com/en-us/worklab/work-trend-index/breaking-down-infinite-workday/ | O2；样本与时间窗口须保留 |
| S19 | Sunsama：The State of Modern Work and Well-Being Report 2025 — https://www.sunsama.com/blog/the-state-of-modern-work-and-well-being-report-2025 | O2；供应商自报研究，不作因果 |
| S20 | Microsoft Research：Lee et al., AI and critical thinking, CHI 2025 — https://www.microsoft.com/en-us/research/wp-content/uploads/2025/01/lee_2025_ai_critical_thinking_survey.pdf | O2；319 名工作者自报，非认知损害实验 |
| S21 | Google Calendar：Create events — https://developers.google.com/workspace/calendar/api/guides/create-events?hl=zh-cn | O1；页面最后更新 UTC 2026-08-25，接口文档非实调 |
| S22 | Google Calendar：Choose scopes — https://developers.google.com/workspace/calendar/api/auth?hl=zh-cn | O1；页面最后更新 UTC 2026-09-09，权限文档非账号授予 |
| S23 | Google Calendar：Events resource — https://developers.google.com/workspace/calendar/api/v3/reference/events?hl=zh-cn | O1；页面最后更新 UTC 2026-07-07，字段语义文档非账号实调 |

## 8. 研究到需求追溯

| 研究输入 | 推导 | PRD 落点 |
|---|---|---|
| S01–S06 | 多视图/工作量/明确收尾属于基础竞争能力 | V3-07–10、V3-13、V3-35 |
| S07–S08 | 约束优先级要解释，不能默认牺牲保护 | V3-14–16 |
| S10–S13 | 预览与确认已有，差异化要用真实结果和成本检验 | 第 1/2/8 节、V3-17–22 |
| S14–S17 | 能调用工具不代表有个人同意；模型处理是数据披露 | V3-18、V3-27、V3-30–32、V3-44–48 |
| S18–S20 | 打断/监督值得研究，供应商和自报证据不能过度外推 | V3-33–36、第 8 节 |
| S21–S23 | 单一有限日历写入、稳定 ID、最小授权、明确关闭提醒和真实读回 | V3-20–25、D03 |

本研究影响了 PRD 的范围收敛和证据门槛；未据此实现任何产品代码或开通外部账号。
