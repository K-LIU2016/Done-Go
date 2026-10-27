# S2D-W2 M6 实现记录：crash-recovery

日期：2026-10-26
模块：crash-recovery（组 3）

## 依据与范围

- `.s2d/plan.md:109-122` 定义 M6 的文件归属与场景 A–D：子进程 SIGKILL 后重启、外部动作不重复、暂停/合同 hash 变化、cancel、恢复前重校验。
- `tests/unit/agentic/engine/crash-recovery.test.mjs:52-220` 为本模块先行测试；本次新增恢复态测试覆盖“进程崩溃后 runs.status=running 时仍必须先重校验合同 hash”。
- 仅修改模块归属文件：`scripts/agentic/engine/run-engine.mjs` 与 `tests/unit/agentic/engine/crash-recovery.test.mjs`；新增本模块实现记录 `.s2d/impl-crash-recovery.md`。未修改其他产品目录。

## 实现

- `scripts/agentic/engine/run-engine.mjs:101-111`：`resume()` 将持久化的 `running` 纳入恢复入口；恢复、显式暂停及待确认态统一先调用注入的 `revalidate()`，合同 hash 不一致时转 `paused_pending_confirm` 并返回 `CONTRACT_CHANGED`，一致时才回到 `running`。
- 该修复避免子进程在 step 检查点为 `running` 时崩溃后绕过合同重校验继续重放；与 outbox unknown 不重发路径组合，保持外部动作不重复。

## 验证（本 ask 实际执行）

1. RED：`cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage tests/unit/agentic/engine/crash-recovery.test.mjs`
   - 退出码 1；原 4 项通过，新增 `scenario D recovery` 失败：`恢复入口必须先执行合同重校验`，实际 `0 !== 1`。证明测试捕获缺口。
2. GREEN：同一命令（修复后）
   - 退出码 0；5 tests、5 pass、0 fail；总行覆盖率报告 all files 83.33%。`run-engine.mjs` 行覆盖率 86.29%。
3. 全模块：`cd '/Users/chillbit/Proj/Done & Go/s2d/w2-engine' && node --test --experimental-test-coverage tests/unit/agentic/engine/*.test.mjs`
   - 退出码 0；50 tests、50 pass、0 fail；总行覆盖率 97.25%（覆盖率要求 ≥80%）。
4. 额外命令 `node --test --experimental-test-coverage tests/unit/agentic/engine/` 未通过：Node 将目录当作模块并报 `Cannot find module .../engine`；按 Node 22 实际行为改用 glob 文件命令，结果如上，未将目录命令冒充通过。

## 安全与限制

- 本模块未进行外部真实调用、未读取/打印/落盘密钥或 `.env`；测试使用本地 SQLite、子进程和临时文件 marker。
- 未运行 `npm run test:unit` 或 `npm run verify:web`；`.s2d/plan.md:6-13` 已记录基线依赖安装因 lockfile optional dependency 缺项失败，且这些命令属于 M7 收尾门禁。
