# M06-audit-fail-closed 实现记录

## 契约映射与负面路径

- 计划 `.s2d/plan.md:36,43-49`：M06 覆盖 Grant 发放/消费/撤销、策略拒绝、确认、A3+ 动作、UNKNOWN/恢复审计；审计写入失败必须阻断动作。
- PRD `design/schedule-to-delivery/PRD.md:195-210`：contracted 前无外部后果；A4 每次单独确认；A5 永不自动。
- CTO 决策 `design/schedule-to-delivery/CTO-DECISIONS-2026-10-27.md:31-39` 与简报 `CTO-BATCH2-BRIEF-2026-10-27.md:36-42`：P0 无外部副作用、A4 显式确认、A5 不自动、审计 fail-closed、模型 UNKNOWN 不得升级为成功。
- 负面路径固化：审计 writer 失败后 latch 为 unavailable；策略拒绝/UNKNOWN/确认拒绝、Grant 事件和 action result 都保留事件类型；UNKNOWN 恢复仅记录 not_retried；result 审计失败不返回 succeeded。

## 实现文件

- `scripts/agentic/autonomy/audit.mjs`：事件类型规范化、actor/model provenance 展开、fail-closed latch、Grant/policy/confirmation/action/UNKNOWN/recovery 事件辅助方法；`createDatabaseAuditWriter()` 结构化写入。
- `scripts/agentic/db/migrations/autonomy-001-audit.sql`：仅新增 W4 允许的 audit event 表及 action/owner 索引；不改 W0 schema。
- `scripts/agentic/autonomy/runtime.mjs`：确认消费、策略拒绝、允许动作、未知结果、恢复不重做和 result audit 均落审计；审计失败阻断或 UNKNOWN。
- `scripts/agentic/autonomy/side-effect-fence.mjs`：P0/A5/UNKNOWN/审计写失败封锁，并保留可审计 blocked/needs_human 结果。
- `tests/unit/agentic/autonomy/audit.test.mjs`、`policy-boundaries.test.mjs`、`side-effect-fence.test.mjs`：先行负面测试和 SQLite 持久化测试；现有 autonomy 测试继续覆盖重复、过期、断线、恢复、幂等。

## 检查证据

- RED（本 ask 实际执行）：`node --test tests/unit/agentic/autonomy/*.test.mjs` → rc=1，初始 39 tests / 34 pass / 5 fail：policy-boundaries 缺少 hash/actor/window 约束，side-effect-fence 模块缺失；随后补齐实现。
- M06 GREEN（本 ask 实际执行）：`node --test tests/unit/agentic/autonomy/*.test.mjs` → rc=0，50/50 pass。
- 覆盖率（本 ask 实际执行）：`node --test --experimental-test-coverage tests/unit/agentic/autonomy/*.test.mjs` → rc=0，50/50 pass；all files line 97.21%、branch 87.91%、function 92.86%。
- 语法/空白（本 ask 实际执行）：`for f in scripts/agentic/autonomy/*.mjs tests/unit/agentic/autonomy/*.test.mjs scripts/agentic/db/migrations/autonomy-*.sql; do ... node --check ...; done; git diff --check; printf 'syntax_and_whitespace_rc=0\\n'` → rc=0，输出 `syntax_and_whitespace_rc=0`。
- 全仓单测门禁（本 ask 实际执行）：`npm run test:unit` → rc=1，1020 tests / 1011 pass / 7 fail / 2 skipped；失败为既有基线项（metric-layout、design-system、streamChat、collaboration 两项、voice-pipeline ASR、voice-pipeline-gateway）；本流 autonomy 测试通过。完整输出由工具保存，摘要命令输出列出 7 个 `not ok`。
- Web 门禁（本 ask 实际执行）：`npm run verify:web` → rc=0，227/227 pass。
- 依赖事实（计划已有、未重跑）：`.s2d/plan.md:49` 记录 `npm ci --prefix ...` rc=1，`Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`；本 ask 未修改 lock、未新增依赖。
- 外部调用/密钥：本 ask 未调用外部服务，未读取 `.env` 或 gateway key；未触碰主仓/生产/Done-Go-classic。

## 未决与边界

- 全仓 `npm run test:unit` 的 7 个失败仍为门禁阻断/基线对账项，不能宣称全仓全绿；本流 50/50 单测与覆盖率门通过。
- `npm ci` lock 漂移沿用计划记录，未验证为本 ask 新问题。
- 审计表采用 payload_json 保存事件扩展字段；跨流持久化查询/运行器接缝由后续 W7/W10/W13 负责。
