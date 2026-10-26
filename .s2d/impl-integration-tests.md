# S2D-W8 M9 integration-tests 实现记录

## 范围

依据 `.s2d/plan.md` M9（先读于 lines 97–104）：新增 hub+CLI 出站桥环回单测与 opt-in e2e 壳；Codex 全部为注入假适配器，不调用真实 Codex。只修改本模块归属的 `tests/unit/agentic/bridge/**` 与 `tests/agentic/bridge/**`。

## 实现

- `tests/unit/agentic/bridge/hub-loopback.test.mjs`
  - 自建 HTTP + `ws` noServer hub，使用 `bridge-*.sql` 内存迁移。
  - 覆盖 pair/start、owner 隔离、runtime plan/chooseModel/execute、范围外审批 Need、review、fork、revert。
  - 覆盖消息超限 1009、设备吊销即时失效与客户端生命周期；无真实上游调用。
- `tests/agentic/bridge/loopback.e2e.mjs`
  - 默认 skip；仅 `DONEGO_S2D_E2E=1` 时启动 Node 子进程执行环回测试，避免默认单测占用端口。

## 检查

1. `node --test --experimental-test-coverage tests/unit/agentic/bridge/hub-loopback.test.mjs`
   - exit 0；2 tests passed，0 failed；该文件 line coverage 98.34%。
2. `node --test --experimental-test-coverage tests/unit/agentic/bridge/*.test.mjs`
   - exit 0；135 tests passed，0 failed；all-files line 97.68%，branch 80.77%，function 88.13%。满足新增单测覆盖率 ≥80%。
3. `node --check tests/unit/agentic/bridge/hub-loopback.test.mjs && node --check tests/agentic/bridge/loopback.e2e.mjs && git diff --check`
   - exit 0。
4. `node --test tests/agentic/bridge/loopback.e2e.mjs`
   - exit 0；1 test skipped（默认 opt-in，未设置 `DONEGO_S2D_E2E`）。

## 提交

`084b705 test: add bridge loopback integration coverage`，包含 `Co-Authored-By: ZCode`。提交使用 pathspec；工作流 `.s2d/*` 元数据未纳入提交。

## 未运行

未运行 `npm run test:unit`、`npm run verify:web`、W0 合并/契约一致性、真实 Codex 冒烟；这些属于工作流级门禁或其他模块。真实 Codex 调用次数为 0（本模块仅假适配器）。
