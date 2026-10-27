# S2D-W4 A0–A5 自主性边界计划 DAG

> 规划输入：PRD v0.2、BUILD-PLAN、CTO 决策与批次二简报、prototype.html；本文件只规划 W4 自有文件域，不改 W0 冻结 schema。
> 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy`；分支：`feat/s2d-w4-autonomy`；基线：W0 `60fdc73`，冻结契约 `b9d9bdfa0511905a95b729753b82e5734adab6bb`。

## 1. 约束与契约映射

- PRD §4.3（PRD.md:200-212）：A0 只记录、A1 建议、A2 准备、A3 可逆代办、A4 有外部后果且逐次确认、A5 涉及金钱/法律且永不自动；合同默认值只能到 A3。
- PRD §8.1–§8.4（PRD.md:591-638）：执行器只认规范化 Contract；系统默认 `wont` 不可删除；每次工具调用均须校验 capability/scope、披露、预算、时间窗、自治等级与全局禁止规则；Grant/A3+ 动作/外部写入须审计；撤权或暂停后不得重做未知外部动作。
- PRD §4.2、§6.3（PRD.md:182-212、359-373）：`contracted` 前无外部副作用；合同变化使 Grant 失效；检查点恢复不得重复已完成外部动作；范围或 DoD 变化超阈值必须 Need。
- PRD §10.4–§10.6（PRD.md:779-812）：确认入口为 A4 action confirm，Run pause/resume/cancel 与活动/trace 分离；审计/活动必须能回答做了什么、为什么、产出在哪。
- BUILD-PLAN §2.1/§2.3/§2.4（BUILD-PLAN.md:33-80）：W4 只能新增/修改 `scripts/agentic/autonomy/**`、`scripts/agentic/db/migrations/autonomy-*.sql`、`tests/unit/agentic/autonomy/**`；Node ESM、零新增依赖、TDD、覆盖率 ≥80%。
- CTO 决策 §2.3、§4、§5（CTO-DECISIONS-2026-10-27.md:30-40、60-84）：P0 无外部副作用、A4 显式确认、A5 永不自动；跨流只能通过 adapter/projection/事件接口；未知证据保持 UNKNOWN。
- 批次二简报 §3–§5（CTO-BATCH2-BRIEF-2026-10-27.md:24-59）：W4 负责观察/建议/确认/执行/回滚边界、P0 封锁、审计与 fail-closed；先契约映射/负面路径，测试拒绝/重复/超时/断线/恢复；所有 actor 显式绑定模型。
- prototype.html（prototype.html:198-217、223-228）：交互阶段是“说→看→定→交”，块抽屉含预演/边界/进行中/交付物/追踪；W4 只提供边界与状态事件，不改前端接入。
- W0 现有冻结对象保持原语义：`contract.schema.json:133-139` 仅 A1–A3，`mission.schema.json:21` 可表达 A0–A5；W4 用运行时策略与事件接口表达 A4/A5，不改 `contracts/agentic/**`。

## 2. 负面路径先行（实现前必须固化为测试）

1. 未签约、缺 Contract/Grant、合同 hash 不匹配、过期或撤销：拒绝并写审计；不调用外部动作。
2. A0/A1 请求写入、执行或超出观察/建议能力：拒绝；A2/A3 仅允许合同和能力 Grant 范围内动作。
3. A4 无一次性确认、重复确认、确认过期、确认绑定的 action/actor/model/hash 不一致：fail-closed 拒绝；不把确认升级为长期授权。
4. A5 付款、下单、签约、生产修改等请求：永远拒绝自动执行，只返回可供用户在原工具完成的准备结果；本批不接外部副作用。
5. 审计落库失败、actor/model 缺失或 `resolved_model=NULL`、未知外部结果：fail-closed，状态为 UNKNOWN/blocked，不得报告成功，不得重做。
6. 重复事件、重复请求、超时、客户端断线、进程恢复、暂停/撤权/合同变更：以幂等键和检查点去重；恢复前重新校验合同 hash、Grant 与模型绑定。
7. 请求试图删除默认 `wont`、扩大 scope、跨 owner 或越出 worktree：拒绝并审计；不静默降级或覆盖。

## 3. DAG（组号越小越先；同组可并行）

| 模块 | 内容与产出 | 前置 | 文件归属 | 组 |
|---|---|---|---|---:|
| M01-contract-map | 固化 PRD/W0/CTO 字段映射、A0–A5 判定表、事件边界与上述负面路径；定义 UNKNOWN/blocked 语义 | — | `.s2d/plan.md`、测试用例设计 | 1 |
| M02-autonomy-types | A0–A5、动作风险、P0 禁止项、Actor/Model provenance、decision/result 错误码的纯类型与规范化函数 | M01 | `scripts/agentic/autonomy/**` | 2 |
| M03-policy-evaluator | 每次动作的合同/Grant/scope/data/window/budget/autonomy/owner 校验；A4 转逐次确认、A5 永久拒绝；默认 deny | M02 | `scripts/agentic/autonomy/**` | 3 |
| M04-confirmation-gate | 一次性 A4 confirmation 的签发、消费、绑定与过期；拒绝重复/错 actor/错模型/错 hash；不产生长期 Grant | M02,M03 | `scripts/agentic/autonomy/**` | 3 |
| M05-side-effect-fence | P0 外部副作用封锁与 A5 hard-stop；区分只读/建议/可逆/外部后果；产出可审计的 blocked/needs-human 结果 | M02,M03 | `scripts/agentic/autonomy/**` | 3 |
| M06-audit-fail-closed | Grant 发放/消费/撤销、策略拒绝、确认、A3+动作、UNKNOWN/恢复事件的审计事件；审计写入失败阻断动作 | M02,M03 | `scripts/agentic/autonomy/**`、`autonomy-*.sql` | 3 |
| M07-idempotency-recovery | action/event 幂等键、检查点与状态转换；处理重复、超时、断线、暂停、撤权、合同变更和恢复；未知外部结果不重做 | M03,M04,M05,M06 | `scripts/agentic/autonomy/**`、`autonomy-*.sql` | 4 |
| M08-actor-model-boundary | 显式 actor→resolved model 校验与 provenance；NULL/缺失模型标 UNKNOWN 并禁止完成结论；跨流以事件接口输入 | M02,M06 | `scripts/agentic/autonomy/**` | 4 |
| M09-route-harness | 导出 `createAutonomyRoutes`/纯服务入口，串联策略、确认、审计、幂等与恢复；不挂 `serve-tango`，不执行真实外部动作 | M04,M05,M06,M07,M08 | `scripts/agentic/autonomy/**` | 5 |
| M10-unit-negative-tests | TDD 单测：A0–A5、拒绝/越权/重复/过期/审计失败/超时/断线/恢复/幂等/UNKNOWN/owner 隔离；契约样例只经 W0 校验器 | M02–M09 | `tests/unit/agentic/autonomy/**` | 6 |
| M11-coverage-and-gates | 执行本流覆盖率与门禁；记录精确命令、rc、覆盖率、依赖与未决 UNKNOWN；只读检查文件归属和冻结 schema 未改 | M10 | `.s2d/plan.md`、外部证据/报告 | 7 |

## 4. 完成门

- 仅修改 W4 文件归属；不改 `contracts/agentic/**`、W0 schema、`serve-tango`、生产/主仓或 `.env`。
- 先红后绿：本流测试先失败，再实现；单测覆盖率 ≥80%。测试必须覆盖拒绝、重复、超时、断线、恢复和幂等。
- 所有实际 actor 显式模型；`resolved_model=NULL` 只能是 UNKNOWN，不能作为通过或完成。
- P0 无外部副作用；A4 每次独立确认；A5 不自动执行；审计失败、策略不确定或外部结果未知均 fail-closed。
- npm 安装事实：`npm ci --prefix '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy'` 运行结果 rc=1，报 `Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`；此基线 lock 漂移待报告，不新增依赖或修改 lock 作为本计划内容。
