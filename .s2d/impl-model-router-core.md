# M4 model-router-core 实现记录

- 模块：`scripts/agentic/model-router/router.mjs`、`tests/unit/agentic/model-router/router.test.mjs`（plan.md M4，组2）。
- RED 基线：commit `7bf2dd2` 已含 router.test.mjs（13 cases）；实现前实测
  `node --test tests/unit/agentic/model-router/router.test.mjs` → 整文件 `not ok 1`（ERR_MODULE_NOT_FOUND：router.mjs 不存在）。
- 新增实现（本轮只此一个源文件 + 测试补充，fileCount=2）：
  - `selectModel(taskClass, dataClass, {actor, budget, localAvailable, now, rateLimit?})` 纯选择函数：
    同步、不做真实调用、不读 key、不落盘、不读真实 wall clock（brief 裁决④ + 红线⑥）。
  - 返回 `{status:'selected'|'unknown', model?, provider?, locality:'local'|'cloud', provenance{rule,inputsHash,decidedAt}, reason, codexChoice?}`；
    unknown 决策不带 model/provider/locality（测试钉死 `locality===undefined`，绝不给 unknown 附 locality）。
  - 校验顺序（全 fail closed，负面路径优先）：
    1. taskClass 非空字符串，否则 CONTRACT_INVALID（null/''/undefined 全拒）；
    2. dataClass ∈ public|personal|sensitive|secret，否则 CONTRACT_INVALID；
    3. dataClass=secret → 直接抛 FORBIDDEN（secret 永不进任何模型；先于一切规则，code/reason/summarize 均拒）；
    4. opts 必须为对象；actor 非空字符串（brief ⑦：所有 actor 显式绑定）；budget={calls,tokens} 非负有限数，
       calls===0 或 tokens===0 → BUDGET_EXCEEDED（无额度即无选择）；localAvailable 必须显式 boolean（不得猜本地可用性）；
    5. now 必须注入且可 Date.parse（ISO-8601）→ provenance.decidedAt 原样回填；缺失/不可解析 → CONTRACT_INVALID，
       message 含 now/clock（红线⑥：禁止真实 wall clock）；
    6. rateLimit 可选：weeklyUsed∈[0,1]、spendControlReached boolean，非法 → CONTRACT_INVALID。
  - 规则表（测试文件即规格）：
    - sensitive 闸门优先于 taskClass 规则：localAvailable → selected(local, 'local-small', provider='local')；
      否则 status=unknown（绝不降级上云）；sensitive+code 也只走本地、不产 codexChoice。
    - code → Codex 自适应（cloud, provider='codex'）：weeklyUsed≥0.9 或 spendControlReached 或 budget.tokens<8000
      → gpt-6-luna/low；否则 gpt-6.1-sol/high。产出 codexChoice 后立即 assertValid 过冻结
      codex-choice.schema.json（懒加载缓存，schema 目录由模块位置解析，FROZEN 只读）才返回；
      未注入 rateLimit 时按 schema 必填补 weeklyUsed=0，reason 如实写明（不猜默认模型 ≠ 不填必填字段）。
    - reason → gpt-6-sol（cloud, codex）；summarize → 本地优先（local-small），无本地回落 gpt-6-luna（cloud）。
    - 其余 taskClass → status=unknown + rule='no-rule-match'（不猜默认模型）。
  - provenance：rule 命名（sensitive-local-only / code-codex-adaptive / reason-sol / summarize-local-first / no-rule-match）；
    inputsHash = sha-256(canonicalJson({taskClass,dataClass,actor,budget,localAvailable,rateLimit?}))——
    canonicalJson 复用 W0 冻结校验器 `scripts/agentic/contracts.mjs` 的导出（全流共享基线，非跨组业务依赖）；
    decidedAt 不进 hash（同输入不同注入时刻 → 同 hash，有测试钉死）；G2 不 import G1 runtime/**（plan「无跨组源文件依赖」），
    错误工厂为本文件私有最小实现（FORBIDDEN/BUDGET_EXCEEDED/CONTRACT_INVALID，均在冻结 api-error 枚举内，
    未知内部码抛 TypeError 不编造）。
- 测试（只增不删）：在 RED 基线 13 cases 上追加 6 个测试（合计 19）：tokens=0/预算缺失/非法、rateLimit 非法、
  opts/actor/localAvailable/now 缺失、sensitive 优先于 code、unknown 决策 provenance 完整性、
  code 未注入 rateLimit 的 codexChoice 形状。
- GREEN 证据（本 worktree 实测，2026-10-27）：
  - `node --test tests/unit/agentic/model-router/router.test.mjs` → `# tests 19 / # pass 19 / # fail 0`。
  - `node --test --experimental-test-coverage tests/unit/agentic/model-router/router.test.mjs` →
    router.mjs：**99.29% line / 97.56% branch / 100% function**（≥80% 达标；
    未覆盖仅 43-44：内部错误码 TypeError 自我防护，不可达于公开 API，属编程错误绊线）。
    全 targeted 套件（含 M8 `tests/unit/agentic/contracts/w7-contract-consistency.test.mjs`，其直接 import selectModel
    再走一遍 Codex 路径）同表下 router.mjs 为 99.29 line / 98.77 branch；两口径均 ≥80%。
    （call.mjs 不 import router.mjs——其 select 为注入鸭子类型端口，实测 G1+G2 套件下仍为 97.56 branch。）
  - 全 targeted 门禁形式（plan 修订版文件通配）：
    `node --test --experimental-test-coverage tests/unit/agentic/runtime/*.test.mjs tests/unit/agentic/model-router/*.test.mjs tests/unit/agentic/tool-registry/*.test.mjs tests/unit/agentic/contracts/w7-contract-consistency.test.mjs`
    → 138 tests / 134 pass / 4 fail：4 个失败全部是 tool-registry（M6/M7 尚未实现，registry.mjs ERR_MODULE_NOT_FOUND，
    归 M6/M7 节点，非本模块回归）；runtime+model-router 合计 129/129 全绿。
- 红线自查：未碰 contracts/agentic/**（只读 loadSchema）；未 import runtime/**（G1）；无新依赖（仅 node: 内建 + 冻结契约）；
  无网络/无 key（纯函数）；时钟仅注入 now；同组 M5 文件（call.mjs/transport.mjs/w7-2 SQL/call.test.mjs）未改动，归 M5 提交。
