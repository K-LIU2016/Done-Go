# 静驻 V2 实施合同

> **历史资料边界（2026-10-16）**：本文保留旧 V2/18 屏实施合同，供追溯与后续研究使用。它不定义当前产品入口、当前实现或上线标准。当前唯一产品基准是 http://localhost:5207/#today，主架构以 DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md 为准。

- 日期：2026-09-12；状态：执行级规划，未作为产品实现或运行验证证据。
- 目标：18 屏 1:1 还原、全部功能与交互、用户 C1–C5 上线级本地交付验证。`docs/PRD.md` 第 4 节全部逐屏要求及原验收项保留。外部账户实测与公开发布另需具体授权，单列未验证边界，不无限阻断本地交付。
- 执行身份：后续编码及产品验证由用户指定的 GLM Ultra 明文执行；原生负责只读监督、规划及文档审阅，不以本规划代替执行证据。
- 文档所有权：本轮仅修改 `docs/PRD.md`、`docs/DELIVERY-MATRIX.md` 与本文件；不提交，不运行产品验证。

## 1. 依据、证据等级与现状

明确设计要求来自 `design/UIUX_交互规范.md:48–50`（完整闭环与状态分离）、`:54–62`（检查点与责任形成）、`:68–79`（状态、失败与撤销）、`:83–99`（算术、移动端及无障碍）、`:103–105`（图片包边界及正式接入义务）。`design/00_阅读说明.md:24` 只说明静态图片为独立示例状态，不能授权把应用缩减为演示页。

以下为规划时直接观察的源码事实（VERIFIED，静态，不代表运行验证）：

| 位置 | 已观察事实 | 本合同对应修复 |
|---|---|---|
| `src/screens/s05-preview/S05Preview.tsx:37,129` | 批准仅切换局部布尔值 | §3–4 版本审批、执行与结果 |
| `src/screens/s17-m-auth/S17MAuth.tsx:32,68,79` | 任意一项许可允许批准，布尔值却显示草稿待检查 | §4 部分授权依赖与回读 |
| `src/screens/s03-inbox/S03Inbox.tsx:67–74` | 接受只更新页面状态文案 | §5 责任入账 |
| `src/screens/s14-capture/S14Capture.tsx:52–56,89–95` | 输入未绑定解析状态，检查无处理，保存只改布尔值 | §5 捕获与冲突检查 |
| `src/screens/s06-workspace/WorkspaceScreen.tsx:7–16,117,134` | 材料/确认是局部布尔值，强制补材料才能确认 | §6 分段确认 |
| `src/screens/s07-session/SessionScreen.tsx:119` | 完整记录链接阻止默认行为 | §6 真实检查点历史 |
| `src/screens/s13-sync/S13Sync.tsx:25–28,91–94` | 重试固定超时失败，原日历按钮无处理 | §7 来源与接管 |
| `src/screens/s08-stillness/StillnessScreen.tsx:29`、`src/screens/s18-m-stillness/S18MStillness.tsx:34` | 不安排只改页面布尔值 | §8 持久不安排语义 |
| `src/routes/groupA.tsx:14`、`src/routes/groupC.tsx:37` | 授权页可直接路由访问 | §4 前提校验 |

VERIFIED 仅指上述文件内容；跨屏运行、浏览器视觉、真实账户、构建与发布均需后续实证。以下字段、事件、事务和分组是本轮制定的实施决定，不冒充设计附件已有细节。实现时若证据与此表不同，以最新代码为准并记录变更，不回退其他执行者工作。

## 2. 共享数据、身份与持久化

采用单一领域状态入口和命令处理边界；桌面/移动屏只读取同一实体并发出命令，不分别维护业务真相。局部 state 仅存折叠、焦点、未提交控件值等 UI 状态。

所有实体共有 `id`（创建一次的稳定 UUID）、`revision`（单调递增整数）、`createdAt/updatedAt`（ISO 时间）、`dataMode`（`fixture` 或 `live`）及 `provenance`。时间区间保存含日期的 start/end 与 IANA timezone；显示格式不作为身份。未知值保留 null，不用 0、空数组或当前时间冒充事实。同一实体在 s01/s02 与 s15 等屏引用同一 ID。

| 实体 | 最小字段及引用 | 所有者/派生规则 |
|---|---|---|
| Source | connectorId、externalObjectId、sourceVersion、lastSuccessAt、coverage、status、lastUsableSnapshot | source service 更新；失败保留旧快照并标过期 |
| Intent / ProtectedBlock | verbatim、parsedFields、constraints、blockId、purpose(nullable)、sourceRefs、status | 本人确认字段才入正式意图；用途为空有效 |
| Request | 原话、提出者、sourceRef、acceptedBy(nullable)、status、commitmentId(nullable) | 候选请求不占用责任容量 |
| Commitment | requestId(nullable)、acceptedBy、scope、deadline(nullable)、effortEstimate(nullable)、mobility、schedule、status | 用户明确接受后创建；未知投入不计为零 |
| Plan | intentId、kind、constraintRefs、sourceVersionSet、ruleRevision、estimate、futureDebt、status | `revision` 即计划版本；摘要从实体计算 |
| ChangeSet | planId/revision、actions、objectDiffs、requiredGrants、exclusions、targetRevisions、hash | 展示与执行共用不可变快照，不能分别硬编码 |
| Approval | changeSetId/hash、planId/revision、sourceVersionSet、ruleRevision、grantedActions、status、consumedByOperationId | 一次性、限定动作与对象，不泛化成常驻权限 |
| Operation / Receipt | approvalId、idempotencyKey、stepReceipts、status、lastError、readback、resultRefs | 只有执行边界可写；回执可追踪到实体版本 |
| Draft / DraftSection | operationId、sources、version、sections、openQuestions、sentAt(nullable) | 每段独立确认；确认不写 sentAt |
| Checkpoint | draftId/version、sourceVersionSet、confirmedDecisions、openQuestions、materials、nextStep、savedAt | 由实际状态快照创建，不预置虚构确认 |
| RuleSet / AttentionBudget | ruleRevision、grants、paused、pauseEpoch、dailyMax、used、timezone、queueEntries | 统一治理执行与提醒，AI 请求无额外通道 |
| QuietSession | blockId、originRoute、decision、dismissedAt、suppressPrompts、coverageSnapshot | 不安排与未选择均不得触发再次催促 |
| LedgerEntry | commitmentId/blockId/operationId、category、minutes(nullable)、certainty、effectiveDate、supersedesId | 分类分账，结果引用去重；不跨类合计省时 |

持久存储须含 schemaVersion、原子更新、按 revision 比较更新、可恢复的迁移失败状态。存储技术由 GLM 根据当前工程选择，IndexedDB 仅是可选实现，不强制引入；实现需证明原子性、版本冲突处理、刷新恢复与失败不丢数据。不得以仅内存或单屏布尔值满足持久化。桌面与移动路由共用仓库。涉及多标签页使用版本比较及更新通知；跨设备/服务端部署若另行进入授权范围，须由账户隔离的持久存储和鉴权承接，单设备存储不能冒充云同步。

fixture 使用独立命名空间并有明确模式标记；不得覆盖用户 live 数据。重置示例只能作用于明确 fixture 数据，不提供默认清库。存储失败时命令返回失败、保留编辑内容、显示重试，不显示已保存。刷新、前后导航与重新打开必须恢复持久状态；迁移失败不能静默清空。

## 3. 命令与状态转换

所有业务命令携带 `commandId`、`entityId`、`expectedRevision`、`actor`、`issuedAt`，在领域边界校验；只有成功持久化后返回 success。失败含可读 reason/code/retryability，UI 不自行推进成功状态。事件记录 before/after revision 与关联对象，用于历史、撤销及证据。

| 命令/事件 | 前提 | 原子效果与后续状态 | 拒绝或恢复 |
|---|---|---|---|
| SaveIntent | 非空原话、合法区间；歧义待用户确认 | 保存原话及解析/约束，未生成外部事件 | 空、非法、歧义不能假定保存成功或执行 |
| AcceptRequest | 候选存在、明确本人接受、revision 一致 | request accepted 与唯一 commitment 创建同事务 | 重复命令返回既有 commitment；不可重复责任 |
| SelectPlan | 来源覆盖可解释、候选约束有效 | 保存 selected plan；生成 change set 后为 pendingApproval | 来源/约束改变转 invalid，保留候选供修改 |
| GrantApproval | change set 未变、许可满足选定动作依赖、规则允许 | 保存 approval valid，尚未执行 | 非法直达/过期/暂停/缺许可返回具体理由 |
| StartOperation | §4 全部执行前提通过 | 原子锁定 approval + 创建 operation executing | 重复命令恢复已有 operation，不重复副作用 |
| ReadbackResult | 有执行回执与目标对象 | executing → verifying → verified；持久更新产物/账本引用 | 无法确认结果为 unknown；不假装失败未执行 |
| ConfirmSections | 指定段落与来源版本仍一致 | 仅指定段落确认，草稿派生 partial/confirmed | 版本改变拒绝确认并保留编辑草稿 |
| SaveCheckpoint / Resume | 实际产物与选择存在 | 保存实际快照；恢复前核对版本 | 无检查点为空态；旧来源需复核 |
| PauseAutomation | 本人操作 | paused=true、pauseEpoch 增加，阻止下一执行步骤 | 在途动作按 §7 分开处理，不能虚报撤销 |
| KeepStill / ExitQuiet | block 存在、来源路由可恢复 | 持久保存 quiet decision，再退出；不新增任务 | 保存失败显示理由并保留安静状态 |

方案状态为 candidate/selected/pendingApproval/invalid；approval 为 pending/valid/invalid/consumed；operation 为 notStarted/executing/verifying/verified/failed/unknown。草稿状态独立为 generating/pendingReview/partiallyConfirmed/confirmed/sent。保护状态区分 localRuleEffective/externalWriting/pendingVerification/coveredChannels；覆盖列表与 lastVerifiedAt 必须同时存在。禁止把批准、草稿准备、完成交付、外部核验、保住时段、用户受益合并成一个状态。

## 4. 授权、变更集、部分许可与执行回读

1. s04/s16 选择方案保存 planId/revision；s05/s17 从该 ID 读取同一 change set。直接访问、刷新无有效候选、候选失效时显示原因并提供返回方案入口，不允许构造默认版本 03 批准；合法候选刷新后可恢复预览。
2. 方案 A 的动作分为读取指定材料、创建本地待检查草稿、更新内部投入估计。每项 diff 必须展示对象 ID 的用户可读名称、前值、预计后值、来源范围与排除项。草稿动作依赖读许可或此前仍有效且获准复用的材料快照；无读许可/有效快照不可建草稿。更新估计与建草稿分开，未授权更新时账本保持旧估计。
3. 允许部分许可，但先根据实际可执行动作重建 change set、预览和按钮文案，再批准该较小集合。只读许可最多执行读取，不能显示草稿生成；无建草稿许可不得用“批准并准备草稿”；依赖不满足则禁用并列出缺项，不能“任意勾一项即完整成功”。
4. 方案 B 使用独立延期 change set：行政责任从今日转未来、未来新增负担 40 分钟、当前预计 90/120；净节省没有发生。授权仅覆盖所列内部排程变更，不能显示或执行方案 A 的草稿许可。若动作涉及外部日历，必须另行明确对象级外部写入授权；未获得时不能宣称外部已移动。
5. hash 使用规范化的对象 diff、动作参数、目标对象 revision、计划 revision、材料范围/版本、规则 revision、grants/exclusions。任一绑定值变化，旧 approval invalid；保留可读失效原因，重新预览和批准。执行前重新读取最新状态进行相同校验，前端检查不能替代执行边界检查。
6. `idempotencyKey` 绑定同一 approvalId + changeSetHash 的逻辑执行。事务中消费批准并创建 operation；再次点击、刷新重试、多标签重复提交返回同一 operation。执行每一步前检查 pauseEpoch、许可、对象版本；步骤回执持久保存，恢复不重放已完成步骤。
7. 本地动作完成后回读持久对象；外部动作回读 provider 返回的具体对象 ID、版本和实际值。只有与期望一致才 verified；请求超时而可能已发生副作用时为 unknown，先查询已有操作/对象，不能直接重新发送。provider 不支持安全去重时明确阻断盲目重试并提供接管。
8. 部分成功保留每步结果与未完成动作；UI 不显示整体成功。可撤销本地草稿须写入真实撤销结果，已有消费批准不能复用。撤销访问只阻止后续访问；外部已发送/付款不能承诺收回。返回/关闭预览保留候选，不等于撤销执行。

## 5. 意图、请求、容量与账本

s14 所有入口（文字、语音、分享、快捷键）最终发出同一 SaveIntent/CheckConflict 命令，保留原话、来源渠道和可编辑解析字段。语音必须产生实际输入结果；能力缺失/拒绝权限给出原因与文字输入路径，不能用普通文本框标称已实现口述。未保存输入也有独立持久 draft，ESC/返回不丢失；空态展示说明，不能沿用上一条固定解析。

接受请求时仅确立本人责任，scope 待澄清可保留 pendingDetails；随后明确范围，再询问期限/投入。未知 acceptedBy、deadline、effort 不擅自补值。保存意图不创建承诺；接受不发送回复；保留想法/排除不进入容量。补齐期限/投入后同一 commitment 在 s01/s02/移动页面一致呈现并重新算容量；未知投入要显示容量判断不完整。

容量按指定区间内已知且有效的责任估计计算。初始 fixture 的 30+60+40=130、容量120、缺口10，A 为110，B 为90且未来债40。未知来源不折算空闲；固定约会不能自动移动；实际人工检查超估计发出 RecheckCapacity 并展示新冲突，需要新动作时重走预览批准，不自动侵入静驻。

账本类别至少区分 protectedDuration、estimatedHumanReduction、futureDebt、supervisionCost、measuredNetSaving。延期只转移责任日期、债务持续直到实际清偿，不能记省时。保住一小时不等于 AI 省一小时；缺少成本和对照时 measuredNetSaving=null，显示尚未测量。operation receipt 与 ledger entry 唯一关联，重复回读不重复计账；撤回估计或撤销动作建立反向/替代条目，保留历史。

## 6. 草稿、材料、检查点与上下文

草稿正文与来源必须来自批准执行的结果，fixture 也需走相同本地操作合同。每个 section 存 contentVersion、sourceRefs/sourceVersions、reviewStatus、confirmedBy/At、openIssues。补充材料是真实文件/来源记录，保留名称、内容/可访问引用、版本与读取许可；登记不代表已经核对。

用户可只确认已检查段落；缺材料部分保持 pendingReview，不强制补材料才能确认其他段。任一未决部分存在时整体最多 partiallyConfirmed；全部需要核验的段落及问题完成才 confirmed。不同意的判断保留原话和待修改内容，不能被解释为同意。段落或关联来源变化使受影响确认失效，未受影响确认保留并解释理由。确认不触发发送/提交，sentAt 只有单独获授权且有回读的发送操作可写。

撤销与导出必须提供实际产物或事件结果；导出注明来源、版本、未决项和未发送状态。保存检查点包含产物版本、本人已确认取舍、未决问题、材料与下一步；恢复先核对来源版本，旧材料需复核，不能套用静态“上次两项确认”。无历史显示空态；完整记录显示真实事件，口述、补材料、暂不处理均有真实落点。

私人上下文区分本人表达/系统假设/被否定/过期待复查，修改与否定持久化并影响后续决策读取；被否定假设不得隐形继续应用。撤销来源访问阻止后续读取，保留最小必要审计并如实说明已有副本边界；导出是可读取文件，不能只显示“已导出”。

## 7. 来源、暂停、规则与注意力预算

来源接入须记录具体 connector/account/coverage 及用户授权状态；未授权不发请求。provider 接口至少提供 readSnapshot、sync、executeAllowedAction、readback、revokeAccess；fixture adapter 可做确定性成功/失败/超时注入，但所有证据必须标为 fixture，不能作为真实 provider 验收。实现接口不等于接通账户。

同步成功更新实际 sourceVersion 与 lastSuccessAt，并使受影响计划/批准失效；失败保留 lastUsableSnapshot 标过期，外部保护保持未知。重试按真实结果推进，不能固定计时后失败或成功。原工具接管使用已验证的对象链接；无链接时禁用并说明理由，不使用无效按钮。暂用本地计划保持未知覆盖，禁止把未覆盖时段自动分配新工作。

规则修改先展示差异，经本人确认后递增 ruleRevision、保存变更历史、使相关批准失效。模型只能提交候选；s07 的规则建议不能自行生效。暂停是共享规则：阻止新自动读取、准备、写入和主动提醒；显式手动命令仍需对应许可，UI 说明哪些操作被暂停。已排队步骤暂停；尚可取消的在途动作请求取消并记录回执；无法确认停止的外部动作继续显示 executing/unknown，必须回读。恢复不自动重放队列或已消费授权；先重读来源、重新校验，再由合法命令恢复未开始工作。事项、草稿、历史及上下文保持可见。

所有外部请求、AI 建议、付费推荐使用同一 AttentionBudget。使用用户 timezone 的日界线生成 budgetDay；相同提醒 deliveryId 去重，只有确认实际投递才扣预算。非紧急预算耗尽进入持久合并队列，修改上限不抹去已使用次数。仅有可信来源、明确期限与后果的真实责任风险走独立风险展示，仍记录原因；发送者标“紧急”不构成豁免。提醒合并、延后、查看与消除均更新实体；s09、s10 与 quiet session 读取同一规则。

## 8. 保留空白与移动端

进入 s08/s18 时记录 blockId、合法 originRoute 与进入时覆盖；隐藏常规导航，保留可见退出。`decision` 为 unchosen/keepStill/music/explore/exit；未选择不是待办，不设置默认倒计时，不因沉默再催促。KeepStill 原子保存 decision=keepStill、suppressPrompts=true，再退出到来源屏；来源不可用回对应端首页。退出同样保留选择与时段，不产生遗留任务。

对同一 block，刷新、重新进入、跨桌面/移动页面与提醒队列均读取 suppressPrompts，不再生成选择催促；自然结束不要求打卡/评价。新建议不得自动填入 protectedBlock；只有本人主动修改该 block 才能调整保护或开启新的选择，必须显示具体变化，不静默清除不安排记录。保护覆盖从核验来源计算，不能因进入安静页便显示所有渠道受保护。

音乐恢复须检查既有来源许可并产生实际播放或清晰失败；失败不退出安静界面。更多可能性入口要对应实际功能且不自动创建责任。移动端与桌面共用业务实体；s17 部分许可遵循 §4，底部动作不能遮挡授权排除项，字体放大后允许滚动。全部触控目标至少44 CSS px、语义标签、键盘焦点、屏幕阅读顺序及减少动态效果按 PRD 执行。

## 9. 用户 C1–C5 证据合同

需求 ID 使用 `SNN-Lnn`（布局/文案）、`SNN-Inn`（控件/交互）、`SNN-Snn`（状态）、`SNN-ACnn`（保留 PRD 原验收项）、`FLOW-nn`（跨屏）。属性使用 R-CONTENT/R-LAYOUT/R-FLOW/R-STATE/R-BOUNDARY；用户 C 编号只采用 PRD §9 定义。实现前形成全量矩阵，不能仅列已有测试覆盖内容。

每项行为改变必须由 GLM 在生产代码修改前捕获真实缺陷 RED，修改后以同一案例取得 GREEN；记录前提、输入、预期、实际与对应版本。文案 stub RED 只算历史局部证据；已有实现若缺先行 RED，标明历史证据缺口，不事后伪造或把测试名称当复现证据。原生/主监督只读核对红绿案例与行为后果，不代替 GLM 执行产品验证。

正式矩阵为 `docs/DELIVERY-MATRIX.md`，本轮已建立18屏功能清单与历史评审映射。矩阵每行包括设计图/规范位置、PRD条目、期望效果、前提/输入、成功与失败后果、实现文件、用例ID、用户C、证据路径、运行版本/模式、状态（未实现/已实现未验证/VERIFIED/BLOCKED/UNKNOWN）。每个可见按钮、链接、菜单、输入、快捷键、tab、关闭及返回入口必须有一行；只读控件明确标注只读及理由，不伪装成可交互。

| 用户门槛 | 执行要求与通过条件 |
|---|---|
| C1 | 18屏逐屏浏览器截图，桌面1920×1200/移动480×1040 CSS视口，以设计图归一化尺寸对照布局、字体、文案、图形、间距和状态；记录每处偏差并修复，不能以仅存在截图通过；补常用窄屏及字体放大检查 |
| C2 | 全控件清单全部执行；至少完整走 A/B 方案、批准→执行→回读→账本、捕获→责任、草稿→检查点、暂停/恢复、空白退出；断言真实实体与持久结果，刷新/前后导航/桌面移动切换一致 |
| C3 | 18屏所有区域/控件/原验收项与本合同的映射无缺口；未完成、不适用及阻断须逐项说明，不得整屏笼统通过 |
| C4 | GLM 实际运行并保留类型/构建/适用静态检查输出，读取浏览器console/pageerror；注明命令、退出码、版本与基线问题，不把文档审查当测试 |
| C5 | 空数据/空输入/非法区间/未知投入、来源过期/失败、存储失败、无候选直达、参数失效、部分许可缺依赖、重复点击/多标签、超时未知回读、暂停在途、预算耗尽、不安排刷新后不催促等，逐项有输入及结果证据 |

证据注明 fixture/live、本地/部署环境与版本；本地功能完整、adapter 诚实边界、外部未验证项分别验收。真实外部账户验证与公开发布需具体授权、配置与可用环境；缺条件时外部条目单列 BLOCKED/UNKNOWN，不无限阻断本地 C1–C5 收口。可以凭完整证据报告“上线级本地交付完成”，不能报告“真实账户全链已验证”或“已公开上线”。真实收益/用户效果另需适当研究证据，不能从功能E2E推导。

## 10. 有序实施分组与互斥所有权

以下分组为后续 GLM 执行任务，不授权原生编码或运行测试。每组启动时确认最新工作树并保留他人修改；跨组请求通过接口协调，不越界编辑。新目录是规划目标，尚不代表已经存在。实际文件命名可按现有工程调整，但需要同步所有权清单。

| 阶段/组 | 唯一可写范围 | 工作与交付门槛 | 依赖/可并行 |
|---|---|---|---|
| G0 合同与映射 | `docs/DELIVERY-MATRIX.md`、本合同及PRD后续必要同步 | 复核并细化全18屏逐控件映射；冻结实体/命令接口；保留原AC | 首先完成；不编写产品代码 |
| G1 共享领域及存储 | `src/domain/**`、`src/data/**`（新）及其单元规格 | §2–8实体、命令、事务、审批、账本、治理、fixture adapter；对外稳定接口与使用说明 | 在接口冻结后为各UI组提供实现；其内部同文件不并行修改 |
| G2 Shell与还原基础 | `src/App.tsx`、`src/main.tsx`、`src/routes/**`、`src/shell/**`、`src/styles/**`、`src/screens/mobile/**` | 共享状态接入、路由前提、安静页退出、统一令牌字体与移动外壳；不改各屏文件 | G1接口冻结后可与G3–G5并行；屏组提出样式接口需求 |
| G3 责任与方案屏 | `src/screens/s01-now/**`至`s05-preview/**` | 捕获后的责任/容量读取、A/B独立变更集、审批完整链；逐屏全部PRD内容 | G1接口冻结后并行 |
| G4 协同与治理屏 | `src/screens/s06-workspace/**`至`s10-boundaries/**` | 分段草稿、真实检查点、安静界面、预算与暂停；逐屏全部PRD内容 | G1接口冻结后并行；不改Shell |
| G5 上下文与移动屏 | `src/screens/s11-context/**`至`s18-m-stillness/**` | 上下文/回顾/同步/捕获及移动关键流程，所有交互实际落地 | G1接口冻结后并行；复用G2移动外壳 |
| G6 账户适配 | `src/integrations/**`（新）及适配规格 | 指定provider实现、授权/同步/执行/回读；未获具体账户授权时仅做不触达账户的实现 | G1接口冻结后；任何真实账户/外部动作按具体授权 |
| G7 集成与验证 | `tests/**`、`evidence/**`、`docs/DELIVERY-MATRIX.md`；包配置仅由此组统一维护 | GLM集成复核全部差异并执行用户C1–C5，缺陷回原所有者修复再定向复测 | G2–G6可验收版本后；运行前检查测试脚本与数据目标 |

G0 与 G7 对矩阵的写入为前后阶段交接，不同时编辑。G1 的领域规格与 G6 的适配规格放各自目录，`tests/**`由 G7 独占，避免争写。若需要安装依赖或修改构建配置，由 G7/主 GLM 执行者统一处理，其他组只提出需求。并行组只能在可用并发槽内排队；不要为满足表格同时启动超额执行者。

本地交付完成条件：原18屏要求、全部本地交互、跨屏合同、adapter诚实状态与用户C1–C5证据全部对应；GLM执行编码及验证，原生/主监督独立只读核对最终差异、红绿证据和验收结果后报告各项完成。外部授权/环境/真实账户/公开发布单列尚未验证项，不无限阻断本地交付。不能用计划完成、局部GREEN、页面可访问或构建通过宣称已公开上线。
