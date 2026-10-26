# S2D · W0 阶段0 计划 DAG（契约冻结）

输入：BUILD-PLAN §2.2/§3-W0-1、PRD v0.2 §4/§5.2/§6.4/§6.5/§6.8.2/§8.1/§10.3/§10.4/§10.5。
产出根：worktree `/Users/chillbit/Proj/Done & Go/s2d/w0-contracts`（分支 feat/s2d-w0-contracts @ 65efc27）。

```
P1 写 29 份 contracts/agentic/*.schema.json（自包含 + 少量同目录 $ref）
    │   覆盖：PRD §4.1 十四对象 + §6.4 工单四件套(ArtifactRef/Evidence/Spend/GrantRef)
    │        + §6.8.2 感知三件 + §10.5 span + §6.5 Codex 两件 + API error 信封
    ├─ P2 fixtures/<name>.fixtures.json ×29（每份 ≥2 valid + ≥1 invalid，对象对齐 schema）
    ├─ P3 README.md：状态机(§4.2)/错误码表/API 列表(§10.4+)/规范化与 hash 规则/变更日志
    ├─ P4 scripts/agentic/contracts.mjs：零依赖校验器
    │      type/required/properties/enum/items/format(date-time|date|time)/additionalProperties/$ref
    │      + const/数值/长度/pattern/minItems/uniqueItems/minProperties/$defs/allOf|anyOf|oneOf|not
    │      + canonicalJson（稳定 key 排序）+ contractHash（SHA-256，剔除 hash 字段）
    ├─ P5 tests/unit/agentic/contracts/contracts.test.mjs：
    │      (a) 全量 fixtures 过/败 (b) 每关键字正反例 (c) hash 序不变/字段变测试
    ├─ P6 node --test 全绿 + --experimental-test-coverage ≥80%（contracts.mjs）
    └─ P7 git commit → 写 contracts/agentic/FROZEN=`v1 <commit>` → 追加提交
P8 证据 /Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w0-frozen.md
P9 submit_result {frozenCommit, schemaCount=29, evidencePath}
```

红线自查：只新增 contracts/agentic/**、scripts/agentic/contracts.mjs、tests/unit/agentic/contracts/**、.s2d/plan.md；无依赖新增；无外部调用；不碰 serve-tango/build-web/index.html。
