# impl-M22-golden-node（G5 · 组5）

- 节点：M22-golden-node（plan.md §G5）· w13·实现·M22-golden-node · 模型 zai-api/GLM-5.3$max（工作流统一绑定）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`（基线 b0ae63e，M21 之后）
- 交付：
  - `tests/agentic/integration/golden-handlers.mjs`（新增，~900 行）：brief §5 场景 1–7 的 node 侧场景 handler——**全部经 M13 组合根挂真实流件**（W1 block-store 路由/store、W3 mission 状态机/store、W4 evaluateAction/SideEffectFence/ConfirmationStore/AuditLog、W6 preview store/routes/applyPatch、W7 createAgentRuntime/createRuntimeStore、W9 artifact-store/acceptance/verifier(engine+saveVerdict)/need-store、W10 observability store、W12 perception store + harness vision mock、M15/M16 W13 接缝）
  - `tests/agentic/integration/golden-handlers.test.mjs`（新增，10 用例）：防御分支/纯函数定向单测
  - `tests/agentic/integration/harness.mjs`（修改）：默认挂载 golden handler（`options.golden===false` 可关，挂载序 health→golden→用户 handler→legacy）；端口绑定改真实 server 逐口直试（修 TOCTOU EADDRINUSE 抖动，pickHarnessPort 导出与语义不变）
  - `scripts/agentic/integration/context.mjs`（修改，附加导出）：`createW4PolicyPort` 导出（组合根行为零变化，M13 测试全绿）——golden 的 W7 policy 桥需要它
- 允许域核对：3 文件在 `tests/agentic/integration/**`、1 文件在 `scripts/agentic/integration/**`（红线 3）；`git status` 仅此 4 项；contracts/agentic 自 60fdc73 零行变化；FROZEN=`v1 b9d9bdfa…5734…` 未动。

## 场景→真实模块映射（详见模块头注与 evidence/s2d-w13-golden-node.md）

| 场景 | 场景端点 | 真实流件 |
|---|---|---|
| §5.1/§5.6 | GET /api/blocks、POST /api/blocks/sync | W1 createBlockRoutes 原样（shim req/res 喂裁剪批）+ 设备 ack cursor 台账（场景层增量同步编排：base 落后自身 ack 的非重放 change 降级 conflict；纯重放（base=rev-1 且九字段一致）放行） |
| §5.2 | POST /api/captures、GET …/scan、W6 preview/discuss/timeline | W12 createPerceptionStore.insertCapture + vision mock（pipeline.start）→ W6 createPreviewStore.put；W6 createPreviewRoutes 原样（parsePatch 注入场景确定性规则表：秒→boundary.wont.add，不做单位换算编造） |
| §5.3 | POST /api/contracts/:id/sign、/api/actions/:id/confirm·execute | W4 evaluateAction（grant 过期/失效先拒）+ SideEffectFence(execution) needs_human + ConfirmationStore 一次性令牌 + AuditLog（autonomy_audit_events 真实落库）+ 副作用台账；A5 → fence(P0) A5_NEVER_AUTOMATIC |
| §5.4 | POST /api/missions、/state、/runs、/api/runs/:id/resume | W3 transitionMission/store/appendEvent（admitted/planning/ready→scan/preview/contract）+ W7 createAgentRuntime（policyPort=M13 createW4PolicyPort 桥+动作形状适配在桥外、clock=adaptClockForRuntime、spanSink=traceSink.forOwner→obs_spans、modelCaller=harness 假 transport、store=createRuntimeStore）；crash 一次性注入+外部动作 (orderId,stepId) 幂等；exhaustAfter→workOrder.budget.calls→409 BUDGET_EXCEEDED（步检查点读回）；model:null→UNKNOWN 无 WorkResult 零重试 |
| §5.5 | POST /api/artifacts、/:id/verify·accept·revise、GET 列表/单读/versions/benefit、/api/inbox | W9 artifact-store.put/get/list/versions（家庭链=同 owner 场景工件族全部真实版本）、createAcceptance.record（真实状态机：ready 才可验收/accepted 关链/revise 开链+场景落修订草稿+createNeed）、verifier verify（check 证据从 body.check.status 派生，verdict 声明被引擎交叉验证）+saveVerdict、benefit=显式查 w9_acceptances/w9_verdicts→M16 projectAcceptedBenefit；跨 owner 读→真实 get 404 |
| §5.7 | POST /api/runs/:id/trace、GET /matrix | W10 upsertRun + traceSink→obs_spans（model.resolved span 带 actor/resolvedModel/modelSource/stale/conflicting）+ 逐 actor M16 projectModelProvenance（NULL→UNKNOWN、stale/conflict→至多 PROVISIONAL 不升级）；六类指标事件 |

## TDD（RED→GREEN，不删测试不放宽校验）

- RED（实现前）：`node --test tests/agentic/integration/golden-scenarios.test.mjs` → `# tests 7 # pass 0 # fail 7`（场景端点 404 no-handler → expected 200 断言失败）——M21 遗留的 G5 依赖态。
- GREEN：同命令 → `# tests 7 # pass 7 # fail 0`。过程修 10 项实现缺陷（含 M13 桥 action 覆盖契约、W7 runtime 实例闭包、步台账 id 键控、端口 TOCTOU），全部记录在 evidence 文件「TDD 缺陷修复记录」；冻结测试与 fixture 未改一字。
- 定向单测：golden-handlers.test.mjs 10/10；全套件 `node --test tests/agentic/integration/*.test.mjs` → 45/45，**连续 10 轮无抖动**（端口修复前 3 跑 1 失败）。
- 回归：`node --test tests/unit/agentic/integration/*.test.mjs` → 197/198，唯一失败 release-rollback（M26 既有 RED，M21 交接在案）。

## 覆盖率（node --experimental-test-coverage，tests/agentic/integration/*.test.mjs）

```
#    golden-handlers.mjs  | line 96.35 | branch 86.80 | func 87.91
#    harness.mjs          | line 98.13 | branch 86.05 | func 97.65
#    golden-handlers.test.mjs | 100.00 | 100.00 | 94.12
```

≥80% 达标（逐模块）；未覆盖为防御分支（shim 非 JSON 回放、fence 非 needs_human 拒绝等）。

## 红线自守

- 源码审计（grep 四文件）：无 `Date.now(`/无参 `new Date()`/`process.env`/`fetch(`/`child_process`；Date 构造仅注入时钟 epoch 换算。
- owner 一律取 dispatcher env.principal（服务端会话）；绝不读 body 内 owner 字段。
- 零真实外呼：模型/checker/gateway/vision/副作用全为 harness 假件；网络仅 127.0.0.1:17701–17709；W4 AuditLog/确认令牌/W10 spans/W9 台账全部落真实 SQLite（临时库）。
- 所有 actor 显式绑定模型（w13·golden-a4→golden-a4-model、w13·golden-runtime→fake-transport-model/grant.resolvedModel）；transport 返回 model=null → W7 UNKNOWN，无 WorkResult、零自动重试（红线 7 场景化验证）。
- contracts/agentic 零变化（git diff 60fdc73..HEAD 实测）；冻结测试/fixture 未改。

## 证据

- 汇总：`argus-cto/projects/donego/evidence/s2d-w13-golden-node.md`（逐场景输入/owner/事件序列/HTTP/最终状态 + 10 项缺陷修复记录）
- 逐场景 JSON（真实事件序列/HTTP 台账/最终状态）：同目录 `golden-{1..7}-*-evidence.json`（golden-8/pw 归 M23）

## 交接

- M23（golden-pw）：`createGoldenHarness` 默认已挂 golden handler（`golden:false` 可关）；W5/W11 页面走 build-web 产物 + serve-tango 挂载（M18/M19 已就位）。
- M24（coverage）：golden-handlers.mjs 已达标；aggregate 待 M24 汇总。
- M25/M26：unit 侧唯一失败 release-rollback 为 M26 范围（release.mjs 未实现）。
