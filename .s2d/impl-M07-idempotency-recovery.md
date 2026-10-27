# M07-idempotency-recovery 实现记录

## 变更

- `scripts/agentic/autonomy/idempotency-recovery.mjs:6-202`：新增 `ACTION_STATES` 与 `IdempotencyRecovery`。以 idempotency key + action/owner/contract/grant/actor/resolved model/action hash 做身份绑定；重复请求返回已存结果，key 冲突 fail-closed；checkpoint 按 step/input hash 去重；eventId 重放去重、payload 冲突拒绝；状态转换覆盖 running/succeeded/failed/unknown/paused/cancelled/blocked；timeout、断线或 unknown 外部结果进入 UNKNOWN，恢复不重做；暂停恢复重新校验合同与 grant；缺少 resolved model 只能 UNKNOWN。
- `scripts/agentic/db/migrations/autonomy-002-idempotency-recovery.sql:1-36`：新增 action 幂等记录、checkpoint、event 表及索引，主键保证持久化幂等。
- `tests/unit/agentic/autonomy/idempotency-recovery.test.mjs:25-122`：先行覆盖状态转换、重复/冲突、checkpoint、执行幂等、断线/超时 UNKNOWN、暂停/撤权/合同变化恢复、事件去重、审计失败、SQLite 持久化和 UNKNOWN actor。

## 证据

- M07 定向单测：
  `node --test tests/unit/agentic/autonomy/idempotency-recovery.test.mjs`
  输出：`1..9`, `# pass 9`, `# fail 0`, `# skipped 0`, exit `0`。
- W4 autonomy 全测覆盖：
  `node --test tests/unit/agentic/autonomy/*.test.mjs`
  输出：`1..59`, `# pass 59`, `# fail 0`, exit `0`。
- 覆盖率：
  `node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs`
  输出：all files line `97.29%`, branch `83.45%`, function `90.14%`, exit `0`。
- 语法与差异检查：
  `node --check scripts/agentic/autonomy/idempotency-recovery.mjs && node --check tests/unit/agentic/autonomy/idempotency-recovery.test.mjs`
  exit `0`；`git diff --check` exit `0`。
- 全仓库门禁（按 package script 原命令）：
  `npm run test:unit`
  exit `1`，`# tests 1029`, `# pass 1020`, `# fail 7`, `# skipped 2`。失败为既有/跨流测试：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`streamChat accepts typed content deltas...`、两项 collaboration/account、voice replay、`tests/unit/voice-pipeline-gateway.test.mjs`；本次未修改这些文件。

## 提交

- branch `feat/s2d-w4-autonomy`
- HEAD `50fe0a3 feat: add idempotent autonomy recovery`
- 仅修改 M07 所属 3 个文件；未改 W0 schema、主仓、生产、`.env` 或其他流文件。
