# M11-coverage-and-gates 实现记录

## 范围与依据

- 计划：`.s2d/plan.md:41-49`；M11 负责本流覆盖率/门禁、精确命令与 rc、依赖/UNKNOWN、文件归属及冻结 schema 只读核对。
- 全局规则：`BUILD-PLAN.md:33-80`（W4 文件归属、Node ESM、TDD、覆盖率 ≥80%、门禁与报告）。
- 自主边界：`PRD.md:194-212,592-637`、`CTO-DECISIONS-2026-10-27.md:30-40,48-58`、`CTO-BATCH2-BRIEF-2026-10-27.md:24-41`；P0 无外部副作用、A4 逐次确认、A5 不自动、UNKNOWN 不得升级为成功。

## 交付与只读核对

M02–M10 已存在于本流允许目录；M11 未新增运行时代码或测试代码，仅新增本记录及外部证据/报告。`git diff --name-only 60fdc73..HEAD` 结果仅包含 `.s2d/**`、`scripts/agentic/autonomy/**`、`scripts/agentic/db/migrations/autonomy-*.sql`、`tests/unit/agentic/autonomy/**`；`git diff --name-only 60fdc73..HEAD -- contracts/agentic` 无输出。冻结文件读取结果为 `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`，未改写 W0 schema。

当前 HEAD：`d82140f938579d58c0387b4dcdd3c3bdb1a75520`，分支 `feat/s2d-w4-autonomy`，工作树在提交前干净。无 `.env`、`serve-tango`、主仓、生产、ThinkPad 或 LiteLLM 修改。

## 门禁命令与结果

1. `cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → **rc=0**；84 tests、84 pass、0 fail、0 skipped；all-files line **97.67%**、branch **86.91%**、function **89.42%**。
2. `cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f" || exit 1; done; git diff --check; rc=$?; printf 'syntax-and-diff-check rc=%s\\n' "$rc"; exit "$rc"` → **rc=0**；输出 `syntax-and-diff-check rc=0`。
3. `cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && npm run verify:web` → **rc=0**；227 tests、227 pass、0 fail、0 skipped。
4. `cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && npm run test:unit` → **rc=1**；1054 tests、1045 pass、7 fail、2 skipped。失败是本流外既有测试：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、`streamChat accepts typed content deltas…`、`independent authenticated accounts…`、`AI uses selected shared fields…`、`replays a multi-clause recording…`、`tests/unit/voice-pipeline-gateway.test.mjs`；不能宣称全仓 unit gate 通过。
5. `npm ci --prefix '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy'` → **rc=1**；npm 报 `Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`。按 `.s2d/plan.md:49` 记录为基线 lock 漂移，未改 lock、未新增依赖。
6. 之前的定向 TDD 证据见 `.s2d/impl-M10-unit-negative-tests.md:18-23` 与各模块记录：负面测试曾先 RED 后 GREEN；当前定向全套为 GREEN。

## 外部调用、依赖与 UNKNOWN

- 真实外部动作/网关/媒体/Codex 调用：0；测试使用本地 mock/dry-run，不读取或打印 gateway key。
- 新增依赖：无。
- UNKNOWN/待决：全仓 7 个非本流 unit 失败；npm lock 漂移；W13 仍需做跨流接缝、路由挂载、冻结契约一致性与最终集成。未知外部结果在 autonomy 测试中保持 `UNKNOWN` 且恢复不重做。

## 提交

M11 仅记录门禁与证据，不改变实现语义；提交使用 `flock -w 900 /tmp/donego-s2d-pw.lock`，不 push、不触碰 main。
