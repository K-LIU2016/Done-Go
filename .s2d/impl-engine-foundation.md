# S2D-W2 M1 实现记录：engine-foundation

日期：2026-10-26

## 归属与依据

- 本模块文件清单取自 `.s2d/plan.md:31-45`：`scripts/agentic/engine/db.mjs`、`scripts/agentic/engine/hash.mjs`，共享测试夹具由先行文件提供。
- 全局约束取自 `BUILD-PLAN.md:33-47`：W2 只能改 `scripts/agentic/engine/**`、`scripts/agentic/db/migrations/engine-*.sql`、`tests/unit/agentic/engine/**`；本实现未保留 foundation migration，因为迁移文件由后续域模块各自提供。
- 哈希语义对应 `.s2d/plan.md:40-43` 与 `PRD.md:171`（合同稳定 hash）及 `BUILD-PLAN.md:87-90`（规范化 JSON SHA-256）。

## 实现

- `hash.mjs`：递归按字典序排序对象键、保持数组顺序；导出 `canonicalJson`、`sha256Hex`、`contractHash`、`stepInputHash`。非有限数字显式拒绝，避免不可稳定序列化输入。
- `db.mjs`：`openEngineDb({memory|file})` 创建 Node `DatabaseSync`，强制 `foreign_keys=ON`；文件库创建目录并尝试 WAL，WAL 不可用时保持连接可用。`applyEngineMigrations` 只收 `engine-*.sql`，按文件名排序，在 `_engine_migrations` 记账并以事务执行，重复调用跳过已应用文件。

## 验证

命令（在 W2 worktree 执行）：

```text
cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage tests/unit/agentic/engine/db-hash.test.mjs
```

结果：退出码 0；9 tests、9 pass、0 fail。覆盖率报告 all files：line 91.63%、branch 89.58%、functions 84.00%；实现文件 `db.mjs` line 92.68%、`hash.mjs` line 97.37%，达到本模块 ≥80% 要求。

未运行：`npm run test:unit` 与 `npm run verify:web` 未作为 M1 单测检查运行；计划已记录基线 `npm ci` 缺 optional dependency lock 条目的环境事实（`.s2d/plan.md:6-13`），且这些门禁属于 M7 收尾。

## 安全/范围

- 本模块未调用外部网络、未读取密钥、未读取 `.env`；仅使用 Node 内置 `node:crypto`、`node:sqlite`、`node:fs`、`node:path`。
- 未修改 W2 归属之外文件；`.s2d/plan.md` 是派发前已存在的工作流材料，不属于本实现改动。
