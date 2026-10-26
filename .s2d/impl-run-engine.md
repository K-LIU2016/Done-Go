# S2D-W2 M3 实现记录：run-engine

日期：2026-10-26
模块：run-engine（组 2）

## 依据与归属

- `.s2d/plan.md:62-76`：M3 文件清单与 DBOS 行为要求（runs/run_steps、输入哈希检查点、暂停/恢复/取消、最多 3 次指数退避、预算/终止语义）。
- `BUILD-PLAN.md:102-109`：W2 run-engine 与崩溃恢复门禁。
- `PRD.md:358-372`、`PRD.md:843-852`：检查点循环、预算耗尽暂停、服务重启从最近检查点恢复、外部动作不重复。
- 测试契约：`tests/unit/agentic/engine/run-engine.test.mjs:45-280`，覆盖 13 个 run-engine 场景；恢复夹具在 `tests/unit/agentic/engine/crash-recovery.test.mjs:50-202`。

## 实现

- `scripts/agentic/db/migrations/engine-002-run-engine.sql`：幂等创建 `runs`/`run_steps`，包含状态约束、合同 hash、DoD/预算快照、步骤 input hash/result/attempt/spent/error 检查点与索引。
- `scripts/agentic/engine/run-engine.mjs:18-121`：`createRunEngine`、`startRun`、`attach`、`step`、`pause/resume/cancel`、`finish` 和 `overrunToOutcome`。
- `step` 在执行前落 `running` 检查点；同名同 input hash 的 `done` 步骤直接返回检查点；失败最多 3 次并按 `retryBaseMs * 2^(attempt-1)` 退避；永久失败按兄弟步骤完成情况置 `partial/failed`。
- `resume` 每次调用 `revalidate`，合同 hash 不同进入 `paused_pending_confirm`；`cancel` 将 run 的 registered outbox 项取消；ctx 通过 outbox 登记稳定 action key。

## 验证

实际执行命令：

```text
cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage $(find tests/unit/agentic/engine -maxdepth 1 -name '*.test.mjs' -print | sort)
```

结果：退出码 0；TAP `1..50`，`# tests 50`、`# pass 50`、`# fail 0`。覆盖率：all files line **97.25%**、branch **84.00%**、functions **85.04%**；`run-engine.mjs` line **95.04%**、branch **80.00%**、functions **88.89%**，达到 ≥80%。完整输出保留在本次执行的 `/tmp/w2-engine-final.log`。

安全恢复专项实际执行：

```text
cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test tests/unit/agentic/engine/crash-recovery.test.mjs
```

结果：退出码 0；4 tests、4 pass、0 fail；场景 A 外部 marker 恰好一次，场景 B 合同变化进入待确认，场景 C 取消后恢复不派发，场景 D 覆盖 hash 相同/不同两分支（输出见该命令执行结果）。

未运行：`npm run test:unit`、`npm run verify:web`；它们属于 M7 收尾，且 `.s2d/plan.md:6-13` 记录 `npm ci` 因 lockfile 缺 optional dependency 条目失败。

## 安全与限制

- 本模块未调用外部网络、未读取密钥或 `.env`；仅使用 Node 内置模块及本流 engine hash/db API。
- run-engine 不直接派发外部动作，动作必须先经注入的 outbox `registerAction`；unknown/dispatched 的对账语义由 outbox 模块负责。
- 与 W0 共享迁移运行器的契约一致性测试待 W0 冻结后由 M7 执行。
