# W9 G1-M2 verifier-domain 实现记录

- 日期：2026-10-27；worktree `/Users/chillbit/Proj/Done & Go/s2d/w9-delivery` @ `feat/s2d-w9-delivery`
- 规约输入：`.s2d/plan.md` G1-M2 + `tests/unit/agentic/verifier/*.test.mjs`（RED 规约，未改动）+ brief 裁决④（可注入检查器，UNKNOWN/失败不得升级为 VERIFIED）+ PRD §8.3（提示注入标记）。
- TDD 顺序确认：实现前先跑 `node --test tests/unit/agentic/verifier/dod-checker.test.mjs` → 1 fail（ERR_MODULE_NOT_FOUND，模块未建），RED 属实。

## 交付文件（9）

| 文件 | 说明 |
| --- | --- |
| `scripts/agentic/db/migrations/w9-2-verifier.sql` | `w9_verdicts`（owner/artifact/version/overall/ran_at，append-only）+ `w9_verdict_checks`（verdict_id+seq 主键，kind/ref/status/severity/reason 枚举 CHECK） |
| `scripts/agentic/verifier/shape.mjs` | 内部结构手工守护（冻结契约无 verdict schema，禁新增 schema 文件）：Check 形状、ISO date-time（镜像 contracts.mjs:5-6 规则）、CONTRACT_INVALID 工厂、evidenceOf 取数组守护 |
| `scripts/agentic/verifier/dod-checker.mjs` | `checkDod(artifact, dod)`：仅 `type='dod-check' && verified===true && detail===DoD 原文` 覆盖 → PASS，否则 UNKNOWN |
| `scripts/agentic/verifier/citation-checker.mjs` | `checkCitations(artifact)`：citation-list 需 uri 非空 + verified + detail 非空 → PASS，缺任一 → UNKNOWN |
| `scripts/agentic/verifier/command-result.mjs` | `parseCommandResult(result, ref)`：timedOut→UNKNOWN（优先于 rc）＞rc≠0→FAIL(HIGH)＞TAP 子集解析（not ok / # fail>0 → FAIL(HIGH)，全过 → PASS）＞不可解析/空输出→UNKNOWN |
| `scripts/agentic/verifier/injection-marker.mjs` | `checkInjection(text, ref?)`：钉死三类模式（忽略之前指令 / 请执行+非空内容 / ignore…previous instructions）→ FAIL(HIGH)；请参考/请查看/执行摘要等正常措辞不误报 |
| `scripts/agentic/verifier/engine.mjs` | `verify(artifact, dod, { checkers?, runCommand, clock })`：四类检查器全部可注入覆盖；命令来源=type='test-run' 且 uri 非空（缺 uri 不调 runner，UNKNOWN）；注入扫描=title+每条 evidence title/detail 聚合为一个 check；checker 抛异常/坏形状→UNKNOWN 不崩；clock 强制注入；overall=任一FAIL→FAILED＞任一UNKNOWN→UNKNOWN＞全PASS且非空且存在 dod-item check→VERIFIED＞其余 UNKNOWN（无 DoD 核验不给免费 VERIFIED） |
| `scripts/agentic/verifier/verdict.mjs` | `saveVerdict(db, ownerId, verdict, { idGen?, events? })`：形状守护→CONTRACT_INVALID；写 1 verdict + 每 check 1 行；默认 id=crypto.randomUUID（idGen 可注入）；events.emit({type:'verdict.saved',ownerId,objectType:'verdict',objectId,at:ranAt,data}) |
| `scripts/agentic/verifier/db-gate.mjs` | `dbVerdictGate(db, ownerId)` → `async (artifactId, version) => {blocking, unknownCount, highFailCount}`：取最新 verdict（ran_at DESC, rowid DESC）；任一 UNKNOWN 或 FAIL+HIGH → blocking；MEDIUM/LOW FAIL 不阻断（plan 字面）；无 verdict/跨 owner/版本不匹配/入参非法 → fail closed blocking=true |

另有实现期补充测试 `tests/unit/agentic/verifier/defensive.test.mjs`（10 test，只加不删不放宽；覆盖 db-gate/engine/verdict 的 fail-closed 防御分支，满足逐模块 branch≥80% 门禁）。

## 设计裁决（偏离/张力记录）

1. **VERIFIED 需存在 dod-item check**：engine 测试 'nothing to check stays UNKNOWN' 与 'fully passing' 并存，迫使规则超出“checks 非空”——无任何 DoD 核验发生时（dod 为空或 dod checker 产出空）不给 VERIFIED。与 brief 裁决④“缺失不得升级”同向。
2. **注入扫描聚合为一个 check**：engine 测试用 `checks.find(kind==='injection-marker')` 断言 FAIL，逐文本多 check 会让 find 命中干净的 title 扫描；聚合后任一命中即唯一 FAIL check（ref=首个命中来源），全干净一个 PASS，无任何可扫文本→UNKNOWN（不送免费 PASS）。
3. verdict 为 W9 内部结构，无冻结 schema：形状在 shape.mjs/verdict.mjs 手工守护，未新增任何 schema 文件（红线2）。
4. `new Date(Date.UTC(...))` 仅用于校验给定字符串的日历合法性（确定性 UTC 数学，非 wall clock）；业务路径 ranAt 全部来自注入 clock（红线6）。

## 验证（本机实跑）

```text
node --test tests/unit/agentic/verifier/{verdict,dod-checker,citation-checker,command-result,injection-marker,engine,db-gate,defensive}.test.mjs
# tests 66 / pass 66 / fail 0（rc=0）
node --test --experimental-test-coverage <同上 8 文件>
# 逐模块（scripts/agentic/verifier/）：
#   citation-checker 100/90.91/100 · command-result 97.70/92.11/100 · db-gate 100/100/100
#   dod-checker 100/92.31/100 · engine 100/93.59/100 · injection-marker 100/91.67/100
#   shape 100/95.00/100 · verdict 100/100/100  （line%/branch%/funcs%，全部 ≥80）
# all files 98.87 / 96.04 / 99.17
node --test tests/unit/agentic/contracts/contracts.test.mjs   # 12/12 pass（基线未受影响）
```

- M4 `w9-contract-consistency.test.mjs` 本节点不可跑：import 的 `scripts/agentic/inbox/need-store.mjs`（M3）尚缺——按 plan 属 G2 串行收口，不属本模块。
- 与并行 M1 共存验证：`w9-1-delivery.sql`（M1）已在 migrations 目录时，我域 66 测试仍全绿（migrate 词典序双迁移无冲突）。
- 约束自查：未 spawn/联网/读 key；无新增依赖（仅 node:crypto.randomUUID）；未触碰 contracts/agentic/**、W3/W4/W6/W10、serve-tango、web/**、.env；未挂载任何 HTTP route。
