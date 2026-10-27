# W9 单测 RED 证据（测试先行节点）

- 日期：2026-10-27
- 依据：`.s2d/plan.md`（G1-M1/M2/M3、G2-M4）；brief 要求 TDD 先负面路径后实现，全部单测一次提交。
- 详细证据（负面路径映射表、接口规约、约束核对）：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w9-tests-red.md`

## 命令与结果

```text
cd '/Users/chillbit/Proj/Done & Go/s2d/w9-delivery' && node --test \
  tests/unit/agentic/delivery/*.test.mjs \
  tests/unit/agentic/verifier/*.test.mjs \
  tests/unit/agentic/inbox/*.test.mjs \
  tests/unit/agentic/contracts/w9-contract-consistency.test.mjs
exit_code=1
# tests 16 / pass 0 / fail 16（全部 ERR_MODULE_NOT_FOUND：实现模块尚未创建）
```

- 151 个 test() 块，覆盖 brief 17 条负面路径（映射表见上述证据文件）。
- 失败原因全部为实现缺失（首个缺失模块见证据表）；16 文件 `node --check` 语法全过。
- 基线：`node --test tests/unit/agentic/contracts/contracts.test.mjs` → 12/12 pass，未受影响。
- 约束：未写实现/迁移 SQL；未触碰 contracts/agentic/**、W3/W4/W6/W10、serve-tango、web/**、.env；
  无新增依赖；无外部命令/网络/端口；无 key 读取；测试时钟全部确定性注入。

## 给三个并行实现 actor 的入口

- 测试即接口规约：每个测试文件头部注释钉死模块导出签名、错误码、DB 表/列名与 UNIQUE 约束。
- 迁移文件名固定 `w9-1-delivery.sql` / `w9-2-verifier.sql` / `w9-3-inbox.sql`（放 `scripts/agentic/db/migrations/`）；
  迁移形状断言在 artifact-store.test.mjs 与 need-store.test.mjs 末尾（PRAGMA 检查）。
- 实现完成后跑各自域目录的 `node --test tests/unit/agentic/<域>/*.test.mjs`；M4 契约一致性测试需要三域全部就位。
