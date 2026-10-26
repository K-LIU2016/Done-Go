# S2D-W2 引擎 · 单测先行 RED 记录（tests-red）

> 测试先行 worker · 2026-10-26 · 分支 `feat/s2d-w2-engine`（基 65efc27）
> TDD 阶段：只写测试，不写实现。本文件 = 断言清单 + RED 失败摘要（不进返回值）。

## 1. 断言文件清单（tests/unit/agentic/engine/，共 8 文件 + 1 夹具）

| 文件 | 模块 | test() 数 | 固定的实现契约（被测文件） |
|---|---|---|---|
| `helpers.mjs` | 夹具 | —（不被收集） | fakeClock(+08:00 ISO)/fakeSleeper/makeDb/MIGRATIONS_DIR/tempDir |
| `db-hash.test.mjs` | M1 | 9 | `hash.mjs`：canonicalJson（key 递归排序、数组保序）、sha256Hex、contractHash/stepInputHash（字段顺序无关、任一变化必变）；`db.mjs`：openEngineDb({memory/file})（exec/prepare、foreign_keys=1、文件落盘）、applyEngineMigrations（按文件名排序、只收 engine-*.sql、可重复调用幂等） |
| `event-clock.test.mjs` | M2 | 7 | schedule（+08:00 原样存储、dedup_key 幂等返回原 id）、tick（未到点不触发、准点 late=0、已 fired 不重复）、重启补触发（新实例 tick → late=1 + late_ms=now-run_at）、过期 12h 照常触发、cancel（不再触发/状态 cancelled/重复取消 false）、多定时器按 run_at 升序、list({from,to}/{all:true}) |
| `run-engine.test.mjs` | M3 | 13 | startRun（queued + contract_hash/budget 快照/dod）；step(name,input,fn)（running 检查点、done+result+input_hash+spent、fn 执行期间状态=running）；重放跳过（同 name+input → fn 不执行、结果取检查点）；input 变化重执行；指数退避（[100,200]、attempt=3 成功）；3 次耗尽 → step failed + run partial（有兄弟 done）/failed（无）；pause 阻断（RUN_PAUSED）；resume 重校验 hash（变 → paused_pending_confirm + CONTRACT_CHANGED + 阻断；同 → 续跑）；cancel 终态（step 停、outbox registered 不派发且置 cancelled、不可 resume）；ctx.registerAction 幂等不重复；step 终败其 outbox 项置 failed；预算用尽 → 下一 step BUDGET_EXHAUSTED + run paused；finish({dodMet}) → succeeded/partial；overrunToOutcome 三策略映射 |
| `policy.test.mjs` | M4 | 9 | SYSTEM_WONT 六条关键词；normalizeContract（并入系统 wont、hash 稳定、will∩SYSTEM_WONT → SYSTEM_WONT_IMMUTABLE、autonomy A4/A5 → AUTONOMY_OUT_OF_CONTRACT）；Grant 状态机（proposed→active→consumed 一次性、revoked、惰性 expired、合同变化 invalidated）；**越权用例表 26 条（CASE-01…CASE-26 ≥20）**：七条件反例+边界（预算 ==、prepStart/end 闭区间）+A4 逐次确认/A5 永不自动/组合优先级（生命周期先于能力、窗口先于预算）+dataClasses ⊆ 语义；审计（发放/激活/消费(带 external_id+合同 hash+actor)/撤销/每次拒绝 outcome=deny）；撤销后 in-flight 拒绝 |
| `outbox.test.mjs` | M5 | 7 | register（action_key 幂等、external_id 默认=action_key 稳定 ID）；dispatch（registered→dispatched→verified 读回核验；verify 用 send 返回的外部 ID；仅 2xx/读回不过 → unknown）；send 超时/断线 → unknown 保留原 ID 且再 dispatch 拒绝（不生成新 ID 重做）；preSend 失败 → failed 可重试；reconcile（probe → verified/failed/保持 unknown+manual=1 人工接管）；recover 三崩溃点位（registered 恰好 send 1 次、dispatched 原补核验不重发、unknown 只 probe；send/verify/probe 计数断言） |
| `crash-recovery.test.mjs` | M6 | 4 | 场景 A：子进程 step2 外部副作用（marker 追加 X）后 send 挂起 → 父进程 SIGKILL → 现场断言（outbox=dispatched、step1 done）→ resume 子进程 → run succeeded、marker 恰好 1 行、step1 结果与首跑逐字节一致、step2/3 done、对账沿用原外部 ID；场景 B：暂停+合同变化（V3-19）→ paused_pending_confirm、旧 Grant invalidated 非 consumed、unknown 不盲重试（send 计数 0）、hash 回同后续跑；场景 C：cancel → step 停 + recover 也不派发（dispatched=0）；场景 D：resume 两分支 |
| `engine-suite.test.mjs` | M7 | 1 | index.mjs barrel 导出面（三工厂+hash/db 四工具）；黄金路径：规范化+hash → Grant 发放/激活 → §8.2 放行 → event-clock 触发 → 3-step run（含 outbox verified）→ succeeded + 审计在案 |
| `fixtures/child-run.mjs` | M6 夹具 | —（不被收集） | initial：3-step run、step2 outbox 派发（send=marker 追加后挂起）；resume：attach+resume(重校验)+重放+finish |

合计 `test()` 50 个；越权用例 26 条（CASE-01…CASE-26）。
迁移表契约（由断言隐含）：`event_timers`、`runs`/`run_steps`、`outbox`、`grants`/`audit`（engine-001..004）。

## 2. RED 运行（命令与结果）

命令（worktree 根目录）：

```bash
node --test 'tests/unit/agentic/engine/*.test.mjs'
```

（注：node v22.22.2 的 `--test` 位置参数不收目录，须传文件/glob——与仓库 `scripts/test-unit.mjs` 传显式文件列表一致。）

退出码 **1**；TAP 汇总：

```
# tests 7
# pass 0
# fail 7
```

每个文件失败原因均为 `ERR_MODULE_NOT_FOUND`（实现尚未编写——这正是 TDD 第一阶段 RED 的预期形态）：

| # | 测试文件 | Cannot find module |
|---|---|---|
| 1 | crash-recovery.test.mjs | `scripts/agentic/engine/db.mjs` |
| 2 | db-hash.test.mjs | `scripts/agentic/engine/hash.mjs` |
| 3 | engine-suite.test.mjs | `scripts/agentic/engine/index.mjs` |
| 4 | event-clock.test.mjs | `scripts/agentic/engine/event-clock.mjs` |
| 5 | outbox.test.mjs | `scripts/agentic/engine/outbox.mjs` |
| 6 | policy.test.mjs | `scripts/agentic/engine/policy.mjs` |
| 7 | run-engine.test.mjs | `scripts/agentic/engine/run-engine.mjs` |

全部测试文件通过 `node --check` 语法检查（9/9 OK，含夹具）。

## 3. GREEN 前置（交给实现 worker）

- 实现 `scripts/agentic/engine/{db,hash,event-clock,run-engine,policy,outbox,index}.mjs` 与 `scripts/agentic/db/migrations/engine-00{1..4}-*.sql`（均在本流文件归属内，BUILD-PLAN §2.1 L40）。
- GREEN 门禁：`node --test --experimental-test-coverage 'tests/unit/agentic/engine/*.test.mjs'` 全绿且行覆盖 ≥80%（BUILD-PLAN §2.3 L60）。
- 已知环境限制（plan.md §0 待裁决 #1）：`npm ci` 因 lockfile 缺 sherpa-onnx-win-arm64 失败 → `npm run test:unit` 暂不可整体跑；`node --test` 直跑不受影响。
