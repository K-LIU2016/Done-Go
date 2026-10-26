# S2D-W2 M4 实现记录：policy

日期：2026-10-26

## 归属与依据

- 模块文件清单取自 `.s2d/plan.md:78-92`：`scripts/agentic/engine/policy.mjs`、`scripts/agentic/db/migrations/engine-004-policy.sql`、`tests/unit/agentic/engine/policy.test.mjs`。
- PRD §8.1–8.2 的合同边界、六条不可覆盖的系统禁止项与七条件判定见 `design/schedule-to-delivery/PRD.md:593-627`；审计与撤销语义见 `PRD.md:635-638`。
- BUILD-PLAN 的 W2 归属及 TDD/覆盖率/迁移约束见 `design/schedule-to-delivery/BUILD-PLAN.md:38-48`、`:57-67`；W2 policy 目标见 `BUILD-PLAN.md:103-110`。

## 实现

- `policy.mjs:4` 固定 `SYSTEM_WONT` 六条系统禁止项；`:40-47` 规范化合同、并入禁止项并计算稳定合同 hash，拒绝 A4/A5 合同和 `will` 覆盖系统禁止项。
- `policy.mjs:49-69` 实现 Grant proposed → active → consumed/revoked/invalidated 生命周期、过期惰性处理和审计；`:71-103` 实现生命周期/hash、全局禁止、A5/A4、autonomy、能力、资源范围、披露集合、窗口和预算判定，所有拒绝写入 `audit`。
- `engine-004-policy.sql` 建立幂等 `grants`/`audit` 表及索引，状态由 SQLite CHECK 约束保护。
- 测试保留 26 条编号越权矩阵（`policy.test.mjs:163-191`），并补齐 CASE-20 的失配 Grant、CASE-13 的非法运行时合同边界、CASE-05/07/24 的 spent/estimate 输入。

## 验证

执行命令（worktree 根目录）：

```text
node --test --experimental-test-coverage 'tests/unit/agentic/engine/policy.test.mjs'
```

结果：退出码 0；9 tests、9 pass、0 fail。覆盖率报告 all files：line 93.70%、branch 78.95%、functions 88.57%；`policy.mjs` line 96.19%、functions 96.30%，达到本模块 ≥80% 行覆盖率要求。该命令输出含 Node SQLite ExperimentalWarning，但不影响退出码。

另执行：

```text
node --check scripts/agentic/engine/policy.mjs && node --check tests/unit/agentic/engine/policy.test.mjs
git diff --check
```

结果：退出码 0，无语法或 whitespace 错误。

未运行：全仓 `npm run test:unit` / `npm run verify:web`，属于 M7 收尾门禁且 `.s2d/plan.md:8-13` 已记录当前依赖安装基线问题；本 ask 已运行其指定的 policy coverage 单测。

## 安全/范围

- policy 代码只使用 Node 内置 `node:crypto` 与既有 SQLite/hash 模块；无新增运行时依赖、无网络调用、无真实外部动作、无密钥读取或 `.env` 读取。
- SQL 使用参数绑定；本模块只新增/修改 policy 归属的 engine migration、engine implementation、engine unit test 和本实现记录。
- 越权矩阵共 CASE-01…CASE-26（26 条，满足 ≥20）：生命周期/合同 hash、能力、资源、披露、预算、窗口、A4/A5、系统禁止项及组合优先级均覆盖。
