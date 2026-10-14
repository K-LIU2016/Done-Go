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

## 本轮验证

- `TANGO_REUSE_SERVER=1 node node_modules/@playwright/test/cli.js test --config playwright.tango.config.ts --reporter=line`：40/40 通过，覆盖桌面与 390px 手机、模型排序、步骤与提示词、估算上限、个人历史、完成与预留流程、数据保留、折叠面板焦点、明暗主题和英文。
- `node --test tests/unit/tango-time.test.mjs`：10/10 通过。
- `node scripts/test-unit.mjs`：604 项，586 通过，18 失败；与本任务之前已验证的既有失败一致。该结果不代表整个仓库通过。
- 用户实际页面：742px 视口下事项池宽 600px，外框 1px；会议、答疑、交流、用餐均显示建议。打开建议不会改动事项数据。

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
