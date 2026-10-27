# S2D-W3 · Mission 状态机与 Grants 计划

> 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w3-mission`
> 分支基线：`feat/s2d-w3-mission @ 60fdc734f73438443dd3f2fd35892abad15c91e4`
> W0 冻结：`b9d9bdfa0511905a95b729753b82e5734adab6bb`

## 1. 输入与不可变边界

- PRD 的 Mission/Contract/Grant 定义与生命周期：`PRD.md:159-212`、`PRD.md:277-282`、`PRD.md:591-638`。
- PRD 的状态机、签约与运行恢复约束：`PRD.md:182-198`、`PRD.md:838-852`。
- W3 责任边界：`CTO-BATCH2-BRIEF-2026-10-27.md:24-41`；验收重点为生命周期、失效、过期、暂停、取消可回放：`CTO-DECISIONS-2026-10-27.md:60-73`。
- 实施约束：TDD、单测覆盖率 ≥80%、不新增依赖、服务导出 `createXxxRoutes` 而不挂 `serve-tango`：`BUILD-PLAN.md:31-66`、`BUILD-PLAN.md:68-80`。
- W0 schema/README/FROZEN 只读输入；W3 只做运行时 adapter/service，不改 `contracts/agentic/**`：`contracts/agentic/FROZEN:1`、`contracts/agentic/README.md:1-8`、`contracts/agentic/README.md:55-74`。
- 现有 W0 `mission` schema 将状态枚举固定在 `mission.schema.json:16-19`，Grant 状态枚举固定在 `grant.schema.json:86-95`；`actor`、`contractHash`、`expiresAt` 等字段是持久化授权边界，不能另造语义。

## 2. 契约映射与负面路径（先于编码）

### Mission

- `draft → scanned → previewed ⇄ discussing → contracted → prepping → live → reviewing → delivered`。
- 旁路：`blocked`（必须有 need 原因）、`paused`、`cancelled`、`failed`、`expired`。
- 拒绝：无所属 owner、错误 revision/重复 command、缺少 scan/preview/contract、合同 hash 不匹配、窗口已过、从终态恢复、合同自治超出 A1–A3、A4/A5 试图进入默认合同，均 fail closed 并写审计/事件。
- 规则：签约前只允许已授权只读低成本 scan/preview；窗口开始前未签约不得自动启动；暂停恢复必须重新校验合同 hash；删除/改期导致在途执行暂停并保留“保留产出/一起删除”决策。

### Grant

- `proposed → active → consumed | revoked | expired | invalidated`。
- 发放绑定 `ownerId + actor + contractHash + capabilities + dataDisclosure + expiresAt`；actor 必须显式存在，`resolved_model = NULL` 的上游 provenance 不能被 W3 视为完成条件。
- `proposed` 不可授权工具调用；`active` 每次调用校验能力、scope/数据披露、合同 hash、窗口、预算和状态；`consumed/revoked/expired/invalidated` 一律拒绝。
- 合同任一字段变化生成新版本并立即使旧 Grant `invalidated`，关联在途 Run 在检查点暂停并回到确认态；撤权/暂停在检查点生效，外部写入走 unknown 对账而不重做。
- A4 永远逐次确认；A5 永不自动执行。W3 提供拒绝结果/事件 seam，不把确认实现偷偷并入 W3。

## 3. DAG

```text
M1 契约映射 + 负面路径表 + API/事件边界
 ├── M2 SQLite migration 与 owner/revision/idempotency 持久化边界
 ├── M3 Mission 纯状态转移/重放内核
 └── M4 Grant 生命周期/能力判定内核
       └── M5 Mission service + Grant service + createMissionRoutes harness
             └── M6 TDD 单测、拒绝/重复/超时/断线/恢复/幂等/owner 隔离/回放
                   └── M7 覆盖率、契约一致性、门禁证据与报告
```

M2、M3、M4 可在 M1 完成后并行；M5 等待三者；M6 等待 M5；M7 等待全部测试与门禁。

## 4. 模块计划

1. **M1 contract-map-negative-paths**：落地状态转移表、命令/事件/错误码映射、A4/A5 与合同变更失效规则；为每条允许边和拒绝边写测试用例清单。
2. **M2 mission-persistence**：新增 `scripts/agentic/db/migrations/mission-*.sql`；定义带 `owner_id`、revision、时间戳、软删除/状态事件、Grant 绑定和幂等键的最小表边界；使用 W0 DB 迁移器，不改 W0 schema。
3. **M3 mission-state-machine**：纯函数校验 transition、前置条件、终态/旁路、窗口过期、暂停恢复 hash 校验和事件重放；返回结构化拒绝，不吞并发冲突。
4. **M4 grant-lifecycle**：实现 propose/activate/check/consume/revoke/expire/invalidate；校验 owner、actor、contractHash、capability、resource scope、dataDisclosure、expiresAt、窗口和预算；合同变更原子失效旧 Grant。
5. **M5 mission-service-routes**：服务层读写 mission/grant/event/idempotency；owner 过滤；命令幂等重放返回原结果，冲突返回 W0 `CONFLICT`；导出 `createMissionRoutes({ db, auth, ... })`，仅供测试 harness 挂载。
6. **M6 mission-grant-tests**：先测后码覆盖合法与拒绝转移、重复/并发、过期、撤权、合同变化、暂停恢复、服务断线后重放、进程恢复、owner 隔离、A4/A5 fail closed、未知 actor/model 不得通过；新增模块 line/branch/function 均 ≥80%。
7. **M7 gates-evidence**：运行本流单测/覆盖率、`npm run test:unit`、`npm run verify:web`（不改发布清单）；检查文件归属、W0 冻结未变、工作树与 HEAD；写节点证据和最终报告，明确 npm lock 失败/已知基线失败/未验证项，不把 UNKNOWN 写成通过。

## 5. 跨流接口

- W1 Block 只通过服务输入/adapter 传入 `blockId`、owner、revision；不修改 W1 DTO。
- W2 Run/engine 通过事件接口消费 Mission/Grant 检查结果；W3 不改 `scripts/agentic/engine/**`。
- W4 消费 `checkGrant`/拒绝码/审计事件；A4 确认由 W4 接缝实现。
- W6/W11 只消费 Mission 状态和 Preview 引用；不把 timeline 字段写入 W0 Preview schema。
- W10 消费带 actor/model provenance 的事件；W3 不以缓存摘要替代运行证据。

## 6. 计划门禁

- 先测试后实现；不新增依赖；不读 `.env`、不打印/落盘密钥；不碰主仓、classic、生产、thinkpad、LiteLLM。
- 仅修改 `scripts/agentic/mission/**`、`scripts/agentic/db/migrations/mission-*.sql`、`tests/unit/agentic/mission/**` 与本计划/证据文件。
- 完成后报告精确命令、退出码、覆盖率、测试计数、当前 HEAD、冻结基线、未决 UNKNOWN、模型 provenance 与跨流 seam。
