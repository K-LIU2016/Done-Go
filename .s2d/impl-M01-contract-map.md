# M01-contract-map 实现记录

- 范围：M01 仅固化 `.s2d/plan.md` 的 PRD/W0/CTO 字段映射、A0–A5 判定、事件边界与负面路径；后续 M02–M10 已在同一提交中实现运行时代码与单测，非本记录新增范围。
- 依据：`.s2d/plan.md:5-25,29-41,43-49`；其映射 PRD §4.2/§4.3/§8.1–§8.4/§10.4–§10.6、BUILD-PLAN §2.1/§2.3/§2.4、CTO 决策 §2.3/§4/§5、批次二简报 §3–§5 及 `prototype.html:198-217,223-228`。
- 判定表：A0 只记录；A1 扫描/预演/建议；A2 合同范围内准备；A3 合同+能力 Grant 的可逆动作；A4 每动作一次性显式确认；A5 金钱/法律/生产类永不自动，必须由人在原工具完成。合同默认最高 A3；P0 无外部副作用。
- 字段边界：执行器只接规范化 Contract/Grant；owner、contract hash、capability/scope、data disclosure、window、budget、autonomy、actor/resolved model 必须绑定并重验。W0 `contracts/agentic/**` 与冻结 `b9d9bdfa0511905a95b729753b82e5734adab6bb` 未改；W4 以运行时策略/事件接口表达 A4/A5。
- 事件边界：W4 输出决策、确认、审计、阻断/UNKNOWN、恢复状态事件；不挂 `serve-tango`、不执行真实外部动作；跨流只走 adapter/projection/事件接口。UI 仍按“说→看→定→交”，W4 不改前端。
- 负面路径：未签约/缺失或失效 Grant/合同 hash 不符、A0/A1 越权、A4 缺确认/重复/过期/错绑定、A5 自动执行、审计失败、缺失或 NULL 模型、未知外部结果、重复/超时/断线/恢复、撤权/合同变更、跨 owner/scope/worktree、删除默认 `wont` 均 fail-closed；不得调用外部动作、报告成功或重做未知动作。
- 代码证据：`scripts/agentic/autonomy/types.mjs:1-27` 明确定义 A0–A5、风险与 actor UNKNOWN；`policy.mjs:5-30` 实现合同/Grant/owner/scope/P0/A4/A5 拒绝；`confirmation.mjs:2-20` 实现一次性 actor/model/hash 绑定；`audit.mjs:1-12` 审计失败锁定；`runtime.mjs:4-61` 实现幂等、UNKNOWN 恢复保护及 route harness；`tests/unit/agentic/autonomy/autonomy.test.mjs:45-221` 覆盖负面路径。
- TDD/检查：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/autonomy.test.mjs` → rc=0，21/21 通过；覆盖全部文件 line 99.47%、branch 88.89%、function 87.93%。`node --check` 全部 autonomy `.mjs` + `git diff --check` → rc=0，输出 `syntax/diff rc=0`。
- 门禁：`npm run verify:web` → rc=0，227/227 通过；`npm run test:unit` → rc=1，991 tests/982 pass/7 fail（另 2 skipped），失败为基线依赖缺失与既有失败，详见终报；`npm ci` → rc=1，`Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`。未新增依赖、无外部调用、未读 `.env` 或网关 key。
- 文件边界：`git diff 60fdc73..HEAD --name-only` 仅 `.s2d/plan.md`、`scripts/agentic/autonomy/**`、`tests/unit/agentic/autonomy/**`；未改 `contracts/agentic/**`、`scripts/serve-tango.mjs`、`scripts/build-web.mjs`、`.env`、`package-lock.json`。当前 HEAD：`b1bb47dc9dc50aa0999f94aa2f725db1568dd754`，提交含 `Co-Authored-By: ZCode`。
