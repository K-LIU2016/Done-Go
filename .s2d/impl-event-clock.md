# event-clock 实现交付

- 模块：M2 event-clock；依据 `.s2d/plan.md:47-60`、BUILD-PLAN §3 W2-1。
- 实现：`scripts/agentic/engine/event-clock.mjs` 提供 `createEventClock({db, now})`，持久化 `schedule/cancel/list/tick`；`tick` 对重启后的到期事件补触发并写入 `late/late_ms/fired_at`；使用参数化 SQL 与 `INSERT OR IGNORE` 保证 dedup 幂等，取消/已触发事件不重复执行。
- 时间：`+08:00` ISO 校验与 `Asia/Shanghai` 默认时钟；中国无夏令时假设见 `event-clock.mjs:27-32,85`。
- 迁移：`scripts/agentic/db/migrations/engine-001-event-clock.sql` 建立 `event_timers`、唯一 `dedup_key` 与 due 索引，状态约束为 scheduled/fired/cancelled。
- TDD 证据：先行测试文件 `tests/unit/agentic/engine/event-clock.test.mjs` 已在实现前运行并因模块缺失失败（`ERR_MODULE_NOT_FOUND`）；实现后 7/7 通过。
- 通过检查：`node --test --experimental-test-coverage tests/unit/agentic/engine/event-clock.test.mjs`，exit 0；event-clock 行覆盖率 90.70%，函数覆盖率 88.89%。
- 全引擎检查：`node --test --experimental-test-coverage tests/unit/agentic/engine/*.test.mjs`，exit 1，50 tests 中 32 pass/18 fail；失败集中在并行模块 run-engine/policy/outbox/crash-recovery，不改动其归属文件。
- 外部真实调用：0；运行时依赖：0；端口/密钥：未使用。
- 提交：见本分支 event-clock commit。 
