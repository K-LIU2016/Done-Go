# M03-policy-evaluator 实现记录

## 范围与依据

- 模块：`.s2d/plan.md:33`，实现每次动作的 Contract/Grant、scope、data disclosure、window、budget、autonomy、owner 校验；A4 逐次确认、A5 永久拒绝、默认 deny。
- 负面路径：`.s2d/plan.md:19-25`；覆盖未签约/无 Grant/hash 不符/过期、越权 scope/data、预算/时间窗、未知模型、P0/A5、审计失败与未知结果。
- 产品/安全边界：PRD `PRD.md:200-212`（A0–A5）、`PRD.md:592-637`（Contract、policy、审计/撤销）；CTO `CTO-DECISIONS-2026-10-27.md:30-38`（P0/A4/A5/fail-closed）；批次二简报 `CTO-BATCH2-BRIEF-2026-10-27.md:28-41`（W4 边界）；实现依据 BUILD-PLAN `BUILD-PLAN.md:33-66`（文件归属、TDD、零依赖）。

## 实现文件

- `scripts/agentic/autonomy/policy.mjs`：默认拒绝；校验 mission/contract/grant/owner/hash/actor+model/scope/data disclosure/window/budget/autonomy；A4 返回 `needs_confirmation`，A5/P0 返回阻断。
- `scripts/agentic/autonomy/side-effect-fence.mjs`：只读/建议/准备/可逆分类；P0 外部副作用封锁、A4 `NEED_HUMAN`、A5 hard-stop；动作执行前后审计，审计失败不报告成功。
- `scripts/agentic/autonomy/audit.mjs` + `scripts/agentic/db/migrations/autonomy-001-audit.sql`：Grant、policy、confirmation、A3+ action、UNKNOWN/recovery 事件与 SQLite 结构化落库；写失败锁存 fail-closed。
- `scripts/agentic/autonomy/runtime.mjs` / `confirmation.mjs`：既有 M04 接缝增强为绑定 action hash、actor/model、contract hash 的一次性确认与幂等/UNKNOWN 恢复保护。
- 测试：`tests/unit/agentic/autonomy/policy-boundaries.test.mjs`、`side-effect-fence.test.mjs`、`audit.test.mjs`，并回归既有 autonomy/confirmation/types 测试。

## 检查证据

- TDD RED：`cd '/Users/chillbit/Proj/Done & Go/s2d/w4-autonomy' && node --test tests/unit/agentic/autonomy/policy-boundaries.test.mjs` → rc=1，6 tests / 0 pass / 6 fail；先行测试暴露 Contract hash、actor/model、data、window、budget 未实现。
- 本流单测/覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0，50 tests / 50 pass / 0 fail；line 97.21%、branch 87.91%、function 92.86%（输出原样见本次命令）。
- 定向回归：`node --test tests/unit/agentic/autonomy/autonomy.test.mjs tests/unit/agentic/autonomy/confirmation.test.mjs tests/unit/agentic/autonomy/side-effect-fence.test.mjs` → rc=0，33/33 pass。
- 语法/差异：`for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs; do node --check "$f" || exit 1; done; git diff --check` → rc=0，输出 `syntax/diff rc=0`。
- Web 门禁：`npm run verify:web` → rc=0，227 tests / 227 pass / 0 fail。
- 完整单测：`npm run test:unit` → rc=1，1020 tests / 1011 pass / 7 fail / 2 skipped；失败均为基线/既有项：`src/screens/s04-plan/metric-layout.test.ts`、`src/styles/design-system.test.ts`、streamChat typed deltas、两个 collaboration HTTP、voice-pipeline replay、voice-pipeline-gateway；未新增本流 autonomy 失败。
- 安装检查：`npm ci` → rc=1；当前 npm 输出为 npm CLI usage（未进入依赖安装，未修改 lock），计划已知基线记录 `.s2d/plan.md:49` 为 `Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`，两者差异保留为 UNKNOWN。
- 外部调用/密钥：0 次真实外部调用；未读取 `.env` 或网关 key。

## 文件边界、提交与未决

- 提交 `7ddd909`，提交信息 `feat: complete autonomy policy evaluator`，含 `Co-Authored-By: ZCode`；提交在 `/tmp/donego-s2d-pw.lock` 约束下完成。
- 当前新增/修改仅属 W4：`scripts/agentic/autonomy/**`、`scripts/agentic/db/migrations/autonomy-001-audit.sql`、`tests/unit/agentic/autonomy/**`；未修改冻结 `contracts/agentic/**`、`serve-tango`、生产、主仓、`.env`。
- UNKNOWN：完整单测的 7 个基线失败、npm lock/CLI 环境差异、未挂载 `serve-tango` 的集成接缝、四路评审 actor provenance 尚未在本模块运行库中提供；按 CTO 要求不将其写成通过。
