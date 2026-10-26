# S2D-W2 M5 实现记录：outbox

日期：2026-10-26
模块：outbox（组 2）

## 依据与范围

- `.s2d/plan.md:103-110` 定义 W2 的 outbox 状态链与安全门禁；`.s2d/plan.md:177-183` 的 M5 subtasks 要求稳定 action key 幂等登记、读回核验、unknown 对账、崩溃点恢复。
- `tests/unit/agentic/engine/outbox.test.mjs:34-180` 是本模块先行测试契约，共 7 个测试，覆盖 register/dispatch/reconcile/recover。
- 只修改本模块归属文件：`scripts/agentic/engine/outbox.mjs` 与 `scripts/agentic/db/migrations/engine-003-outbox.sql`。未修改 serve-tango、build-web、发布清单或其他工作区。

## 实现摘要

- `engine-003-outbox.sql:1-16` 创建 `outbox` 持久表及 status/run 索引；status 包含 registered、dispatched、verified、unknown、failed、cancelled，保留 `external_id`、attempts、receipt、manual。
- `outbox.mjs:14-28` 通过 `action_key` 唯一约束和稳定 external_id 实现登记幂等。
- `outbox.mjs:31-83` 仅 registered/failed 可发；发送前落 dispatched。preSend 错误落 failed 可重试；其他发送错误落 unknown；发送成功必须经过 verify({externalId,...}) 返回 ok=true 才落 verified，否则保持 unknown。
- `outbox.mjs:85-101` unknown 只调用 probe，使用原 external_id；查不明时保持 unknown 并标记 manual=1。
- `outbox.mjs:103-133` recover 分别处理 registered、dispatched 和 unknown：dispatched 只补 verify，unknown 只 probe，禁止盲目 resend；支持已取消 run 的 registered 项转 cancelled。

## 验证（本 ask 实际执行）

1. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage tests/unit/agentic/engine/outbox.test.mjs`
   - 退出码 0；7 tests、7 pass、0 fail。
   - coverage：`outbox.mjs` line 93.23%、branch 68.18%、functions 86.67%；本模块行覆盖率达到 ≥80%。
2. `cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --check scripts/agentic/engine/outbox.mjs && node --test tests/unit/agentic/engine/outbox.test.mjs`
   - 退出码 0；语法检查通过；7 tests、7 pass、0 fail。

未运行：`npm run test:unit`、`npm run verify:web`；它们属于 M7 收尾，且 `.s2d/plan.md:6-13` 已记录基线 `npm ci` 因 lockfile 缺 optional dependency 条目失败。

## 安全与限制

- 本模块没有外部网络调用、没有读取密钥或 `.env`；实现只使用 Node 内置 `node:crypto` 生成稳定条目 ID。
- 迁移由 foundation 的 `applyEngineMigrations` 按文件名执行；SQL 使用 IF NOT EXISTS，符合 `.s2d/plan.md:40-44` 的幂等迁移约定。
- 与跨模块 run-engine 的“检查点同事务登记”组合仍需 M3 集成复核；本模块自身提供持久 register API，未改动 run-engine。
