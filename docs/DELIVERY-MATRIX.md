# 静驻 V2 交付矩阵

> **历史资料说明（2026-10-16）**：本矩阵保留旧 V2/18 屏需求与证据分母，供追溯和后续研究使用；其中的 React 路由、`/inbox`、18 屏验收目标和旧品牌表述不定义当前探戈 Done&Go。当前唯一产品基准是 `http://localhost:5207/#today`，当前架构以 [DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md](DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md) 为准。

日期：2026-09-12。状态：规划基线，尚未完成交付验收。目标为18屏1:1、全部功能与交互、用户C1–C5上线级本地交付验证。编码和产品验证由用户指定的GLM Ultra执行；原生/主监督独立只读验收，本轮仅文档规划与只读审查。外部账户实测及公开发布另需具体授权，不无限阻断本地交付。

## 阅读规则与证据状态

- `D:n` 指 `design/UIUX_交互规范.md` 的原始行号；引号内是已读设计原文。逐屏“PRD”指 `docs/PRD.md` 第4节对应同名屏幕的布局、模型、交互、状态与全部原验收项，不因本矩阵简写而删除细节。跨屏行为细化是 `docs/V2_IMPLEMENTATION_CONTRACT.md` 的实施决定。
- 每屏标题中的源码路径是本屏所有行的默认实现位置，配套CSS在同目录；共享命令指向实施合同规划的 `src/domain/**`、`src/data/**`，尚未声称已实现。图像路径为对应源设计依据；本轮没有重新目视比较PNG，C1一律待GLM真实浏览器复核。
- 每屏“继承证据”适用于其全部行；历史截图和测试文件存在不等于行已通过。行里的E编号是下一轮所需证据ID：`E-{需求ID}`；文件建议 `evidence/final/<ID>.md`，同时列出截图/运行日志引用，记录版本、时间、视口、fixture/live、前提、步骤、预期与实际结果。
- `OPEN`：需求未完成验收，可能已有部分静态实现；`GAP`：只读代码或已读评审已确认缺口；`UNKNOWN`：本轮未验证该行为；`BLOCKED`：明确缺外部授权/环境。只有GLM实际执行对应用例并附证据后才能填写VERIFIED，不能凭静态实现标PASS。
- 每个子编号是独立需求与证据，例如 `I01/I02` 必须分别执行；每屏 `AC01–AC04` 是PRD原四项验收标准，逐条保留，不能以布局行代替。矩阵可以继续拆分新发现的可见控件，但不能删除未实现行来减少分母。
- 每项行为改变在生产代码修改前由GLM捕获针对真实缺陷的RED，修改后同案例GREEN；E记录须分别引用红绿证据及版本。文案stub RED只算历史局部证据。没有历史真实RED就标缺口，不补写虚构失败，也不以只读规划作为产品验证。

用户验收编号固定为：C1＝18屏真实浏览器布局截图；C2＝全部交互E2E；C3＝详细PRD映射；C4＝构建/检查/console；C5＝空错非法回归及保留空白。所有本矩阵行均属于C3；表中C列列出其他对应门槛。旧评审C编号不直接沿用。

### 2026-09-13 当前证据增量

以下是当前已实际执行的子项，不将同一行尚未执行的其他子项一并判为通过。历史源码描述由下文对应行更新，需求编号和分母保持不变。证据 `ROOT-IAB-0913` 指 `.omo/evidence/root-iab-closeout-20260913.md`，使用工具确认的 Codex In-app Browser，隔离 fixture origin 5213。

| 子项 | 当前直接观察 | 证据及边界 |
|---|---|---|
| S11-I08 不准确 | 显式载入演示推测→驳回→刷新，仍为已驳回，不再提供确认入口 | ROOT-IAB-0913；非真实用户历史 |
| S12-I08 跳过 | 2026-09-07 / Asia/Shanghai 的跳过反馈刷新保持，提供显式修改入口 | ROOT-IAB-0913；其他三种反馈仍待逐项操作 |
| S13-I03 暂用本地计划 | 刷新保持；S04延期未知未来时段被拒绝；旧来源复核不能解除模式 | ROOT-IAB-0913；不等于覆盖所有调度入口 |
| S13-I01 重新核验成功 | 实际调用演示适配器，更新最近成功时间；再显式返回连接模式成功 | ROOT-IAB-0913；真实账户和失败/超时分支未由此证明 |
| S05 批准与回读增量 | 移至右侧的批准按钮生成两节可编辑草稿；刷新保留状态与内容 | ROOT-IAB-0913；全部异常授权组合仍待验证 |
| C4 聚焦检查增量 | production build退出0；领域/持久化/计划视图209/209；LLM安全8/8；本轮已操作页面error/warn为空 | ROOT-IAB-0913；不替代18屏全操作与完整C1验收 |

## 已有评审与证据目录

已完整读取 `.omo/evidence/tango-donego-gate-review.md`（61行）；其第3行结论为REJECT。第7行把结果描述成local demo，是历史评审采用的范围，不作为用户全功能目标的缩减授权。

| 引用 | 已有评审事实与原位置 | 映射用户C | 当前处理 |
|---|---|---|---|
| GR1 | 第13–16行：s14解析固定、检查无处理、保存/关闭丢改动、无空态 | C2/C5 | 未关闭；S14输入链修复后以变化输入及刷新证明 |
| GR2 | 第18–21行：s05/s17没有批准到真实草稿，移动部分许可仍宣称草稿 | C2/C5 | 未关闭；共享操作/回读、授权依赖与草稿证明 |
| GR3 | 第23–26行：s17缺少演示/非真实账户声明 | C1/C2 | 未关闭；fixture/live状态如实披露 |
| GR4 | 第28–31行：Shell 232px文字栏替代窄图标栏；s17品牌/卡片/底部动作结构偏差 | C1/C2 | 未关闭；修复后按同尺度截图；其余16屏仍未完整目视通过 |
| GR5 | 第33–36行：s11–s18缺GREEN；s01截图早于最终页脚 | C1/C3/C4 | 未关闭；需最终运行版本的逐项证据 |
| GR6 | 第42–43行：测试固定不执行、未改输入，过拟合未完成功能 | C2/C5 | 重写到真实状态结果；保留合理边界断言 |
| GH | 第51–56行：报告记录8ff1091时76通过/26跳过、tsc/build/lint退出0；仅直接比较s01/s17 | C4及局部C1 | 历史报告事实，本轮未重跑，不视为当前验证 |

本轮只读目录确认：`evidence/screenshots/s01.png`至`s18.png`存在；`evidence/red/s01.txt`至`s18.txt`存在；`evidence/green/s01.txt`至`s10.txt`存在，s11–s18不存在；测试文件为 `tests/groupA.spec.ts`、`groupB.spec.ts`、`groupC.spec.ts`、`smoke.spec.ts`。未在本轮逐个重读历史日志或运行测试。下文E-A＝groupA＋对应既有RED/GREEN/截图；E-B＝groupB＋对应RED/GREEN/截图；E-C＝groupC＋对应RED/截图、缺GREEN。它们都是历史入口，不能覆盖新增功能验收。

## 全局和共享闭环

设计出处：D:13–19（排版/字体/材质/控件）、D:48–50（闭环）、D:68–79（状态/失败）、D:95–99（移动/无障碍/动效）；PRD第2、3、5–9节。实现：`src/shell/Shell.tsx`、`src/shell/shell.css`、`src/styles/*`、`src/App.tsx`、`src/routes/*`、`src/screens/mobile/*`及规划领域层。历史证据GR4/GR5/GH。

| ID/功能 | 真实交互、状态或持久化结果 | 缺口/待证 | C | 状态 |
|---|---|---|---|---|
| GLOBAL-L01 桌面窄图标栏/品牌/日期/页脚 | 六导航与图标、搜索、头像按原图区域；真实数据模式文案不误导 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)已有全屏双主题图；后续构建仍显示六导航、品牌和fixture声明，完整像素对照未判通过 | C1 | OPEN |
| GLOBAL-I01 六导航；I02搜索按钮；I03⌘K；I04头像入口 | 每项单独可达；搜索与⌘K到同一capture；头像到`/context`私人上下文；键盘焦点合理返回 | Shell已实现六导航、搜索、⌘K及context头像；旧“缺入口”描述失效。逐项键盘焦点返回仍待证 | C2/C5 | OPEN |
| GLOBAL-I05 四移动tab；I06各屏⋯菜单 | 每项路由可达且保留实体；设计未独立给图的菜单用现有设置/边界功能承接，不空按钮 | [RC8交互附录](../.omo/evidence/rc8-interactions-20260913.md)实际点击四tab到/m/now、/ledger、/m/plan、/m/auth，菜单到/m/settings，480px无横向溢出；非全部实体上下文/键盘组合通过 | C2 | VERIFIED所列导航；其余组合OPEN |
| GLOBAL-S01持久化；S02存储失败；S03多标签竞争 | 刷新不丢业务状态；失败不显示保存成功；revision冲突不覆盖新值 | [RC6](../.omo/evidence/rc6-closeout-20260913.md)已实测S05/S17原命令恢复；S06/S10故障已有GREEN；[RC8](../.omo/evidence/rc8-interactions-20260913.md)S08写后未知重试总写1次。各证据限原场景，不等于全部多标签及整页刷新unknown恢复 | C2/C5 | OPEN：所列故障已证，其余组合待验 |
| GLOBAL-S04来源/审批失效；S05幂等回读 | 来源/规则/参数变化拒绝旧批准；重复执行返回同一回执 | 实施合同§3–4 | C2/C5 | OPEN |
| GLOBAL-S06模式隔离；S07恢复/迁移失败 | fixture与live存储隔离；迁移失败保留数据并显示恢复路径 | 不能清空用户数据装成功 | C5 | UNKNOWN |
| GLOBAL-L02字体/令牌/图形；L03响应式；L04动效 | 18屏原图对照；字体放大可滚动；减少动态效果生效 | PNG原图未在本轮重审 | C1/C2 | OPEN |
| GLOBAL-I07全键盘路径；I08触控/读屏语义 | 每项时间变更非拖拽路径、44px目标、标签/焦点/阅读顺序 | 完整交互面待证 | C2/C5 | UNKNOWN |
| GLOBAL-C401类型；C402构建；C403静态检查；C404console | GLM逐项实际运行并记录退出码/浏览器错误/版本 | GH仅历史结果；26跳过需逐项归因 | C4 | UNKNOWN |

## s01 此刻 · 时间主权

原文D:25：“没有执行变更不能写成已优化”；PRD s01全部条目。原图：`design/01_桌面大图/01_此刻_时间主权.png`。实现：`src/screens/s01-now/S01Now.tsx`。继承证据E-A、GR4/GR5；所需E-S01-*。

| ID/功能 | 真实交互/持久结果 | 评审缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S01-L01时间意图/椭环/决定卡/三责任卡/页脚 | 19–20为主对象，容量120/130/10与移动性完整 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)已归档双主题1920×1200视口图；这是渲染/截图覆盖，非逐区域1:1通过 | C1 | OPEN |
| S01-I01主动作；I02减负方向；I03延期方向 | 各自到方案并保存正确选择/上下文；未执行不改账本 | [root-iab-closeout-20260913.md](../.omo/evidence/root-iab-closeout-20260913.md)实测首页主动作→S04→A预览，批准前独立呈现；I02/I03及逐入口上下文仍待分别验证 | C2 | OPEN |
| S01-I04无保护时段设置入口 | 保存合法block，允许purpose为空，各端可见 | [protected-create-cross-tab-20260913.md](../.omo/evidence/protected-create-cross-tab-20260913.md)实测S15共用创建路径：倒置拒绝、空用途保存、S02同block刷新；无意图创建仅领域/helper测试，S01空态入口本身仍待浏览器实测 | C2/C5 | OPEN |
| S01-S01无缺口；S02过期来源；S03未知容量 | 不编造缺口/空闲，旧数据保留并说明覆盖 | [time-surface-envelope-result.md](../.omo/evidence/time-surface-envelope-result.md)记录共享容量10/10测试；[plan-applicability-result.md](../.omo/evidence/plan-applicability-result.md)覆盖未知/受保护约束；S01无缺口、过期、未知三种实际UI尚未逐项验完 | C5 | OPEN |
| S01-AC01/02/03/04原四项 | 主对象、缺口、诚实文案、责任移动性逐条满足 | 静态已有内容不等于通过 | C1/C2/C5 | OPEN |

## s02 时间账本 · 责任与边界

原文D:26：“未同步不是空闲”；D:83–89算术；PRD s02。原图：`design/01_桌面大图/02_时间账本_责任与边界.png`。实现：`src/screens/s02-ledger/S02Ledger.tsx`。继承E-A；所需E-S02-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S02-L01双轨/越界阴影/来源/容量 | 保留轨道标签、超界10分钟、UTC+8与覆盖 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)的DN1SbdFe/BzU3qbLV补证记录真实track630px、保护卡top360px/height180px及19–20标签；双主题图存在，不代表全行1:1通过 | C1 | OPEN |
| S02-I01今日；I02本周 | 各自读取对应日期区间责任/保护，不只改变按钮样式 | [mobile-ledger-preflight-20260913.md](../.omo/evidence/mobile-ledger-preflight-20260913.md)实际由今日切本周，保留相同日期/意图/stable block定位；所有日期区间责任数据仍待逐项覆盖 | C2 | OPEN |
| S02-I03事件详情；I04冲突区域；I05可行方案 | 分别展示来源/状态、进入带冲突上下文方案 | [mobile-ledger-preflight-20260913.md](../.omo/evidence/mobile-ledger-preflight-20260913.md)已证明同block定位与非法日期上下文拒绝；事件详情、冲突区域、方案三入口仍需独立动作证据 | C2 | OPEN |
| S02-I06重新决定暂定计划；I07空轨手动记录 | 变更经预览/确认后持久化；固定事项不能自动移动 | 表单/键盘路径及回读待证 | C2/C5 | OPEN |
| S02-S01空轨；S02失败/过期；S03保护侵入 | 不伪造任务；未知不计空闲；拒绝自动填充 | [plan-applicability-result.md](../.omo/evidence/plan-applicability-result.md)有跨时区保护重叠拒绝/未知覆盖领域回归；[b-original-baseline-20260913.md](../.omo/evidence/b-original-baseline-20260913.md)实测延期后19–20保护仍在；空轨与存储/过期故障表面未由此证明 | C5 | OPEN |
| S02-AC01/02/03/04原四项 | 双轨、越界文字/阴影、未覆盖、不可自动填充分别验收 | 不以文案代替约束执行 | C1/C2/C5 | OPEN |

## s03 收件箱 · 请求不等于承诺

原文D:27及D:60–62：“用户确认是否接受→明确责任范围→再讨论截止时间和投入”；PRD s03。原图：`design/01_桌面大图/03_收件箱_请求不等于承诺.png`。实现：`src/screens/s03-inbox/S03Inbox.tsx`。继承E-A；所需E-S03-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S03-L01列表/原话/四字段/三阶段/排除发送说明 | 来源与未知字段按设计呈现 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)已归档S03双主题视口图且页面可渲染；长列表/所有编辑状态的逐区域1:1仍待证 | C1 | OPEN |
| S03-I01列表选择 | 选中项对应原话/来源/状态，刷新保留数据 | 每条请求待证 | C2 | OPEN |
| S03-I02接受 | 创建唯一commitment并进入范围/期限/投入讨论；s01/s02回读 | [egolite-inbox-accept-edit-green.md](../.omo/evidence/egolite-inbox-accept-edit-green.md)实测接受→刷新为本地责任，范围/25分钟/日期保存刷新，S02未排程责任仅一条；重复接受与存储故障UI仍未验 | C2/C5 | OPEN：正常UI链已证，异常未验 |
| S03-I03保留想法；I04排除 | 分别持久归档/排除，不进入容量、不发送 | [egolite-inbox-keep-idea-green.md](../.omo/evidence/egolite-inbox-keep-idea-green.md)保留想法→刷新仍已归档且未成为责任；[inbox-shared-result.md](../.omo/evidence/inbox-shared-result.md)排除不建责任/幂等仅领域与适配器测试，I04排除UI仍待证 | C2/C5 | OPEN：I03正常UI已证，I04/UI异常未验 |
| S03-I05范围/期限/投入补充；I06空列表记录 | 未知保持null；合法信息保存并更新容量 | [egolite-inbox-accept-edit-green.md](../.omo/evidence/egolite-inbox-accept-edit-green.md)已实测范围、投入与原生日期键盘编辑后刷新；未知保持空值；I06空列表录入与异常字段UI仍待证 | C2/C5 | OPEN |
| S03-S01空；S02未知；S03重复接受；S04保存失败 | 无假请求/假责任、重复不重复入账、失败可恢复 | [egolite-inbox-accept-edit-green.md](../.omo/evidence/egolite-inbox-accept-edit-green.md)已实测无效requestId拒绝替代；[inbox-shared-result.md](../.omo/evidence/inbox-shared-result.md)18项适配器/领域测试覆盖空/重复/校验/回读；真实存储失败与跨标签冲突UI未验 | C5 | OPEN |
| S03-AC01/02/03/04原四项 | 完整保留PRD原验收，不自动替本人承诺 | 历史内容证据未覆盖全链 | C1/C2/C5 | OPEN |

## s04 自适应方案 · 改变方法与分工

原文D:28：“估计、净减少与未来负担分开”；D:85–87 A/B算术；PRD s04。原图：`design/01_桌面大图/04_自适应方案_改变方法与分工.png`。实现：`src/screens/s04-plan/S04Plan.tsx`。继承E-A；所需E-S04-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S04-L01约束/A/B/投入说明/底部保留 | 全部说明含新估计包含检查与修改、未执行 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)有S04双主题视口图；[root-iab-closeout-20260913.md](../.omo/evidence/root-iab-closeout-20260913.md)与[b-original-baseline-20260913.md](../.omo/evidence/b-original-baseline-20260913.md)记录A/B正常链数值及批准前状态，仍不是完整逐区域1:1验收 | C1 | OPEN |
| S04-I01选择A | 持久选择plan A并预览对应change set | [root-iab-closeout-20260913.md](../.omo/evidence/root-iab-closeout-20260913.md)实测选择A→带intentId/kind的预览；[plan-closeout-result.md](../.omo/evidence/plan-closeout-result.md)记录共享plan/changeSet与实体绑定测试；不是仅navigate/无plan | C2 | OPEN：正常预览链已证 |
| S04-I02预览B | 独立延期diff/grants；未来债40，不触发草稿授权 | [b-original-baseline-20260913.md](../.omo/evidence/b-original-baseline-20260913.md)实测原始130/120状态准备B→延期专属预览→40分钟未来债→批准消费刷新；无草稿/外部变化声明，故障UI仍待证 | C2/C5 | OPEN：正常B链已证，异常未验 |
| S04-I03保留原计划 | 回s02、候选保留、原责任不变 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)未记录此入口的独立点击及返回后责任不变检查；不再以历史“未见入口”断言当前实现缺失 | C2 | OPEN |
| S04-S01无候选；S02来源失效；S03超估计 | 禁用有原因、重新算容量、撤回选择；不侵入保护 | [root-iab-closeout-20260913.md](../.omo/evidence/root-iab-closeout-20260913.md)实测local-only下未知B目标拒绝；[plan-applicability-result.md](../.omo/evidence/plan-applicability-result.md)领域7/7覆盖非法/未知/保护；无候选及超估计等实际UI仍待逐项验证 | C5 | OPEN |
| S04-AC01/02/03/04原四项 | A预计20、B负担40、无虚假节省、约束未执行 | 静态算术不足以通过执行路径 | C1/C2/C5 | OPEN |

## s05 变更预览 · 有限授权

原文D:29：“参数或计划变化使旧批准失效”；D:48–50、79；PRD s05。原图：`design/01_桌面大图/05_变更预览_有限授权.png`。实现：`src/screens/s05-preview/S05Preview.tsx`。继承E-A、GR2/GR6；所需E-S05-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S05-L01差异三列/版本/三许可三排除/范围 | 显示真实选定方案diff与hash绑定的版本 | [s05-s12-structure-closeout-20260913.md](../.omo/evidence/s05-s12-structure-closeout-20260913.md)已改真实三列表头/对齐；[b-original-baseline-20260913.md](../.omo/evidence/b-original-baseline-20260913.md)证明B专属延期内容；[RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)归档双主题截图，非全状态1:1通过 | C1/C2 | OPEN |
| S05-I01批准A | 有效批准→读取→本地草稿→回读→s06，未发送 | [root-iab-closeout-20260913.md](../.omo/evidence/root-iab-closeout-20260913.md)实测批准A→两节共享草稿→刷新同内容；[RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)记录S06实际编辑保存刷新；完整异常授权/回读失败表面仍待验 | C2/C5 | OPEN：完整关联链及故障表面收尾 |
| S05-I02批准B | 仅执行批准的延期并回读账本/未来债 | [b-original-baseline-20260913.md](../.omo/evidence/b-original-baseline-20260913.md)实测原始130→90/120、未来债40、批准消费刷新保持；仅本地fixture正常链，异常另验 | C2/C5 | VERIFIED正常链；异常仍分列 |
| S05-I03返回修改 | 候选不丢，修改后旧批准失效 | [plan-closeout-result.md](../.omo/evidence/plan-closeout-result.md)记录intent/kind/version绑定及失效适配器测试；所读允许浏览器证据未覆盖返回修改后旧批准拒绝，不再断言只有navigate | C2/C5 | OPEN |
| S05-S01非法直达；S02版本/材料变化；S03重复执行；S04超时未知 | 不默认授权、不重复副作用、未知先回读 | [rc-20260913/README.md](../.omo/evidence/rc-20260913/README.md)允许浏览器实测非法intent/kind拒绝且不替代实体；[plan-closeout-result.md](../.omo/evidence/plan-closeout-result.md)共享审批/操作/回读已接入；材料变化、重复执行、超时未知的完整UI故障表面仍待验 | C5 | OPEN：非法直达已证，其他异常未验 |
| S05-AC01/02/03/04原四项 | diff、同屏范围、版本追踪、单次授权逐条验收 | [root-iab-closeout-20260913.md](../.omo/evidence/root-iab-closeout-20260913.md)与[b-original-baseline-20260913.md](../.omo/evidence/b-original-baseline-20260913.md)已有真实批准/消费/刷新证据；历史固定不执行评语不能描述当前正常链，四项仍须按行完整验收 | C1/C2/C5 | OPEN |

## s06 协同工作台 · 有来源的草稿

原文D:30：“未核对成本不能伪装为结论”；D:70；PRD s06。原图：`design/01_桌面大图/06_协同工作台_有来源的草稿.png`。实现：`src/screens/s06-workspace/WorkspaceScreen.tsx`。继承E-B；所需E-S06-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S06-L01正文/比较表/来源/两个判断/缺成本/保存时间 | 渲染真实draft与未决项，fixture声明完整 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)实测同一操作草稿编辑/取消/重开/保存/刷新；1097×667跨列遮挡已真实pointer复验，正文换行另有006n2VN7补图；不再用硬编码草稿描述当前页，完整1:1仍待证 | C1/C2 | OPEN |
| S06-I01同意；I02不同判断 | 分别保存本人选择/异议，不同意不等于确认 | [RC8交互](../.omo/evidence/rc8-interactions-20260913.md)疑问文字折叠保留、显式提交、刷新持续已证；既有逐节确认领域/正常链证据分别保留，其他不同判断语义不整体继承 | C2 | VERIFIED所列疑问链；其他语义OPEN |
| S06-I03补材料 | 真实材料记录/引用与许可，上传失败可恢复 | [RC8交互](../.omo/evidence/rc8-interactions-20260913.md)材料名称/正文折叠重开保留；拒读提交后v1/关联节/未读取未应用未核实正确，刷新保持；既有16项材料领域测试含撤权拒绝。失败恢复仍独立验收 | C2/C5 | VERIFIED拒读登记正常链；失败恢复OPEN |
| S06-I04确认已检查部分 | 指定section确认，未核对保留；无需强制补完全部材料 | [flow01-and-postwrite-20260913.md](../.omo/evidence/flow01-and-postwrite-20260913.md)实际仅确认第一节、第二节成本仍未知，并通过同草稿检查点重开；[s06-exact-retry-green-20260913.md](../.omo/evidence/s06-exact-retry-green-20260913.md)实际编辑后确认失效且未知写入精确恢复。未继承所有材料撤权故障UI通过 | C2/C5 | OPEN：正常部分确认已证，其他来源故障待验 |
| S06-I05撤销；I06导出 | 实际撤销回执/可读导出件，包含未决状态 | [egolite-checkpoint-withdrawn-recheck-green.md](../.omo/evidence/egolite-checkpoint-withdrawn-recheck-green.md)证明已撤回草稿在S07只读核对且不恢复；不是撤销按钮本次点击证据。RC6已实际下载并读回[Tango Done&Go草稿JSON](../.omo/evidence/TangoDoneGo-draft-export-20260913.json)，含当前保存正文/来源/未决/未发送状态，不含其他草稿和材料正文 | C2 | OPEN：导出正常链已证，撤销点击及失败面仍待验 |
| S06-S01生成失败；S02来源变更；S03部分确认 | 保留旧草稿、失效受影响确认、不改sentAt | [domain-edit-section-result.md](../.omo/evidence/domain-edit-section-result.md)有版本/来源变更及失败commit不发布测试；[RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)有正常编辑保存刷新；生成失败、并发保存冲突、未知存储结果的当前UI仍待验 | C5 | OPEN |
| S06-AC01/02/03/04原四项 | 判断、未核对持续可见、不发送、来源与保存时间 | 不能以固定时间冒充自动保存 | C1/C2/C5 | OPEN |

## s07 工作现场 · 恢复下一步

原文D:31及D:54–56：“恢复真实检查点，不发明进度”；PRD s07。原图：`design/01_桌面大图/07_工作现场_恢复下一步.png`。实现：`src/screens/s07-session/SessionScreen.tsx`。继承E-B；所需E-S07-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S07-L01检查点/确认取舍/未决规则/材料 | 显示实际版本、savedAt与本人确认 | [iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)实测真实检查点nextStep/未决成本/附注刷新；[RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)有双主题图。历史保存值与当前状态分开，但完整1:1仍待验 | C1/C2 | OPEN |
| S07-I01查看规则差异 | 显示候选与当前规则；本人确认前无自动效果 | [iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)实测保存规则快照后S10恢复，S07显示保存时暂停/当前运行且不改历史；[capture-checkpoint-closeout-20260913.md](../.omo/evidence/capture-checkpoint-closeout-20260913.md)旧快照UNKNOWN/差异测试，非折叠布尔 | C2/C5 | OPEN |
| S07-I02口述；I03保存口述 | 真实音频转输入/失败退文字，保存原意 | [capture-checkpoint-closeout-20260913.md](../.omo/evidence/capture-checkpoint-closeout-20260913.md)已有显式SpeechRecognition/错误后备与渠道测试；[iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)仅文字附注保存刷新已实测，麦克风授权、真实口述和音频服务仍UNKNOWN | C2/C5 | OPEN |
| S07-I04材料链接；I05完整记录 | 可达实际草稿/材料/历史事件 | [workspace-domain-session-result.md](../.omo/evidence/workspace-domain-session-result.md)记录完整记录已改为真实draft/operation归属链接或明确不可用，历史preventDefault描述失效；[iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)有S06→精确检查点正向链接，I04/I05反向逐点击仍待证 | C2 | OPEN：链接实现已证，完整点击待证 |
| S07-I06继续；I07补材料；I08暂不处理 | 继续同draft判断、补材料到s06、暂不处理保存nextStep | [workspace-domain-checkpoint-ui-result.md](../.omo/evidence/workspace-domain-checkpoint-ui-result.md)记录同draft恢复/被撤回时只读边界；[egolite-checkpoint-withdrawn-recheck-green.md](../.omo/evidence/egolite-checkpoint-withdrawn-recheck-green.md)实际重核对保持撤回；继续、补材料、暂不处理三项正常UI仍需分别执行 | C2 | OPEN |
| S07-S01无检查点；S02来源版本变化；S03重开 | 空态无假进度；受影响确认复核，其余保留 | [rc-20260913/README.md](../.omo/evidence/rc-20260913/README.md)非法检查点直达拒绝；[egolite-checkpoint-withdrawn-recheck-green.md](../.omo/evidence/egolite-checkpoint-withdrawn-recheck-green.md)旧缺字段保持UNKNOWN；[iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)真实检查点/附注刷新已证，不再称checkpoint未实现，来源变更等故障UI仍待验 | C5 | OPEN |
| S07-AC01/02/03/04原四项 | 保存时间/确认、候选未生效、无假进度、口述可达 | 需真实恢复及交互证据 | C1/C2/C5 | OPEN |

## s08 静驻时刻 · 不安排也成立

原文D:32：“没选择不再催促”；D:95清晰退出；PRD s08。原图：`design/01_桌面大图/08_静驻时刻_不安排也成立.png`。实现：`src/screens/s08-stillness/StillnessScreen.tsx`及G2的Shell/route。继承E-B；所需E-S08-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S08-L01全屏/顶栏×/开放椭环/覆盖/页脚 | 隐藏普通导航，退出清楚，声明局部覆盖 | [RC5 S08瓷白图](../.omo/evidence/rc5-20260913/s08-porcelain.png)可见无普通导航、顶栏×与局部覆盖说明；[RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)归档双主题视口图，历史“仍Shell/无×”失效；可见结构不等于×点击或整体1:1通过 | C1/C2 | OPEN：结构截图已证，完整C1/动作待证 |
| S08-I01什么也不安排 | 保存suppressPrompts并关闭回来源，刷新/重进仍生效 | [quiet-cross-device-20260913.md](../.omo/evidence/quiet-cross-device-20260913.md)有退出覆盖keepStill的真实RED→新build GREEN：S08选择、S18退出、重进刷新仍保留；[protected-create-cross-tab-20260913.md](../.omo/evidence/protected-create-cross-tab-20260913.md)另有双标签更新与退出证明 | C2/C5 | OPEN：正常/已发现退出回归已证，完整故障未验 |
| S08-I02音乐 | 获准来源真实恢复或可读失败，不扰主体 | music-adapter及共享控制器已实现，14项测试含迟到完成；unknown保留requestId并仅回读，跨mount保留busy。[RC9实际按钮](../.omo/evidence/rc9-visual/README.md)返回notConnected且未发起播放；测试成功不等于真实provider或音频成功 | C2/C5 | 本地适配及局部验证完成；真实provider待接入 |
| S08-I03更多可能性及子入口 | 可达实际记录/保存片段功能，不自动创建责任 | [iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)记录实际文字保存→刷新→最近记录仅一条且未建责任；[RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)有最终候选双主题图；全部子入口/异常仍非一并通过 | C2 | OPEN：文字正常UI已证，其他子项待证 |
| S08-I04×退出 | 保存会话状态，回实际来源页 | [RC8交互附录](../.omo/evidence/rc8-interactions-20260913.md)S08自身×写后读失败停留/stillness并禁用音乐；恢复读取重试返回/且写入仍1次，探针已清理。既有S18跨页/跨tab证据分别保留 | C2/C5 | VERIFIED所列写后未知恢复；其他故障OPEN |
| S08-S01未选择；S02音乐失败；S03重开/新建议 | 无倒计时/催促；失败不打断；新建议不侵入时段 | [quiet-cross-device-20260913.md](../.omo/evidence/quiet-cross-device-20260913.md)新本地意图/提案/操作后keepStill仍在且无再次选择提示；不等于后台外部AI通知渠道。音乐失败与未知存储完整UI未验 | C5 | OPEN |
| S08-AC01/02/03/04原四项 | 无绩效、选择后不催促、退出与范围、时间与边界 | 行为与文案须同时验证 | C1/C2/C5 | OPEN |

## s09 注意力队列 · 同一份预算

原文D:33：“AI内部请求使用同一预算”；PRD s09。原图：`design/01_桌面大图/09_注意力队列_同一份预算.png`。实现：`src/screens/s09-attention/AttentionScreen.tsx`。继承E-B；所需E-S09-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S09-L01风险/期限/合并/静默/预算/规则 | 按来源依据和后果呈现，AI/付费无豁免 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)有双主题1920×1200图与真实渲染；[governance-ui-result.md](../.omo/evidence/governance-ui-result.md)共用队列/风险/预算适配器有测试，完整逐区/全状态视觉仍待证 | C1 | OPEN |
| S09-I01查看差异 | 到s06正确材料差异，不只展开示例说明 | RC10审计确认原实现没有关联引用及实际跳转，正在补受验证的可选草稿/节引用；无引用保留诚实降级 | C2 | GAP：修复进行中 |
| S09-I02修改提醒规则 | 到s10打扰规则并保存共同budget/ruleRevision | [governance-ui-result.md](../.omo/evidence/governance-ui-result.md)已接共享attention.budget及S10规则编辑；[domain-budget-closeout-result.md](../.omo/evidence/domain-budget-closeout-result.md)验证ruleset/预算原子版本、0–10校验与失败保留；非局部dailyMax，跨页点击/保存刷新仍待允许浏览器证据 | C2 | OPEN：领域/适配器已证，UI待证 |
| S09-I03合并重现；I04发现静默草稿 | 到时可见同一队列项，静默准备不扣提醒预算 | RC10审计确认原defer只保存dueAt，没有到期处理入口；正在补领域处理与本地触发，需验证原ID/预算/暂停/去重，不能由旧dueAt文字或route截图替代 | C2/C5 | GAP：到期修复中；其他组合OPEN |
| S09-S01预算0；S02无期限依据；S03空队列；S04日界线/重复投递 | 合并非紧急、风险有据、无假待办、投递去重 | [governance-ui-result.md](../.omo/evidence/governance-ui-result.md)27项适配器测试含空队列、无依据urgent、预算0及回读失败；[domain-budget-closeout-result.md](../.omo/evidence/domain-budget-closeout-result.md)有幂等/预算领域证据；真实日界线/重复投递UI仍待验 | C5 | OPEN |
| S09-AC01/02/03/04原四项 | 期限后果、AI静默、预算同屏、无例外通道 | 不能只验显示次数 | C1/C2/C5 | OPEN |

## s10 我的边界 · 权限与暂停

原文D:34：“模型不能自行扩大权限”；D:79撤销；PRD s10。原图：`design/01_桌面大图/10_我的边界_权限与暂停.png`。实现：`src/screens/s10-boundaries/BoundariesScreen.tsx`。继承E-B；所需E-S10-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S10-L01四分组/六权限/版本时间/暂停 | 完整分级说明与禁止付款，不只颜色 | [RC5及补充版本记录](../.omo/evidence/rc5-20260913/README.md)有S10双主题视口图；长页存在纵向内容，不代表全部分组/控件1:1或离屏动作通过 | C1 | OPEN |
| S10-I01行动；I02时间；I03打扰；I04暂停与退出 | 四组实际规则可读可改，读取同一ruleset | 各tab与下游效果待证 | C2 | OPEN |
| S10-I05修改许可；I06查看历史 | 预览差异→本人确认→新版本/历史，影响旧审批 | [governance-ui-result.md](../.omo/evidence/governance-ui-result.md)已有真实ruleset/history/双读回接线；[domain-budget-closeout-result.md](../.omo/evidence/domain-budget-closeout-result.md)验证规则版本与预算原子更新/审批失效；各许可及历史入口正常/冲突UI仍待证 | C2/C5 | OPEN |
| S10-I07立即暂停；I08恢复 | 持久暂停，阻止新自动化，按在途状态恢复/回读 | [iab-mobile-defer-pause-20260913.md](../.omo/evidence/iab-mobile-defer-pause-20260913.md)实测pauseEpoch0→1并刷新保留；[iab-quiet-note-share-20260913.md](../.omo/evidence/iab-quiet-note-share-20260913.md)实测显式恢复及S07旧规则对照；非paused局部state，在途自动化阻断/恢复异常UI仍未验 | C2/C5 | OPEN：暂停/恢复正常UI已证，在途异常未验 |
| S10-S01新权限建议；S02在途暂停；S03重开 | 不自扩权、不假撤销、不丢事项上下文 | [governance-ui-result.md](../.omo/evidence/governance-ui-result.md)有不自扩权、失败双读回、恢复不自动重放的适配器/领域证据；[iab-mobile-defer-pause-20260913.md](../.omo/evidence/iab-mobile-defer-pause-20260913.md)仅正常暂停刷新，不证明在途自动化被阻止 | C5 | OPEN |
| S10-AC01/02/03/04原四项 | 六许可、真实版本时间、一步暂停、不得推导付款 | 说明可见不等于暂停生效 | C1/C2/C5 | OPEN |

## s11 私人上下文 · 来源与推测

原文D:35：“推测不能升级为事实”；D:73、79；PRD s11。原图：`design/01_桌面大图/11_私人上下文_来源与推测.png`。实现：`src/screens/s11-context/S11Context.tsx`。继承E-C、GR5；所需E-S11-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S11-L01三层页签/意图/假设/来源/撤销导出 | 样本少与7天复查、未接入不等于空闲 | 无最终逐屏GREEN，视觉待证 | C1 | OPEN |
| S11-I01意图tab；I02事实tab；I03推测tab | 每层真实内容与空态，来源区分 | 各路径待证 | C2 | OPEN |
| S11-I04编辑意图；I05暂停；I06删除 | 持久修改影响后续方案，不清除不相关数据 | 业务动作及回读待证 | C2/C5 | OPEN |
| S11-I07大致成立；I08不准确；I09删除推测 | 本人明确表达与否定事件留痕；删除/否定后不再使用 | 已接共享contextReview；I08实际刷新通过，I07/I09及全部消费端待证 | C2/C5 | OPEN |
| S11-I10管理来源；I11导出记录 | 管理来源到`/boundaries`，作为头像进入私人上下文后的既有边界治理入口；导出实际可带走文件含来源与状态 | 导出产物未证；头像路由是实施约定，管理来源进入s10来自PRD s11交互 | C2 | OPEN |
| S11-S01空层；S02过期复查；S03撤销访问 | 不续期假设、不继续读取、外部副本不假收回 | 合同§6 | C5 | OPEN |
| S11-AC01/02/03/04原四项 | 本人意图、假设pill、未接入、撤销导出同屏 | GR5缺最终归档 | C1/C2/C5 | OPEN |

## s12 时间回顾 · 收益不做假账

原文D:36：“不能伪造净节省与人生评分”；D:87–91；PRD s12。原图：`design/01_桌面大图/12_时间回顾_收益不做假账.png`。实现：`src/screens/s12-review/S12Review.tsx`。继承E-C、GR5；所需E-S12-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S12-L01周图/保留/延期/监督/未测量/反馈 | 三类分列不合计省时，失败日如实显示 | fixture与真实汇总分别待证 | C1/C2 | OPEN |
| S12-I01本人确认回顾 | 持久确认具体周及记录版本，不预置已确认 | [review-observation-20260913.md](../.omo/evidence/review-observation-20260913.md)：实际确认周记录，再把观察0更正30，刷新显示需要重新确认；零与未知、明细/图/汇总一致。未覆盖存储失败 | C2/C5 | OPEN：正常确认失效已证，故障待验 |
| S12-I02保留明细；I03延期明细；I04监督明细 | 各行打开可追溯ledger entry及结果引用 | 点击明细待证 | C2 | OPEN |
| S12-I05更有掌控；I06差不多；I07反而更难；I08跳过 | 每项持久结果，跳过有效且不计评分/不催促 | I08已有实际刷新证据；[review-observation-20260913.md](../.omo/evidence/review-observation-20260913.md)新增其余3项分别保存、显式修改、刷新保持。未知写入/并发反馈未由正常链证明 | C2/C5 | OPEN：四种正常反馈已证，故障待验 |
| S12-S01空周；S02未保住；S03未清偿债；S04重复回读 | 不生成评分、不隐藏失败、不消债、不重复计功 | 合同§5 | C5 | OPEN |
| S12-AC01/02/03/04原四项 | 三行、未测量、周三失败、四反馈选项 | 真实数据变化下同样成立 | C1/C2/C5 | OPEN |

## s13 同步异常 · 未知与接管

原文D:37：“外部保护未核验就保持未知”；D:72、75、105；PRD s13。原图：`design/01_桌面大图/13_同步异常_未知与接管.png`。实现：`src/screens/s13-sync/S13Sync.tsx`。继承E-C、GR5；所需E-S13-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S13-L01本地有效/外部未知/四来源/三出路 | 各来源lastSuccessAt及覆盖来自真实状态 | 静态状态不得声称核验 | C1/C2 | OPEN |
| S13-I01重新同步核验 | adapter实际结果，幂等回读保护对象/失败日志 | 固定timer已移除；演示成功路径已实际执行，失败/超时和保护回读待证 | C2/C5 | OPEN |
| S13-I02原日历接管 | 有授权对象链接时打开；无链接明确理由 | 无有效链接的禁用理由已观察；有授权链接的跳转待证 | C2 | OPEN |
| S13-I03暂用本地计划 | 持久降级、全局未知区间不自动分配 | 共享持久化及S04未知延期拒绝已实测；其他分配入口仍待覆盖 | C2/C5 | OPEN |
| S13-S01成功；S02失败/过期；S03未知超时；S04重复重试 | 保留旧数据、明确结果、先查再重试、不重复事件 | fixture可控与真实账户证据分开 | C5 | OPEN |
| S13-AC01/02/03/04原四项 | 内外不同、无全保护、来源时间、幂等与未知约束 | 本地adapter完整验证；真实账户部分单列FLOW-11，不阻断本地AC | C1/C2/C5 | OPEN |

## s14 快捷输入 · 意图与约束

原文D:38：“输入一句话不等于泛化授权”；D:48、75；PRD s14。原图：`design/01_桌面大图/14_快捷输入_意图与约束.png`。实现：`src/screens/s14-capture/S14Capture.tsx`。继承E-C、GR1/GR5/GR6；所需E-S14-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S14-L01输入/两解析卡/两个动作/快捷键 | 真实输入派生意图与硬约束，保留无授权说明 | RC5双主题图及后续实际录入均存在，不再固定示例；全区域1:1仍待证 | C1/C2 | OPEN |
| S14-I01编辑原话；I02逐字段修正 | 改日期/时段/约束并验证；原话与修改同时保留 | 已接共享capture领域适配；[flow01-and-postwrite-20260913.md](../.omo/evidence/flow01-and-postwrite-20260913.md)新原文实际形成同意图链，字段所有异常未由该正常链证明 | C2/C5 | OPEN |
| S14-I03检查时段 | 真正执行CheckConflict，展示无冲突/冲突/未知，等待决定 | [stale-preview-rules-20260913.md](../.omo/evidence/stale-preview-rules-20260913.md)实测Meta+Enter触发真实冲突检查且未重复保存；全部无冲突/未知变体待证 | C2/C5 | OPEN |
| S14-I04只保存 | 持久保存当前输入的意图，不建日历、不发送 | [flow01-and-postwrite-20260913.md](../.omo/evidence/flow01-and-postwrite-20260913.md)及stale-preview记录真实新intentID、原文、日期和后续链接，非saved布尔。未知保存失败路径独立验收 | C2/C5 | OPEN |
| S14-I05ESC关闭；I06重开；I07⌘Enter | 未保存草稿关闭/重开/刷新不丢；快捷键与相同命令 | [stale-preview-rules-20260913.md](../.omo/evidence/stale-preview-rules-20260913.md)实际关闭面板/重开原文/快捷检查且intent数量不增；在途失败退出未由此覆盖 | C2/C5 | OPEN |
| S14-I08语音；I09分享入口 | 实际输入通过同一解析/授权边界；缺权限有后备 | 浏览器语音API及降级已实现；分享填入/保存/刷新恢复已实测，真实麦克风与OS分享面板未验 | C2 | OPEN |
| S14-S01空；S02非法日期；S03歧义；S04存储失败 | 不显示旧解析/假保存，不自动推导授权 | 已有capture-input/adapter/restore聚焦回归，历史固定解析缺实现描述失效；四种实际UI故障仍需各自证据 | C5 | OPEN |
| S14-AC01/02/03/04原四项 | 未建事件、未授改会、动作无外部变更、渠道同边界 | 必须改输入观察真实结果 | C1/C2/C5 | OPEN |

## s15 移动端 · 此刻

原文D:39：“不显示任务完成量作为中心”；D:95–97；PRD s15。原图：`design/02_移动端大图/15_移动端_此刻.png`。实现：`src/screens/s15-m-now/S15MNow.tsx`。继承E-C、GR5；所需E-S15-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S15-L01状态栏/品牌/椭环/时间卡/决定/约束/tab | 480×1040原图与字体放大，数据与s01同源 | 全屏视觉待GLM | C1 | OPEN |
| S15-I01时间卡 | 到账本同一block/日期，不丢意图 | DzbJGvDP构建Ego实点同intent/date/stable blockId到S02定位，周视图保留，错日期拒绝；mobile-ledger-preflight-20260913 | C2 | PASS |
| S15-I02查看两路径 | 到s16持久正确计划上下文 | navigate不等于状态链 | C2 | OPEN |
| S15-I03⋯；I04此刻tab；I05时间tab；I06协同tab；I07我的tab | 每项独立可达，与GLOBAL移动导航共用 | 不得以单一烟测覆盖全部 | C2 | OPEN |
| S15-I08设置保护时间；S01空/失败 | 合法区间保存、无用途可保留、未知不伪造容量 | 显式创建命令/共享表单已接；Ego倒置拒绝→空用途21–22保存→同block账本刷新已验；无意图/DST/unknown精确重试有11项测试，空库浏览器仍待验 | C2/C5 | OPEN |
| S15-AC01/02/03/04原四项 | 原四项完整逐条映射，不新增任务量中心 | GR5缺GREEN | C1/C2/C5 | OPEN |

## s16 移动端 · 自适应方案

原文D:40：“固定底部动作不能跳过批准”；PRD s16。原图：`design/02_移动端大图/16_移动端_自适应方案.png`。实现：`src/screens/s16-m-plan/S16MPlan.tsx`。继承E-C、GR5；所需E-S16-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S16-L01品牌/容量/A卡/B折叠/固定底部/声明 | 估计含检查，B收起不丢非净节省；不遮正文 | 原图1:1待证 | C1 | OPEN |
| S16-I01展开/选择A；I02展开/选择B | 保存选中方案，底部文案/目标跟随A或B | 共享准备命令及精确intentId/kind已接；内置浏览器展开B并生成独立预览已验 | C2 | OPEN：A及全部折叠重开待证 |
| S16-I03预览授权 | 仅到s17正确plan/revision/change set，不执行 | A/B参数与共享状态待证 | C2/C5 | OPEN |
| S16-I04⋯及四tab | 独立功能可达，使用GLOBAL导航逐项证据 | 每项未验证 | C2 | OPEN |
| S16-S01无候选；S02失效；S03估计超额 | 禁用理由、重新检查、返回容量不侵入静驻 | 合同§3–5 | C5 | OPEN |
| S16-AC01/02/03/04原四项 | 数字限定、B收起说明、只预览、字体放大不遮挡 | 最终真浏览器待证 | C1/C2/C5 | OPEN |

## s17 移动端 · 一次性授权

原文D:41：“不包含发送、改会与付款”；D:95排除项不能因小屏隐藏；PRD s17。原图：`design/02_移动端大图/17_移动端_一次性授权.png`。实现：`src/screens/s17-m-auth/S17MAuth.tsx`。继承E-C、GR2/GR3/GR4/GR5/GR6；所需E-S17-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S17-L01品牌/单授权卡/排除/底部动作/模式披露 | 与原图同结构，披露fixture/live；字体放大不遮排除项 | RC2已有模式披露与480×1040双主题截图；动态内容纵向延伸，字体放大待验 | C1 | OPEN |
| S17-I01读许可；I02草稿许可；I03估计许可 | 各许可影响实际change set/按钮/依赖，逐组合验证 | 全8组合领域执行归约与Ego真实预检已验；estimate-only及read+draft两组合实际执行/回读/刷新，未声称8次浏览器执行 | C2/C5 | OPEN：剩余故障与执行组合待验 |
| S17-I04批准 | 消费一次有效审批，生成获准产物并回读，部分许可不假草稿 | 已接批准/执行/回读/resultRefs；B与部分许可A实际回执和刷新禁用已验，非只used布尔 | C2/C5 | OPEN：其余组合与故障待验 |
| S17-I05返回修改；I06⋯与四tab | 返回保存候选，变化使旧批准失效；各导航真实可达 | 部分grant刷新状态待证 | C2 | OPEN |
| S17-S01全无许可；S02缺依赖；S03失效/直达；S04重复/超时 | 精确禁用理由、无越权、去重与unknown回读 | 非法kind/不存在intent无批准入口已验；部分许可缺read不创建草稿，消费态刷新禁用；[RC6](../.omo/evidence/rc6-closeout-20260913.md)实际未知写入后同运行时离开/返回，许可锁定，精确重试仅1批准/1操作/1草稿。完整浏览器重启的未确认命令恢复不在现有保证内 | C5 | OPEN：同运行时unknown已证，其余场景分项待验 |
| S17-AC01/02/03/04原四项 | 范围同屏、真实版本未执行、单次、排除完整 | 全部原AC继续有效 | C1/C2/C5 | OPEN |

## s18 移动端 · 静驻时刻

原文D:42：“无绩效、打卡与倒计时压力”；D:95清晰退出；PRD s18。原图：`design/02_移动端大图/18_移动端_静驻时刻.png`。实现：`src/screens/s18-m-stillness/S18MStillness.tsx`。继承E-C、GR5；所需E-S18-*。

| ID/功能 | 真实交互/持久结果 | 缺口或待证 | C | 状态 |
|---|---|---|---|---|
| S18-L01状态栏/品牌×/开放椭环/时间/唯一主动作/范围 | 隐藏tab，保留退出，原图1:1 | 逐区待GLM浏览器证据 | C1 | OPEN |
| S18-I01什么也不安排 | 持久keepStill/suppressPrompts，关闭回来源 | 新Ego证据S08选择→S18同block已保留；关闭→重入刷新保持；新本地A方案/操作后仍保留 | C2/C5 | OPEN：全部故障态待验 |
| S18-I02× | 保存状态后回实际来源屏，后备移动首页 | 实际保留ledger查询返回，quiet循环目标拒绝；修复退出覆盖keepStill及跨tab缓存核验问题，双页无刷新同步→关闭已验 | C2/C5 | OPEN：存储失败UI仍待验 |
| S18-S01未选择；S02刷新/跨屏；S03新建议；S04保存失败 | 不催促/不填充，不虚报已保存，安静状态保留 | 合同§8 | C5 | OPEN |
| S18-AC01/02/03/04原四项 | 唯一主动作、无压力、退出、覆盖声明 | 行为与文案均要验证 | C1/C2/C5 | OPEN |

## 必须单独执行的跨屏与非法路径

设计出处D:48–50、54–62、68–79、85–89；实现合同§2–8。以下均需独立E-FLOW-*、存储结果/回执、浏览器过程及最终状态；默认OPEN，不继承任何单屏历史通过。

| ID/流程 | 输入及关键可观察结果 | 对应用户C | 状态 |
|---|---|---|---|
| FLOW-01 A闭环 | s14改输入保存→s01/s02同意图→s04 A→s05授权→实际s06草稿→部分确认→s07重开→s02/s12账本→s08不安排并刷新 | C2/C5 | OPEN |
| FLOW-02 B闭环 | s04/s16选择B→正确延期diff/授权→责任日期改变→今日90/120、未来债40→重开仍欠债；无草稿与省时假账 | C2/C5 | VERIFIED正常链：b-original-baseline-20260913.md；故障不并入本结论 |
| FLOW-03责任形成 | s03接受唯一请求→scope/期限/投入→首页/账本；重复接受同commitment；保留/排除不入容量、不发送 | C2/C5 | OPEN |
| FLOW-04授权失效 | 选方案后分别修改材料、对象、计划、来源、规则版本→旧审批不能执行；返回保留候选→重新批准 | C2/C5 | OPEN |
| FLOW-05去重/未知 | 双击/双标签/刷新重试→单operation；超时可能已执行→unknown先回读，不重复副作用；账本不重复 | C2/C5 | OPEN |
| FLOW-06暂停/预算 | s10暂停→阻止新自动步骤/提醒，保留事项；在途未知不假撤销；恢复重新校验；AI与外部共预算 | C2/C5 | OPEN |
| FLOW-07来源降级 | s13同步失败保留快照→s01/s02未知容量→审批失效；暂本地不分配未知区间；真实来源恢复后重新核验 | C2/C5 | OPEN |
| FLOW-08私人上下文 | s11否定推测→刷新/方案生成不再套用；改意图/撤销源影响规则/审批；导出实际文件可读 | C2/C5 | OPEN |
| FLOW-09跨端保留空白 | s08不安排→s18同block抑制提示→刷新/新AI建议不催促、不填入；明确本人修改才更新 | C2/C5 | VERIFIED本地正常链、跨页关闭、新本地方案执行；quiet-cross-device与protected-create-cross-tab证据。外部后台通知/unknown故障未包含 |
| FLOW-10空错非法 | 各实体空数据、输入非法/歧义、存储失败、来源旧版、无候选直达授权、部分许可缺依赖→具体原因和恢复路径 | C2/C5 | OPEN |
| FLOW-11真实账户（独立外部验证项） | 已获具体系统/账户/对象/动作授权后真实同步/执行/回读；否则不连接且明确未验证；本地adapter成功/失败/未连接合同仍须完整验证 | C2/C4/C5扩展 | BLOCKED：未确认具体授权；不阻断本地验收 |
| FLOW-12公开发布（独立授权项） | 获准部署目标实际构建/部署/运行/错误记录及撤回方案；本地结果不能写成已公开上线 | C1/C2/C4/C5扩展 | UNKNOWN：发布条件未确认；不阻断本地验收 |

## 收口规则与交接

### 在途修复证据索引（不关闭验收）

当前整合所有权：`domain_finish`负责`src/domain/**`；`src/data/**`独占由主控监督的 GLM 持久化任务负责。`functional_finalize`负责s05/s14/s17；`workspace_integrate`负责s06和`src/runtime/**`。用户新增的品牌、后台 LLM 与风格切换见 `docs/SETTINGS-AND-INK-ADDENDUM.md`：后台设置、水墨主题分别由独立 GLM 实现任务负责，互不修改业务所有者文件。实现进展以 `.omo/evidence/*-final-implementation-glm.jsonl` 和各所有者最终报告为准，不把易过期的进程号当作完成证据。工作台使用`createPersistedDomainStore`、`useDomainState`、`Operation.resultRefs`和`confirmSections/saveCheckpoint`；正文编辑/撤回由领域所有者补齐。现有私有storage key仅为过渡，不能通过复制草稿到另一key关闭FLOW-01。各页只在统一`store.execute`成功后发布已保存/已批准状态；真正跨tab原子性及存储失败仍需独立证据。

2026-09-12 最新浏览器约束覆盖本文件较早的执行方式：浏览器验证只能使用 Codex 内置浏览器或 Ego Lite，不能运行独立 Playwright/Chromium、gstack 或其他浏览器。实现任务只做明确列出的非浏览器检查，主控统一使用 Ego Lite TaskSpace 1 完成页面验收。现有浏览器测试文件可以作为用例参考，但不得直接执行；历史结果与新约束下的实际验证分开记录。主控已在 Ego Lite 确认 `/settings` 尚未挂载、前端仍有旧英文品牌，截图为 `.omo/evidence/egolite-settings-red.png`；这是新增 B1/B2 的失败基线，不是完成证明。

新增 B1–B5 当前均为 IN PROGRESS，未验收：前端 Tango Done&Go 品牌、后台真实模型测试与密钥边界、实际草稿助手接入、默认/水墨风格跨屏持久切换、生产及浏览器验证。默认风格继续按附件 C1 验收；水墨风按用户新增视觉约束验收，不能把主题差异误判成默认风格已对齐。

接线注意：`Operation.resultRefs`实际类型是`EntityId[]`，不是含`draftId`的对象；须选择存在于`state.drafts`且`draft.operationId`匹配本操作的唯一ID，导航`/workspace?draftId=...&operationId=...`。旧实现创建空resultRefs而未填充，领域所有者须补齐，类型存在不证明运行结果可用。runtime采用实际导出类型统一（hook成功分支为`ready.runtime.store`），不为对象嵌套形式另建第二store。失败初始化应可重试；并行重试不能删除另一重试创建的新缓存而生成多个store，这一静态风险需运行反例验证。

下列为执行者回传的本轮证据入口；本任务尚未逐项重跑，主监督尚未独立验收。上方源码缺口行记录的是规划/历史基线，不能当作改动后代码的重新断言；只有最终差异与同案例证据复核后才更新为通过。

| 工作项 | 执行者报告的实际进展 | 证据入口与剩余门槛 |
|---|---|---|
| s05/s14/s17 第一轮 | 30次行为测试：RED为28失败/2通过，修复后30通过；不是完整跨屏验证 | `.omo/evidence/gate-functional-red.log`、`gate-functional-result.md`；刷新、部分许可、存储失败和旧草稿隔离仍需下轮证据 |
| s05/s14/s17 针对性修正 | 13用例×两项目，RED为22失败/4已有通过，命令退出1；尚待GREEN | `.omo/evidence/gate-functional-delta-red.log`；运行项目包含强制桌面视口，不能计真实移动适配通过 |
| Shell 修正 | 首轮局部绿测未验收；复核发现短视口头像不可达及40px触控目标、重复coverage | `.omo/evidence/shell-glm-review-execution.jsonl`；短屏真实RED已报告，需最终GREEN和原图对照；首轮被清理的RED PNG明确缺失，不补造 |
| 共享领域/存储 | 12项注入内存存储测试通过，未证明跨tab原子性、未有该层先行RED | `.omo/evidence/domain-api.md`、`domain-supervisor-feedback.md`；API仍PLANNED，默认seed与真正并发安全阻断接入 |

### 2026-09-12 主监督浏览器失败基线

来源：主监督任务 `01a08e6a-0de2-7393-8bb2-df4081482b8f` 的实际 Codex 内置浏览器操作回执；本任务收到并记录，未冒称自己重复执行。环境为本仓库 Vite `http://127.0.0.1:5199`，服务属于主监督 `exec session5334`，执行者不得自行关闭或重启。

- 场景 `E-S05-I01-BASELINE` / `FLOW-01`：首页“看看可行的做法” → `/plan` 选择 A → `/preview` 点击“批准并准备草稿”。实际仍停在 `/preview`，仅显示“已批准·本次准备任务 尚未执行”，未得到可观察本地产物。C2：FAIL。
- 场景 `E-S05-S03-RELOAD-BASELINE`：上述批准后 reload，回到待批准且批准按钮重新出现，审批/产物没有恢复。C5：FAIL；不能用重新显示按钮证明幂等执行。
- 同次 walkthrough 的 console error/warn 为空，仅支持该操作路径的控制台观察，不关闭产品 C4 或抵消功能失败。主监督已归档[人工 CUA 操作日志](<archived-local-host>/Proj/AIGC/research/output/argus-omo-control-plane/TANGO-V2-BROWSER-BASELINE-20260912.md)，本任务已全文读取；它不是自动 trace，未保存观察时源码 hash。截图仅在监督任务中 inline 显示，没有 PNG 文件，不能虚构截图路径或计为逐屏视觉通过。
- 修复后的同案例必须证明：有效批准 → 真实本地产物及回读 → 刷新恢复同一操作/产物 → 重复请求不重复生成；保存对应该运行版本的浏览器操作、截图及持久结果，再关闭上述失败。

### 主监督 09:23 UTC 局部复测与跨屏失败

同一[CUA 日志](<archived-local-host>/Proj/AIGC/research/output/argus-omo-control-plane/TANGO-V2-BROWSER-BASELINE-20260912.md)新增实测：`/preview` 批准后出现可编辑草稿，修改为指定验收文本后 reload 及新 tab 均恢复相同正文和已批准状态。原 `E-S05-I01-BASELINE` 的“无草稿”症状和 `E-S05-S03-RELOAD-BASELINE` 的“刷新丢状态”症状，在该快照的正常存储场景关闭；这不等于整个 S05-I01、C2/C5 或幂等/存储故障通过。

新 tab 的 warning/error 为空；旧 tab 的 HMR 错误保留在日志中，未作为干净会话。点击“协同”进入 `/workspace` 后仍显示另一份固定示例正文与17:21保存时间，没有延续刚修改的产物：`FLOW-01` 共享草稿连续性仍为 FAIL。未执行存储故障注入或并发批准；截图未导出PNG。该日志保留09:23:34 UTC的 S05Preview/localDraft/WorkspaceScreen 三个源码 SHA256，后续变更需复核，不能沿用局部通过证明新版本。

### 在途存储集成风险（主监督静态发现，待运行复现）

主监督报告当前 S05 `approvePlan` 先设置 approved，随后 effect 调用 `writeStored` 且忽略失败；`localDraft.ts` 先更新 memoryStore 再尝试 localStorage。由此推断存储失败可能仍显示批准/草稿成功，并在刷新后丢失。本条属于静态集成风险，尚非故障注入或浏览器复现证据，关联 `GLOBAL-S02`、`S05-I01`、`FLOW-05`、`FLOW-10`。功能及领域执行者已收到同一修复要求：失败不得发布成功状态或消费批准；保留编辑并说明原因；重试回读同一 operation；最终 S05/S17 通过统一事务命令入口，不能以各自 storage key 作为两个业务真相。关闭需要对应故障注入 RED/GREEN 与刷新结果。

本矩阵没有PASS行。GLM接手先核对用户指定模型及最新代码/图像，再按实施合同G0–G7分组推进；每个功能行落实到独立用例与证据，不得因为原测试跳过或图像为静态附件而免除。最新源码修复已有GAP后，先标“已实现未验证”，只有实际对应表面验证后才能标VERIFIED。发现新控件/新状态必须追加，不把它们排除出总清单。

C1需要全部18屏最终版本真实浏览器对照；C2需要全部本地功能与跨屏真实结果以及adapter诚实边界；C3要求本矩阵本地行有实现/用例/证据，外部行有明确授权/未验证状态；C4需要GLM实际构建和console；C5需要上述空错非法与不安排回归。GLM执行验证后，由原生/主监督独立只读验收。外部条件缺失单列BLOCKED/UNKNOWN，保留需求和授权边界，不无限阻断本地交付；完整本地证据可支持“上线级本地交付完成”，不能包装成真实账户实测完成或已公开上线。历史gate的REJECT只有对应本地缺口全部修复并经新证据复核才能关闭。
