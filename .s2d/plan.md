# S2D-W13 最终集成 · 盘点规划（plan.md）

- 生成：2026-10-28 · w13·规划（模型 zai-api/GLM-5.3$max，工作流统一绑定）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`，当前 HEAD=60fdc73（W0 基线，实测 `git rev-parse HEAD`）
- 冻结契约：`contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`（磁盘真值；勿用 …574… 笔误值）
- 输入：brief（/private/tmp/donego-w13-brief-20261027.md）、PRD/BUILD-PLAN/CTO-DECISIONS、批次一矩阵 v2、s2d-w0..w12 终报、evidence/ 索引。报告仅作证据索引，代码与新鲜命令为权威。
- 本文件覆盖 W0 遗留 plan.md（未跟踪残留，M00 随本文件一并提交，防 M01 merge rc=2）。

## 0. 盘点结论（全部本会话实测）

### 0.1 十二流 tip 核对（brief §2 顺序，逐一 `git rev-parse`）

| 序 | 流 | 分支 | brief tip | 实测 tip | merge-base(vs 60fdc73) | b9d9bdf 祖先 | contracts 自基线 delta | FROZEN |
|---|---|---|---|---|---|---|---|---|
| 1 | W2 | feat/s2d-w2-engine | 862e4f9 | 862e4f9 ✓ | 43f12b3 | yes | 0 | v1 b9d9bdf…5734… ✓ |
| 2 | W1 | feat/s2d-w1-blocksync | 3033265 | 3033265 ✓ | 43f12b3 | yes | 0 | ✓ |
| 3 | W8 | feat/s2d-w8-codex-bridge | 9a6dfdf | 9a6dfdf ✓ | 60fdc73 | yes | 0 | ✓ |
| 4 | W11 | feat/s2d-w11-media | 4a51457 | 4a51457 ✓ | 43f12b3 | yes | 0 | ✓ |
| 5 | W12 | feat/s2d-w12-perception | 8cd9b4f | 8cd9b4f ✓ | 43f12b3 | yes | 0 | ✓ |
| 6 | W5 | feat/s2d-w5-frontend | 1d638af | 1d638af ✓ | 60fdc73 | yes | 0 | ✓ |
| 7 | W3 | feat/s2d-w3-mission | c972ba7 | c972ba7 ✓ | 60fdc73 | yes | 0 | ✓ |
| 8 | W4 | feat/s2d-w4-autonomy | c9a865b | c9a865b ✓ | 60fdc73 | yes | 0 | ✓ |
| 9 | W6 | feat/s2d-w6-preview | cbc79ed | **cbc79ed ✓（报告 df106ae 已过期）** | 60fdc73 | yes | 0 | ✓ |
| 10 | W7 | feat/s2d-w7-runtime | 1388636 | 1388636 ✓ | 60fdc73 | yes | 0 | ✓ |
| 11 | W9 | feat/s2d-w9-delivery | 472b6d4 | 472b6d4 ✓ | 60fdc73 | yes | 0 | ✓ |
| 12 | W10 | feat/s2d-w10-observability | f06d7e5 | f06d7e5 ✓ | 60fdc73 | yes | 0 | ✓ |

- **零漂移于 brief**：12 tip 全部一致；但 W6 终报 HEAD=df106ae 落后分支 3 个 remediation 提交（1e9740a 单事务 applyPatch / 2fb0ab5 错误映射钉 FROZEN README / cbc79ed length unit fact，6 文件 +563/−91，`git log df106ae..cbc79ed` 实测）——**以代码 cbc79ed 为准**。
- **W1/W2/W11/W12 merge-base=43f12b3**（先于 60fdc73 合并 W0）：四流树内 contracts 为 43f12b3 版，但各自对 contracts 零改动（diff 自 merge-base=0）→ 3-way 合并自动保留 60fdc73 侧，无冲突；**但四流的一致性测试从未对 60fdc73 的 PRD 对齐 schema（contract/context-delta/grant/connector+fixtures 改动）跑过**，合入后必须重跑各流 targeted 套件（R-6）。
- W7 报告行 3 FROZEN hash 笔误 …57**4**adab6bb（非有效对象名）；W9 报告已自纠（31dbbe5）。以 `contracts/agentic/FROZEN` 文件为准。

### 0.2 文件交叉矩阵（`git diff --name-only 60fdc73..HEAD` 逐流实测）

- **源码零交叉**：scripts/agentic/ 下 12 流目录互不重叠（block-store / engine / mission / autonomy / preview / runtime+model-router+tool-registry / bridge-hub+packages/donego-bridge / delivery+verifier+inbox / observability / media+composer+tts / perception / integration 留空归 W13）。
- **web/**：W1 `web/index.html`+`web/agentic/sync.js`；W5 `web/agentic/{ui/,assets/,agentic.css,component.html,demo.html}`；W11 `web/agentic/reel/{player.js,reel.css,README.md}`——路径互斥无文件冲突；W5 reel-player.js（ui/）与 W11 player.js（reel/）为不同文件、播放接缝。
- **migrations**（17 文件合入同一 `scripts/agentic/db/migrations/`；W0 基线该目录**不存在**，实测 ls）：
  - 文件名零冲突；字典序=autonomy-001/002 → blocks-001 → bridge-001 → engine-001..004 → mission-001 → obs-001/002 → perception-0001 → preview-001/002 → w7-1..3 → w9-1..3。
  - **DDL 表名零冲突**（逐文件 grep CREATE TABLE/INDEX 实测）。语义重叠：W2 `runs/run_steps/grants/audit/outbox/event_timers` vs W3 `missions/mission_grants/grant_provenance/mission_audit/mission_idempotency` vs W4 `autonomy_*` vs W7 `w7_work_orders/w7_agent_steps` vs W10 `obs_runs/obs_steps/obs_grants/obs_acceptances/obs_needs`（W3/W9 镜像投影）。
  - 幂等：全部 `IF NOT EXISTS` **除 W6 preview-001/002（裸 CREATE TABLE/INDEX）**——靠 W0 `migrate()` 的 `_migrations` 台账单次执行；幂等检查=同 db 双跑 `migrate()` → applied=[]。
  - 双台账：W2 `applyEngineMigrations` 用 `_engine_migrations` 只认 `engine-*.sql`；W0 `migrate()` 会全量纳入。组合根**只走 W0 migrate 单台账**（engine-*.sql 均 IF NOT EXISTS，重复无害但禁止两条路径都跑）。
- **tests/**：共享目录 `tests/unit/agentic/contracts/`（W7 加 w7-、W9 加 w9-contract-consistency.test.mjs，文件名不同无冲突）；W5 单测在 `tests/agentic/ui/unit/`（不在 test:unit 收集内，须显式 glob）。
- Playwright：W1 blocks 两 config（17601-17609 段）与 W5 ui config 目录隔离；W13 用 17701-17719。

### 0.3 接缝实测（route factory / auth / clock / id / events，逐文件读签名）

| 流 | 工厂（实测签名） | auth 形状 | clock/id/events |
|---|---|---|---|
| W1 | `createBlockRoutes({store, authenticate, requestAllowed, now})`（routes.mjs:31） | `authenticate(req)` | `now` 注入 |
| W3 | `createMissionRoutes({db, auth, store})`（routes.mjs:60） | **`auth.ownerId(req)`**（routes.mjs:63） | db 内派生 |
| W6 | `createPreviewRoutes({db, auth, parsePatch?, now?})`，db/auth 缺省即抛（routes.mjs:237-248） | `auth(req)→principal{ownerId,actor?}\|null`，可 async | `now` 缺省 wall clock（必须注入） |
| W8 | `createBridgeRoutes({db, auth, now?, wss, pairing, devices, heartbeatMs?, maxPayloadBytes?, …})`（routes.mjs:40） | `auth(req)→identity{ownerId}` | `now` 缺省 `Date.now()` |
| W9 | `createDeliveryRoutes({db, auth, clock, idGen, events, verdictGate})`；`createInboxRoutes({db, auth, clock, idGen, events})`——缺注入即抛 | `auth(req)→{ownerId}\|null` | clock/idGen/events 必注 |
| W10 | `createObservabilityRoutes({db, auth, activitySlaMs?})`（routes.mjs:144） | `auth(req)` **仅同步**（routes.mjs:55，无 await） | db 即投影存储 |
| W12 | `createPerceptionRoutes({db, auth, store?, pipeline, config?})`，auth 非对象即抛 ROUTES_AUTH_REQUIRED（routes.mjs:62-67） | **`auth.authenticate(req)`** | pipeline/config 注入 |
| W2/W4/W7/W5/W11 | 无 HTTP 路由（服务工厂/前端/媒体库）；W7 select 端口=W4 selectModel 鸭子接线（修复轮 1388636 已验） | — | 全注入式 |

- **4 种 auth 形状**（`auth(req)` / `auth.ownerId(req)` / `auth.authenticate(req)` / `authenticate(req)`）+ W10 同步限制 → 组合根单一 principal 解析器 + 每流薄适配（W6 L3 预判，落地于 M13）。
- serve-tango.mjs 既有可注入先例：`options.collaboration.handle(req,res,pathname)`（scripts/serve-tango.mjs:106-112 @60fdc73 实读）→ dispatcher 用同构 `options.agentic.handle`，未处理落回 legacy 静态/API 路径（:114-204）。
- build-web.mjs `files` 数组在 scripts/build-web.mjs:11（实读）；需补 `web/agentic/sync.js`（W1；index.html 动态 import → tango-release/TA2 由豁免转必须过）+ `web/agentic/**`（W5 20 模块+7 素材+css+component.html+demo.html；W11 reel 三件）；ES 模块走 node --check 校验路径（moduleAssets 先例 :27-28）。

### 0.4 冲突预测（.s2d 是唯一系统性 add/add 面；`git ls-tree -r HEAD .s2d` 逐流实测）

- 12 流（W4 除外，已清空）全部 track `.s2d/plan.md`、`tests-red.md`、`impl-contract-tests.md`、`impl-freeze-and-report.md` → 每次 merge 必 add/add；W2/W5/W8 另 track `closeout.md`+`cto-decisions.md` → 三方 add/add。
- w13 树当前 4 个**未跟踪** .s2d 文件（plan.md/tests-red.md/impl-contract-tests.md/impl-freeze-and-report.md，W0 遗留，ls 实测）→ **首个 merge（W2）将 rc=2 "untracked working tree files would be overwritten"**（W2 自身报告 §1 同坑）。处置=M00 先提交 W13 版 .s2d 基线。
- 解决策略：`.s2d/**` add/add 一律 keep-ours（W13 版），对方版本归档 `.s2d/import-<flow>-<原名>`（保双方内容与溯源），逐条记入 merge 证据。

### 0.5 npm ci（本会话实跑）

`cd w13-integrate && npm ci > /tmp/w13-npm-ci.log 2>&1` → **rc=1**，EUSAGE：`Missing: sherpa-onnx-win-arm64@2.0.0 from lock file`；node_modules 为空（ls 实测）。测试期用各流先例 `npm install --no-save --no-package-lock`；**W13 不修 lock**（域外，进终报）。

## 1. 模块 DAG（组内无文件交叉可并行；组间按序）

```
G0 ──▶ G1(串行链 M01..M12) ──▶ G2(并行) ──▶ G3(并行) ──▶ G4 ──▶ G5(并行) ──▶ G6(串行门禁链)
```

### G0 基线
- **M00-baseline**：提交 W13 .s2d 基线（本 plan 覆盖 W0 遗留 4 文件，防 M01 rc=2）；记录 npm ci rc=1；`npm install --no-save --no-package-lock`；在 60fdc73 跑 `npm run verify:web`、`npm run test:unit` 捕获基线（预期 227/227 与 7 基线失败）。

### G1 合入链（严格按 brief §2 顺序，每步一模块，串行）
每步固定动作：merge 前 `rev-parse` tip 核对 → merge（`.s2d` 按 0.4 策略解冲突）→ 门禁包：`git diff --name-only`、`git diff 60fdc73..HEAD -- contracts/agentic` 必须 0 行（任何 contracts 变更=阻断）、`cat contracts/agentic/FROZEN`、migrations 目录排序快照、同 db 双跑 `migrate()` 幂等（applied=[]）、**该流 targeted 套件重跑**（一律文件 glob，node v22.22.2 拒绝裸目录）。
- **M01-merge-w2**（862e4f9）→ `node --test tests/unit/agentic/engine/*.test.mjs` + `tests/unit/agentic/contracts/*.test.mjs`
- **M02-merge-w1**（3033265）→ `tests/unit/agentic/blocks/*.test.mjs`
- **M03-merge-w8**（9a6dfdf）→ `tests/unit/agentic/bridge/*.test.mjs`（W8 门禁原跑于 b561a7b，须重验）
- **M04-merge-w11**（4a51457）→ `tests/unit/agentic/media/**/*.test.mjs`
- **M05-merge-w12**（8cd9b4f）→ `tests/unit/agentic/perception/*.test.mjs`
- **M06-merge-w5**（1d638af）→ `tests/agentic/ui/unit/*.test.mjs`（显式 glob）+ 契约一致性
- **M07-merge-w3**（c972ba7）→ `tests/unit/agentic/mission/*.test.mjs`
- **M08-merge-w4**（c9a865b）→ `tests/unit/agentic/autonomy/*.test.mjs`
- **M09-merge-w6**（**cbc79ed**，非报告 df106ae）→ `tests/unit/agentic/preview/*.test.mjs`
- **M10-merge-w7**（1388636）→ runtime/model-router/tool-registry 三组 + w7 契约一致性
- **M11-merge-w9**（472b6d4）→ delivery/verifier/inbox 三组 + w9 契约一致性
- **M12-merge-w10**（f06d7e5）→ `tests/unit/agentic/observability/*.test.mjs`
- 链尾全量：`node --test tests/unit/agentic/contracts/*.test.mjs`（W0 24 + w7 12 + w9 10 并存零回归）

### G2 集成件（并行；全部新文件 `scripts/agentic/integration/`，RED 先行）
- **M13-context**：`context.mjs` 组合根——单一 db（`openAgenticDb`+`migrate(migrations/)` 单台账）、确定性 clock（注入覆盖 W6/W8 缺省 wall clock）、idGen、events sink、traceSink→W10 store、policyPort→W4 runtime（fail-closed）、auth 适配层（单一 principal 解析→四种形状，W10 同步兼容）。集成路径禁第二 db/隐藏 wall clock/读 key/外部调用（localhost harness 与 Playwright 除外）。
- **M14-dispatcher**：`dispatcher.mjs`——有序 prefix 复用器；每 handler `handled:boolean`，未处理落回 legacy；统一 body 上限、owner、冻结错误信封、JSON/SSE headers；SSE 断开与 UNKNOWN 不吞。RED：未登录 401/跨 owner 403/body>限 413/坏 JSON 400/SSE disconnect/legacy fallback。
- **M15-w1-adapter**：`w1-adapter.mjs`——W1 legacy DTO→W0 Agentic Block：完成时间/来源/owner/schemaVersion/服务端时间戳齐备才转；草稿或缺字段留同步层并返回 UNKNOWN+不可执行原因（TA1 锚点：snake/camelCase、prio int/enum、source 枚举、draft 无 start/end）。
- **M16-projection**：`projection.mjs`——W6 Preview 持久化与 Timeline projection 分离；W11 播放字段经 projection 消费不扩 Preview schema；W9 Artifact/Acceptance/Need 与 W10 trace/matrix 只经事件或显式查询接入，不互写对方表（0.2 语义重叠围栏）。
- **M17-health**：`health.mjs`——`/api/agentic/health`：db+`_migrations` 台账、路由注册表、上游配置在位性（不回显 secret）、容器自检。

### G3 挂载与清单（并行；不同文件）
- **M18-serve-mount**：`scripts/serve-tango.mjs` 注入 `options.agentic`（同 `options.collaboration` 先例 :106-112）；无配置时 legacy 行为不变（既有 serve/verify:web 测试佐证）。
- **M19-build-web**：`scripts/build-web.mjs` files/assets += `web/agentic/**`（W1 sync.js、W5 全部、W11 reel）；ES 模块走 node --check；`tests/unit/tango-release.test.mjs` 期望更新（TA2 由豁免转必须过）。
- **M20-web-seam**：`web/index.html` 接缝核对（W1 已挂 sync.js；W5/W11 经 demo/组件页），不覆盖既有用户数据与旧页面脚本。

### G4 harness
- **M21-harness**：`tests/agentic/integration/harness.mjs`——fixture 登录、dispatcher 挂载、假模型 transport/假 checker/假 gateway（W7 transport 注入位、W9 checkers 注入位、W12 vision mock）、临时 SQLite、端口 17701-17709、SSE 收集器（事件序列/HTTP/最终状态落证据）。

### G5 黄金场景（并行；依赖 M21）
- **M22-golden-node**：brief §5 场景 1-7（node 侧）：①草稿→W1 同步→M15 adapter 合法 Block/缺时间不入执行层 ②W12 fixture 扫描→W6 Preview→patch/确认入口/Timeline projection ③W4 A4 逐次确认+重复/过期/跨 owner/A5 全拒 ④W3 admitted→planning→ready + W7 checkpoint 执行 + crash/timeout/预算恢复不重复外部动作 ⑤W9 版本链/verifier/Need 投影 + revision_requested/UNKNOWN/HIGH/跨 owner 不计收益 ⑥双设备增量同步+冲突不覆盖+断线 cursor/幂等 ⑦W10 run/actor/model/gate/latency/cost + stale/conflicting 保留 UNKNOWN/PROVISIONAL。
- **M23-golden-pw**：场景 8 + 最小 Playwright golden（W5 UI+W1 sync+preview/acceptance/review/delivered）；`flock -w 900 /tmp/donego-s2d-pw.lock` ≤2 进程；截图仅辅助。

### G6 门禁与收口（串行）
- **M24-coverage**：`tests/unit/agentic/integration/**` 全绿 + targeted+集成逐模块与 aggregate line/branch/function ≥80%（RED→GREEN 不删测试不放宽）。
- **M25-reconcile**：`npm run verify:web`（tango-release 现必须过）+ `npm run test:unit` 全量逐条对账（基线 7 条=3 BUILD-PLAN 明载+4 预存 vs 新失败精确列表）。
- **M26-release**：`npm run build:web`/`npm run build` 临时 release；manifest SHA、无历史 bundle/用户数据、server 启动、`/api/status`+`/api/agentic/health` 可读（17711-17719）；**不部署**；上一候选回滚读取与服务行为复核说明。
- **M27-closeout**：`git diff --check`、工作树干净、push + `git ls-remote` 回读；终报 s2d-w13-report.md（HEAD/冻结/合入列表/命令 rc/评审 actor 模型/UNKNOWN/风险/回滚）+ 批次一矩阵收口更新。PROVISIONAL/UNKNOWN 原样保留：W8（19/21 actor NULL、Codex smoke 0 完成回合、branch 78.27%）、W11 视频 UNKNOWN+3 MEDIUM、W10 基线 rc=1+BLOCKED 语义、W1 DTO 差异、npm lock 缺口、W12 TD2 契约分叉、TTS BZNSYP 许可。

## 2. 证据计划（每模块一份，`argus-cto/projects/donego/evidence/`）

- 合入链：`s2d-w13-merge-w{2,1,8,11,12,5,3,4,6,7,9,10}.md`（tip 核对、冲突与解决清单、contracts 零 delta、FROZEN、migration 排序+幂等、targeted 重跑 rc）
- 集成件：`s2d-w13-{context,dispatcher,w1-adapter,projection,health}.md`（RED→GREEN+覆盖率）
- 挂载/清单：`s2d-w13-{serve-mount,build-web,web-seam}.md`
- 场景：`s2d-w13-golden-{1..8}.md`（输入/owner/事件序列/HTTP·SSE/最终状态/证据路径）+ `s2d-w13-pw-golden.md`
- 门禁：`s2d-w13-{coverage,full-reconcile,release,closeout}.md`（逐命令 rc 原文）
- 端口台账：17701-17709 harness、17711-17719 release 健康检查；Playwright 全局锁 ≤2 进程；零真实 gateway/Codex/media/email 自动启用（如需真实=单项 UNKNOWN+次数+限制）。

## 3. 风险台账（规划期锚定，实施期逐条核销）

1. R-1（W8 PROVISIONAL）：19/21 actor resolved_model=NULL、真实 Codex smoke 0 完成回合、branch 78.27%<80%——终报原样保留，不因集成升级。
2. R-2（W11 UNKNOWN）：视频成功路径未验证（403 配额+400s 超时）；安全 3 MEDIUM（302 绕过/整包缓冲/CSS 注入）未修。
3. R-3（W10）：全量基线 rc=1（7 条）+矩阵 BLOCKED 语义分歧 + reviewer/fixer NULL——保留 UNKNOWN 行。
4. R-4（npm）：`npm ci` rc=1（EUSAGE 缺 sherpa-onnx-win-arm64@2.0.0）、node_modules 空——`npm install --no-save` 过渡，W13 不修 lock。
5. R-5（W1 DTO↔Block）：形状分歧由 M15 adapter 门控；缺字段一律 UNKNOWN+原因，禁静默补全。
6. R-6（schema 重验证）：W1/W2/W11/W12 的一致性/契约测试绿于 43f12b3 schema；60fdc73 改 contract/context-delta/grant/connector+fixtures → 每次合入后 targeted 重跑是硬门禁，不得沿用旧报告 rc。
7. R-7（语义表重叠）：W2 grants/audit/runs vs W3 mission_* vs W4 autonomy_* vs W7 w7_* vs W10 obs_* 镜像——M16 projection 围栏，禁止跨写。
8. R-8（确定性）：W6/W8 路由含缺省 wall clock（now/Date.now）——组合根强制注入确定性 clock；W10 auth 仅同步——principal 解析器不得只 async。
9. R-9（幂等/双台账）：W6 裸 CREATE TABLE + W2 `_engine_migrations` 双台账——组合根仅走 W0 `migrate()` 单台账；幂等检查=双跑 applied=[]。
10. R-10（场景红线）：黄金场景全 mock/临时库；任何真实外呼=UNKNOWN+次数+限制；A4 每次确认、A5 永不自动、P0 fail-closed 组合后不放宽；所有 actor 显式绑模型，resolved_model=NULL→UNKNOWN 不算通过。
