# W7 M8 · w7-contract-consistency 实现记录（G4）

模块：`w7-contract-consistency`（组4，跨域契约一致性）。输入：`.s2d/plan.md` M8、`/private/tmp/donego-w7-brief-20261027.md`。

## 文件（1 个）

- `tests/unit/agentic/contracts/w7-contract-consistency.test.mjs`（RED 基线 7 例 → GREEN 收口 12 例；只新增对冻结 schema 的验证，schema/fixtures 零改动）

## 交付内容（12 例）

1. **冻结基线完整性**（4 断言组）：`FROZEN` 文件 == 常量 `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`；== `git show 60fdc73:contracts/agentic/FROZEN`（W0 基线 commit 直接对账）；`git status --porcelain -- contracts/agentic` 为空；`git diff --name-only HEAD -- contracts/agentic` 为空；`git diff --name-only 60fdc73 HEAD -- contracts/agentic` 为空（W0 以来零漂移）。
2. **8 份 fixtures 对账**：work-order / work-result / grant-ref / spend / evidence / step / connector / codex-choice 的 valid 全过、invalid 全拒（吃 W0 冻结样例）。
3. **G1 真实产出**：WorkOrder 入参与落库载荷（`w7_work_orders.work_order` JSON 重解析）各过 `work-order.schema.json`；真实 run（step 内走 `ctx.modelCall` 全链：policy→预算→注入 modelCaller）的 WorkResult/内嵌 Spend/每条 Evidence 逐字段过冻结 schema，且 `notes` 带 `resolvedModel=gpt-6-sol`（红线⑦：done 必有模型来源）；`store.listSteps` 取回的检查点载荷逐条过 `step.schema.json`，终态 `succeeded`。
4. **红线⑦ 负面**：step 既不调 modelCall 也不自报 model（modelCaller 若被调用即抛错）→ `status='unknown'`、**无 WorkResult**（`outcome.workResult === undefined`）、`getWorkResult` 为 null、`w7_unknown_outcomes` 台账留痕（只对账）。
5. **G2 真实产出**：M4 `selectModel('code')` 的 `codexChoice` 过 `codex-choice.schema.json`；M5 `createCompletionService` 用**真 selectModel 接线为注入 select port**（now/localAvailable 显式注入）+ mock transport → 结果带模型来源、`provenance.decidedAt` 等于注入时刻（红线⑥）、台账 selected 行 model 非空、recordedAt 由注入时钟派生（`toISOString()` 毫秒形式）；负面：选型与 transport 均无模型来源 → `{ok:false, reason:'no-model-source'}` + 台账 `unknown`（model=NULL），transport 恰好尝试 1 次。
6. **G3 真实产出**：登记 manifest 显式过冻结 `connector.schema.json`；M7 `invokeTool` 全链（真 M6 registry + 真 MCP client + 注入 mock transport + 真 audit store）干净内容 → `kind='external-content'`、`at` 等于注入 registry 时钟派生值、台账 `succeeded`；恶意外部内容（ignore-previous-instructions + reveal-system-prompt）→ `quarantined` + evidence 只带 `dataHash`（64-hex）与命中清单**不携带原文**、台账 `failed`、审计行 resultPayload 与返回结果一致。
7. **GrantRef**：WorkOrder.grants 内子集形状过 `grant-ref.schema.json`。

## 验证（本节点实测）

```
node --test tests/unit/agentic/contracts/w7-contract-consistency.test.mjs
→ # tests 12 / pass 12 / fail 0（rc=0）

node --test --experimental-test-coverage \
  tests/unit/agentic/runtime/*.test.mjs \
  tests/unit/agentic/model-router/*.test.mjs \
  tests/unit/agentic/tool-registry/*.test.mjs \
  tests/unit/agentic/contracts/w7-contract-consistency.test.mjs
→ # tests 215 / pass 215 / fail 0；rc=0
   aggregate line 98.65% | branch 94.30% | function 94.71%
   （全部 ≥80/80/80；逐模块见 coverage 表，
    本测试文件自身 99.73/95.35/97.44）

git diff --check → 干净（rc=0）
git status --porcelain → 仅本模块 1 文件 + .s2d 记录；contracts/agentic 零改动
```

## 决策与对账说明

1. **FROZEN 哈希 mismatch（文档 vs 仓库，按仓库为准）**：brief/plan 文本写 `b9d9bdfa0511905a95b729753b82e574adab6bb`（39 位十六进制，非法长度）；仓库文件与 W0 基线 commit `60fdc73` 均为 `b9d9bdfa0511905a95b729753b82e5734adab6bb`（40 位，多一个 `3`）。RED 基线常量沿用了文档笔误 → 测试失败。修复：常量对齐仓库/W0 基线（AGENTS.md：docs 与代码冲突时从代码），并把「与 60fdc73 内容逐字节一致」做成独立断言，比抄常量更强。终报需列此 mismatch。
2. **RED 基线两处既有失败的原因**（M5/M7 记录已做因果隔离）：①FROZEN 常量笔误（见上）；②「无模型来源」用例的场景缺陷——原用例的 step `execute` 自带 `model:'gpt-6-sol'`，engine.mjs:389-391 合法采纳 step 自报模型来源 → `done` 是正确行为，不是 engine bug。修复：场景改为 step 不调 modelCall 也不自报模型，并加台账/无 WorkResult 断言。
3. **时间戳毫秒形式**：M5 `recordedAt`、M7 `at` 由注入时钟经 `new Date(now).toISOString()` 派生 → `...T08:30:00.000Z`（毫秒形式）。确定性成立（仍源于注入时钟，无 wall clock），断言改为对「注入时刻的 ISO 派生值」相等，不放宽。
4. **M7 resultSummary 携带工具文本前 120 字符**是 M7 既有契约（凭据形态脱敏由 M7 测试钉死：`sk-[REDACTED]` 等）；M8 不重复该断言，改为钉「evidence 本体永不携带原文」+ 审计行与返回结果一致。
5. 门禁其余项（verify:web / test:unit / push + ls-remote 回读）归门禁节点，非本模块文件域。

## 红线自查

不碰主仓/classic/thinkpad/生产/LiteLLM/.env；未读写打印任何真实 key（全部注入字面量 mock）；未联网（transport/modelCaller/policyPort 全注入，无任何 socket）；未新增依赖（仅 node:test/assert/child_process/fs/path/url + 既有模块）；文件域仅本模块 1 测试文件 + 本记录；contracts/agentic 零改动（FROZEN 只读，git 断言钉死）；时钟全注入（createFixedClock / 字面量 ISO / 注入 epoch）；不删测试、不放宽校验（RED 基线 7 例全部保留并加强，12 例全绿）。
