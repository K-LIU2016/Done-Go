# 任务 AI 推荐与省时估算

核验日期：2026-10-14。范围：静态页面 `web/index.html` 的事项建议。

## 官方能力来源

| 模型 | 已核验的能力 | 任务推荐依据 | 官方说明 |
| --- | --- | --- | --- |
| Anthropic Claude Sonnet 5.5 | 1M 上下文、可调推理、较快响应 | 长论文放在同一对话、原稿连同要求进行修改 | https://platform.claude.com/docs/en/models/sonnet-5-5/overview |
| OpenAI GPT-5.4 | 代码、专业工作、文本与图像输入、结构化输出 | 代码诊断、字段提取、表格、自测 | https://developers.openai.com/api/docs/models/gpt-5.4 |
| Google Gemini 3.1 Pro Preview | 长上下文、文本/图像/音频/视频/PDF 输入、结构化输出 | 议程、讲义、转写和多份资料梳理 | https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview |

通过 agent-reach 的 Jina 网页读取路径核验以上页面。Claude Sonnet 4.6 官方页标为 Legacy 并建议迁移到 5.5，因此替换旧参考型号。型号排序是本产品根据工作流作出的推荐，不是三家公司之间的性能基准结论。API 能力不保证消费应用或用户当前账户提供同样的型号与功能；页面保留应用入口、官方说明和账户可用性提示。

## 估算假设

没有至少 2 条同类已确认个人记录时，按类型和计划时长给出场景区间；这些比例尚未经过用户实验。不是厂商提供的省时数据，不写入已确认腾出时间，不自动更改计划。

| 场景 | 初始净省时假设 | 上限 |
| --- | --- | --- |
| 论文摘要初读与重点定位 | 25%–33.3% | 40 min |
| 写作修改 | 20%–35% | 45 min |
| 代码诊断与修改 | 20%–40% | 60 min |
| 会议准备与会后整理 | 10%–16.7% | 20 min |
| 邮件草稿 | 20%–40% | 15 min |
| 多资料初筛 | 20%–35% | 40 min |
| 行政表格、初评 | 15%–30% | 30 min |
| 学习资料准备与知识点定位 | 15%–25% | 25 min |
| 用餐、运动、陪伴的准备清单 | 2%–5% | 5 min |
| 出行路线比较与准备 | 3%–10% | 10 min |
| 不明确任务的计划准备 | 0%–5% | 5 min |
| 睡眠、休息 | 0% | 0 min |

例如 60 min 论文摘要初读展示 15–20 min，不表示完整精读或理解已完成。比例按包含准备、核对、返工的净用时设定，实际收益可能为 0 或负值。低值向下取整、高值四舍五入，并限制在计划时长及场景上限内。

准备类建议仅处理菜单、路线比较、装备或活动清单；保留吃饭、参会、运动、陪伴及休息本身的时长。未知任务建议先明确交付物，避免虚构具体任务内容。

非准备类任务有至少 2 条同类、去重、已确认且使用 AI 的个人记录时，优先显示个人计划与实际差值区间。这不是 AI 因果贡献。准备类仍用独立场景假设，避免把整个物理活动的历史缩时当成准备收益。

## 内容与数据

15 类建议分别提供优先模型、理由、3 个操作步骤、设备建议、提示词和 2 个备选。识别来自任务标题规则；模糊标题使用通用准备建议，不调用 LLM 进行语义识别。

打开建议不发送资料、不更改事项或存储记录。用户在外部应用中主动选型号、上传资料、提问和核对。自由预留时段及已完成任务不再显示待执行建议。

中文、英文提供完整新建议；其余语言的新详细说明暂用英文回退，通用标签已有本地化。

## 首页的折叠入口

首页优先展示语音和文字输入，再展示事项建议、泡泡与自己的时间安排。「全天未排」、预算、已排、预留与计算口径整体放在首页内容末尾；桌面跨两栏，手机在所有安排内容之后。桌面与手机均已检查输入位于首屏、摘要位置低于两栏内容。

「事项池」改为「事项 · AI 建议」，默认收起。标题右侧显示当天全部事项数量与展开箭头；展开后保留原有排序、事项卡、模型能力建议、详情和完成操作。空态显示 0，并在展开后提供「试一条」。

采用原生 `details / summary`，支持点击、Enter 与 Space。当前页面会话内，数据重绘、语言切换与页面往返保留展开选择；重新载入恢复默认收起。折叠操作不写入事项或完成记录。标题适配已有 6 种语言。

修复首页无 `#today` 哈希时「试一条」重复触发路由刷新、清空刚填入示例的问题；此入口仅出现在首页，移除多余的哈希跳转。

## 回顾中的两种差值

首页移除「腾出 ✓」。回顾顶部依次展示「预计腾出」「实际腾出」，替代原来的「已确认腾出」「已用到自己的时间」卡片；支持 7 / 30 天范围。

- 预计腾出 = 不用 AI 的预计用时 − 用 AI 的预计用时。前者以用户原计划时长为基准，后者由现有任务建议的净省时区间倒算，并非真实测得的对照。累计范围内全部非预留事项，按事项 ID 与日期去重，排除无效时长。
- 完成时保存原计划与预计区间。任务完成后时段缩短或同类个人历史增加，不会改写此任务已保存的预计值。旧任务缺少快照时，用原计划时长及当前建议回退计算，展示过程不迁移或写入用户数据。
- 实际腾出 = 已确认完成事项的原计划时长 − 用户确认的实际用时。包含未使用 AI 的完成记录；超时保留负值，按任务 ID 与日期去重，忽略未确认与无效记录。现有完成表单仍输入分钟，原计划时长来自用户设置的开始 / 结束区间。
- 预计覆盖全部计划事项，实际只覆盖已确认完成事项，因此不是相同样本的 AI 效果对照。自主预留、确认「用到了」不会增加这两项差值。原日历与预留流程维持其既有非负腾出记录口径。

预计比例仍待用户实验验证；实际差值不构成 AI 因果贡献的证据。计算说明收在 `ⓘ 口径` 中，主界面以数字、减号与 `min` 为主。

## 本轮验证

- `TANGO_REUSE_SERVER=1 node node_modules/@playwright/test/cli.js test --config playwright.tango.config.ts --reporter=line`：58/58 通过，覆盖桌面与 390px 手机、事项建议默认折叠、键盘展开、切换语言保留展开状态、折叠不改事项数据、空态示例、回顾减法公式、上下排列、预计快照保留、超时负值、日期范围、模型排序、步骤与提示词、估算上限、个人历史、完成与预留流程、数据保留、折叠面板焦点、明暗主题和英文；新增语音与时间树核验见 [tango-voice-and-tree.md](tango-voice-and-tree.md)。
- `node --test tests/unit/tango-time.test.mjs`：11/11 通过，新增实际差值的超时、去重与日期筛选核验。
- `node scripts/test-unit.mjs`：609 项，591 通过，18 失败；失败名称与本任务之前已验证的既有失败一致。该结果不代表整个仓库通过。
- 用户实际回顾页：预计 24–43 min（360 − 317–336），实际 75 min（120 − 45），1 项完成；已观察到两块卡片依次上下排列。浏览器真实数据未注入测试样例。

既有失败名称：

1. browser-like cross-tab storage without Web Locks fails closed; injected locks make it ready
2. implicit browser storage requires Web Locks by default; injected unit storage stays lock-free
3. resetFixtureDomain implicit browser path is lock protected; explicit storage keeps fixture-only semantics
4. desktop grantApproval uses shared immutable workflow command execution
5. desktop startOperation uses shared immutable workflow command execution
6. desktop readbackOperation uses shared immutable workflow command execution
7. public Host requires an Origin for writes and matching Origin lets an admin save verified settings
8. LEUBAI_AUTH_DISABLED=1 preserves loopback settings access and skips sqlite initialization
9. store: unreadable file is an explicit error, not an empty config
10. save requires matching proof; verified save persists safe settings with 0600/0700 modes
11. restart keeps verified config and generate returns model text with requestId
12. disconnect clears the key, disables generate and persists
13. save failure keeps previous settings and returns sanitized error
14. connection proof expires after its bounded validity window
15. oversized bodies receive the typed 413 response instead of a connection reset
16. ModelScope launcher rejects unsafe origins before creating runtime state
17. ModelScope launcher cannot disable authentication
18. loopback LEUBAI_HOST starts, reports the bound port and exits cleanly on SIGTERM

未验证：省时区间的用户实验、每种模型的任务对照评测、所有外部消费应用的账户型号可用性；详细步骤未完整翻译为俄文、泰文、阿拉伯文或韩文。
