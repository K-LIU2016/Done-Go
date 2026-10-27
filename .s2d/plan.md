# S2D · W9 计划 DAG（Artifact Store / Verifier Kit / Inbox）

输入（本流唯一裁决源）：`/private/tmp/donego-w9-brief-20261027.md` + PRD v0.2（§4/§5.5/§5.6/§6.3/§6.4/§7-A11/A13/A17/§8.3/§10.2/§10.4）+ BUILD-PLAN §2/§3/§4 + CTO-DECISIONS-2026-10-27 + worktree 冻结契约（FROZEN=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`，`scripts/agentic/contracts.mjs`，`scripts/agentic/db/index.mjs`）。
产出根：worktree `/Users/chillbit/Proj/Done & Go/s2d/w9-delivery` @ `feat/s2d-w9-delivery`（基 60fdc73）。
启动事实：`npm ci` rc=1（package-lock 缺 `sherpa-onnx-win-arm64@2.0.0`，brief 已知，不修 lock）；targeted 测试用 `node --test` 直跑无需 node_modules（探针：contracts.test.mjs 12/12 pass, node v22.22.2；注意 node --test 传目录参数在本机失败，须传文件路径或 glob）。

## 模块 DAG（同组文件零交叉；G1 三域并行，G2 串行收口）

```
G1-M1 delivery-domain ──────┐
G1-M2 verifier-domain ──────┼──→ G2-M4 w9-contract-consistency（+ 门禁/报告）
G1-M3 inbox-domain ─────────┘
```

### G1-M1 delivery-domain（A11 artifact-store）
- 文件：`scripts/agentic/delivery/**`（artifact-store.mjs、acceptance.mjs、benefit.mjs、routes.mjs、util.mjs）、`scripts/agentic/db/migrations/w9-1-delivery.sql`、`tests/unit/agentic/delivery/**`
- 迁移表（钉死）：`w9_artifacts`（id, owner_id, mission_id, current_version, title, type, status, location, source, created_at, updated_at, deleted_at NULL——软删=状态事件不抹版本）、`w9_artifact_versions`（artifact_id, owner_id, version≥1, content_hash, source, evidence_json, created_at, created_by；UNIQUE(artifact_id, version)；版本号服务端分配=max+1）、`w9_acceptances`（id, owner_id, artifact_id, artifact_version, mission_id, actor, decision, comment, created_at）、`w9_artifact_events`（append-only：status/withdraw/软删事件）。
- 子任务：
  1. TDD 负面路径先行：跨 owner 读/写/验收（NOT_FOUND/FORBIDDEN 按 README §owner 隔离）、版本回退/覆盖（CONFLICT）、非法 acceptance transition（对 generating/rejected 再 accept；对非最新版本验收）、重复提交幂等（同 content_hash 重复 put 返回既有版本）、未绑定 evidence、用户 rejected/revision 后不得进收益。
  2. `createArtifactStore({ db, clock, idGen })`：put/get/list/versions；content_hash=对内容载荷 `contractHash`（contracts.mjs:29）；evidence 逐条过 evidence.schema.json，artifact 对象过 artifact.schema.json（经 `$ref` 自动带 evidence）；createdAt/来源/hash/版本号全部服务端生成，客户端提交这些字段即拒绝；删除/撤回只写 `w9_artifact_events`。
  3. `createAcceptance({ db, clock, idGen })`：accept|revise|reject → decision 枚举映射（accepted/revision_requested/rejected）；绑 artifact 最新 version+owner+actor+comment+时间；acceptance 对象过 acceptance.schema.json；revision→允许新版本继续、rejected→学习信号事件；actor 必须是用户 actor（拒绝 agent 自报）。
  4. `benefit.mjs`：纯函数 `acceptedBenefit(acceptance, verdictSummary)` —— 仅 decision=accepted 且 verdictSummary.blocking=false 才计入；verdictSummary 由注入的 `verdictGate(artifactId, version)` 提供（M1 不 import M2，不读 verdicts 表；组合在 M4 验证）。
  5. `createDeliveryRoutes({ db, auth, clock, verdictGate })` → `(req,res,pathname)=>handled`：`GET /api/artifacts/:id`（?version=）、`POST /api/artifacts/:id/accept|revise|reject`（revise 必须带 comment）；未登录 401 AUTH_REQUIRED；错误信封按 api-error 枚举；不挂 serve-tango（W13 归属）。
  6. 事件 sink：`createX({ events })` 注入 `{ emit(evt) }`（evt={type,ownerId,objectType,objectId,at,data}），默认 no-op；W10 只经此对接。
- 依赖：无（G1 并行）。时钟/idGen 强制显式注入，业务路径禁真实 wall clock。

### G1-M2 verifier-domain（A17 verifier-kit）
- 文件：`scripts/agentic/verifier/**`（verdict.mjs、dod-checker.mjs、citation-checker.mjs、command-result.mjs、injection-marker.mjs、engine.mjs、db-gate.mjs）、`scripts/agentic/db/migrations/w9-2-verifier.sql`、`tests/unit/agentic/verifier/**`
- 迁移表：`w9_verdicts`（id, owner_id, artifact_id, artifact_version, overall, ran_at）、`w9_verdict_checks`（verdict_id, kind, ref, status, severity, reason）。
- Verdict 形状（W9 内部结构，冻结契约无此 schema，不得新增 schema 文件）：`{ artifactId, version, overall: 'VERIFIED'|'FAILED'|'UNKNOWN', checks: [{ kind: 'dod-item'|'citation'|'command-result'|'injection-marker', ref, status: 'PASS'|'FAIL'|'UNKNOWN', severity: 'HIGH'|'MEDIUM'|'LOW', reason }], ranAt }`。
- 子任务：
  1. TDD 负面路径先行：DoD 缺项、缺失/未核验 evidence（evidence.uri=null 或 verified!==true）、命令非零 rc/超时/无法解析、外部内容提示注入标记、任一 UNKNOWN——全部不得升级为 VERIFIED（overall 保持 UNKNOWN 或 FAILED）。
  2. 检查器全部可注入：`verify(artifact, dod, { checkers, runCommand, clock })`；`runCommand` 是注入的 mock（返回 {rc, stdout, timedOut}），引擎绝不 spawn、不联网、不读 key（红线5）。
  3. dod-checker：每条 DoD 必须有对应 evidence(type='dod-check', verified=true) 覆盖，缺→UNKNOWN；citation-checker：citation-list 必须可达/已核验（由注入 checker 判定，缺 uri/detail→UNKNOWN）；command-result：纯文本解析（退出码/TAP 摘要），rc≠0→FAIL(HIGH)、timedOut→UNKNOWN、解析失败→UNKNOWN；injection-marker：工件/证据文本命中指令式模式（"请执行/忽略之前指令"类，PRD §8.3）→FAIL(HIGH) 且整体不 VERIFIED。
  4. `dbVerdictGate(db)`：读 w9_verdicts/w9_verdict_checks → `{ blocking }`（存在 UNKNOWN 或 HIGH-FAIL 即 blocking=true）；导出给 W13 组装与 M4 组合测试用。
  5. 持久化 verdict + 注入 events sink（同 M1 接口）；ranAt 用注入 clock。
- 依赖：无（G1 并行）。

### G1-M3 inbox-domain（A13 inbox）
- 文件：`scripts/agentic/inbox/**`（need-store.mjs、expiry.mjs、attention-projection.mjs、routes.mjs）、`scripts/agentic/db/migrations/w9-3-inbox.sql`、`tests/unit/agentic/inbox/**`
- 迁移表：`w9_needs`（id, owner_id, mission_id, type, question, due_at, default_action NULLABLE, status, answer, answered_at, revision）、`w9_need_events`（append-only 生命周期事件）、`w9_attention_items`（need_id, owner_id, kind, payload, state, unknown_flag, updated_at）。
- 子任务：
  1. TDD 负面路径先行：Need 越权回答（跨 owner）、旧 revision 回答（CONFLICT）、过期 Need 回答（拒绝，只能 defaulted/expired 语义）、无默认超时（default_action=NULL 到期不迁移、attention unknown_flag=1 继续等待）、重复 answer（同 owner/need/revision 幂等返回首答）。
  2. `createNeedStore({ db, clock, idGen })`：createNeed/open/answer/waive；status 机 `open → answered|defaulted|waived|expired`（README §状态机）；answer 幂等键 (owner_id, need_id, revision)。
  3. `expiry.mjs`：`sweep(now)` 确定性时钟——仅 default_action 显式存在才 defaulted；NULL→保持 open 且 attention unknown_flag=1；不发送任何邮件/推送/不改日历（红线3）。
  4. `attention-projection.mjs`：Need → AttentionItem 投影行（W9 只写投影数据，SSE/HTTP 推送归 W13）；注入 events sink。
  5. `createInboxRoutes({ db, auth, clock })`：`GET /api/inbox`、`POST /api/needs/:id/answer`（body {answer, revision}）；owner 隔离；错误信封同 README。
- 依赖：无（G1 并行）。

### G2-M4 w9-contract-consistency（串行收口，依赖 M1+M2+M3）
- 文件：仅 `tests/unit/agentic/contracts/w9-contract-consistency.test.mjs`（不改 contracts/agentic/**）
- 子任务：
  1. 三域产出的 artifact/artifact-ref/evidence/acceptance/need 对象全部过冻结 schema（contracts.mjs validate）；能吃下 W0 fixtures（artifact/acceptance/evidence/need 各自 fixtures 复用）。
  2. FROZEN 基线断言：`contracts/agentic/FROZEN` 仍为 `v1 b9d9bdfa...6bb`，schema 文件 hash 未变（防实现期偷改契约）。
  3. 跨域组合测试：accepted + verdictGate blocking=true（有 UNKNOWN/HIGH）→ 不进收益；blocking=false → 进；rejected/revision_requested → 不进（用户验收≠agent 自报）。
  4. 端到端负面链：跨 owner 全链拒绝（store→acceptance→inbox answer 均按 NOT_FOUND/FORBIDDEN）。
- 依赖：M1、M2、M3 全部完成。

## 钉死的跨模块接口（G1 并行的防漂移契约）

- clock：`clock.now() → ISO date-time 字符串`（与 schema format 一致），业务路径强制注入，禁 `Date.now()/new Date()`。
- idGen：`idGen() → string`；事件 sink：`events.emit({type, ownerId, objectType, objectId, at, data})`，默认 no-op。
- verdictGate：`(artifactId, version) → Promise<{ blocking: boolean, unknownCount, highFailCount }>`；M2 提供 `dbVerdictGate(db)` 实现。
- 迁移文件名固定：`w9-1-delivery.sql`、`w9-2-verifier.sql`、`w9-3-inbox.sql`（migrate 按文件名排序，见 scripts/agentic/db/index.mjs:67）。
- 错误码只用 README 枚举（AUTH_REQUIRED/FORBIDDEN/NOT_FOUND/CONTRACT_INVALID/CONFLICT/NEED_HUMAN/INTERNAL_ERROR…），信封 `{error:{code,message,details?,requestId?}}`。

## 契约张力（不改 schema，记录进终报）

1. brief 裁决②要求内容 hash——artifact.schema.json 无 hash 字段且 additionalProperties:false → hash 存 DB 列 `w9_artifact_versions.content_hash`，契约对象保持 schema 纯净。
2. brief 裁决③要求 acceptance 绑 version/owner——acceptance.schema.json 只有 artifactId/actor/decision/comment/createdAt → owner_id+artifact_version 存 DB 列，对外对象按冻结 schema 校验。
3. need.schema.json 要求 defaultAction 枚举非空，brief 裁决⑤允许"无默认→UNKNOWN/继续等待" → DB `default_action` 可空；无默认的 need 不物化为冻结 Need 对象（对外走 AttentionItem 投影），仅显式配置默认的 need 才按 need.schema.json 校验输出。
4. 文档冲突（按全局 AGENTS.md 列出）：CTO-DECISIONS §4 批次二表把 W9 写成"多端同步和恢复（W1、W3）"，与 brief（唯一裁决源）和 PRD §11 表"W9 交付与验证 A11+A17+A13"不一致——以 brief/PRD 为准。

## 门禁（G2 后跑，逐条记 rc）

1. targeted：`node --test --experimental-test-coverage tests/unit/agentic/delivery/*.test.mjs tests/unit/agentic/verifier/*.test.mjs tests/unit/agentic/inbox/*.test.mjs tests/unit/agentic/contracts/w9-contract-consistency.test.mjs` rc=0；line/branch/function ≥80%（逐模块+aggregate 都报）。
2. `npm run verify:web` rc=0；`npm run test:unit` 与基线对账（BUILD-PLAN §2.4-2 三个已知失败 + §2.4-3 tango-release 例外），不新增失败。
3. `git diff --check` 干净；push 分支 `git ls-remote` 回读；禁 main/force/--no-verify；不删测试不放宽校验。
4. 报告：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/s2d-w9-report.md`；证据 `evidence/s2d-w9-<节点>.md`；明确未挂载主服务、未发邮件/通知、未做真实用户验收。
```

红线自查（全模块）：只碰 brief 文件归属内的路径；contracts/agentic/**、W3/W4/W6/W10、serve-tango.mjs、web/**、.env、主仓/LiteLLM 一律不碰；不新增依赖；不打印/读取任何 key；所有 actor 显式绑定模型，resolved_model=NULL→UNKNOWN。
