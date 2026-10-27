# S2D-W6 · Preview 与 discussion 计划 DAG

> 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w6-preview` · 分支 `feat/s2d-w6-preview @ 60fdc73`
> W0 冻结：`b9d9bdfa0511905a95b729753b82e5734adab6bb`（`git merge-base --is-ancestor` 已验证是 HEAD 祖先）
> 本文件覆盖基线里 W0 的历史 plan.md（60fdc73 提交内遗留）；W0 的其余 `.s2d/*` 历史文件不动。

## 1. 输入与不可变边界

- W6 责任边界：`CTO-BATCH2-BRIEF-2026-10-27.md:33` —— 预览持久化、讨论线程、确认入口、Preview→Timeline projection seam；**不把 W11 播放字段塞进 Preview schema**。
- 验收重点：`CTO-DECISIONS-2026-10-27.md:67` —— L0–L2 可追溯，讨论不改变合同而无记录。
- 分层裁决：`CTO-DECISIONS-2026-10-27.md:31-35` —— Preview 持久化契约管意图/证据/状态/决策；W11 播放器时间线经 projection/adapter 消费，不得为播放器便利扩展冻结契约。
- 产品语义：`PRD.md:232-275`（§5.2 预演四档与讨论）、`PRD.md:738-777`（§10.3 Preview JSON）、`PRD.md:779-796`（§10.4 API 子集）、`PRD.md:834-836`（§11.3 讨论→MissionPatch）；交互参照 `prototype.html:409-459`（讨论框/diff 高亮）与 `prototype.html:461-468`（边界卡与签约入口）。
- 冻结 schema（只读输入）：`contracts/agentic/preview.schema.json`（required: missionId/version/confidence/shape/storyboard/narration/boundary/samples/reel/scene；顶层 `additionalProperties:false`）、`preview-sample/-reel/-scene.schema.json`、`mission.schema.json`（状态枚举含 previewed⇄discussing）、`api-error.schema.json` 错误信封。校验工具：`scripts/agentic/contracts.mjs`（loadSchema/validate/assertValid/canonicalJson/contractHash）。
- 持久化基座：`scripts/agentic/db/index.mjs`（openAgenticDb / migrate，按文件名排序记账 `_migrations`）——W0 资产，不改。
- 文件归属（红线）：只新增 `scripts/agentic/preview/**`、`scripts/agentic/discussion/**`、`scripts/agentic/db/migrations/preview-*.sql`、`tests/unit/agentic/preview/**`；不改 `contracts/agentic/**`、`serve-tango.mjs`、`build-web.mjs`、W0/W3/W4/W11 任何文件。
- 环境事实：`npm ci` 因基线 lock 缺 `sherpa-onnx-win-arm64@2.0.0`（`sherpa-onnx-node@2.0.0` 声明 7 个 optionalDependencies，lock 只有 6 个，EUSAGE）不可用——基线即坏，非本流引入；按批次一 W11 报告先例（`s2d-w11-report.md:120`）用 `npm install --no-save --no-package-lock` 过渡，package.json/lock 零改动；W0 契约测试 24/24 复验通过。lock 修复归 owner（BATCH2-BRIEF §5 npm lock 依赖漂移决策记录）。

## 2. 契约映射与负面路径（先于编码）

### 契约映射

| W6 概念 | 冻结契约依据 |
|---|---|
| 预览版本（不可变、按 mission 递增） | `preview.schema.json` version≥1；`mission.schema.json` previewId 引用 |
| 讨论消息（utterance+MissionPatch+前后版本） | PRD §11.3 MissionPatch 字段（scope/audience/format/length/sources/dod/boundary.wont.add/window） |
| 确认记录（preview 边界卡 → 签约意图） | PRD §5.3；`contract.schema.json` 归 W3，本流只产出 contract-draft-request 事件接口，不造合同 |
| Timeline 投影 | 冻结 preview（storyboard/samples/reel/narration）→ W11 时间线 VM；纯函数、加法式、未知组件降级（PRD §10.3 组件降级规则） |

### 负面路径（每条必有测试）

- **拒绝**：payload 不过冻结 schema → `CONTRACT_INVALID`(400)；未登录 → `AUTH_REQUIRED`(401)；跨 owner 读写 → `NOT_FOUND`(404)（不泄露存在性，契约 README:52）；baseVersion 过期并发讨论 → `CONFLICT`(409)；补丁试图放宽系统禁止项（PRD §8.1 默认 wont：付款/对外发送/读凭据/删文件/零打扰入侵）→ `FORBIDDEN`(403) 且不落新版本；missionId 为空/超长 utterance → `CONTRACT_INVALID`。
- **重复**：同一 (missionId, baseVersion, utterance 规范化) 幂等重放 → 返回既有线程记录，不产生新 preview 版本；确认重放（同 actor+version+decision）→ 返回同一确认记录 id；migrate 重跑幂等（`_migrations` 记账）。
- **超时**：注入式 LLM patch 解析超时/上游不可用 → fail-closed `UPSTREAM_UNAVAILABLE`(503)，预演零变更（无半应用补丁）；默认解析内核是确定性规则，无外部调用。
- **断线/恢复**：写路径全程 SQLite 事务（版本插入+线程追加+变更记录同事务）；进程中断后重启：无孤儿 preview 版本、线程消息引用的版本必存在；WAL 模式（openAgenticDb 已设）。
- **外部副作用封锁**：P0→contracted 之前本流不产生任何外部动作（无网关真实调用、无模型调用；测试一律 mock 注入）；确认入口只记决定与事件，不触发执行。
- **讨论不改变合同而无记录**：补丁触碰合同相关字段（boundary.will/wont/needs/budget、window、dod）→ 必写 `contract_change_records` 行（版本对、补丁、字段清单、时间），线程内可回放；未落记录的变更在事务层不可达。

## 3. 模块 DAG（group = 拓扑层，先测后码，每组 TDD）

```text
G1 preview-migrations ──┬─→ G2 preview-store ──┬─→ G3 patch-apply ───┐
G1 preview-validate ─┬──┼─→ G2 discussion-store ─┼─→ G3 confirm-entry ─┼─→ G4 preview-routes
   (frozen schema)   │  │                        │                    │     (createPreviewRoutes
                     │  └─→ G2 timeline-projection│                    │      harness：preview/
                     └────→ G3 patch-parser ─────┘                    │      discuss/confirm/timeline)
```

| # | 模块 | group | 位置 | 要点 |
|---|---|---|---|---|
| 1 | preview-migrations | 1 | `scripts/agentic/db/migrations/preview-001-store.sql`（+`preview-002-discussion.sql`） | 表：previews（mission 软引用，不建 missions 表——归 W3）、discussion_threads/messages、preview_confirmations、contract_change_records；全部带 owner_id；用 W0 migrate 运行器 |
| 2 | preview-validate | 1 | `scripts/agentic/preview/validate.mjs` | 冻结 schema 校验封装：入库存前校验+读出往返校验；W0 fixtures 全量通过 + 富样例自建 fixtures |
| 3 | preview-store | 2 | `scripts/agentic/preview/store.mjs` | 不可变版本链：put→新版本号、get/latest/list、软删；owner 过滤；revision 乐观并发 |
| 4 | discussion-store | 2 | `scripts/agentic/discussion/store.mjs` | append-only 线程与消息（utterance+patch+before/after 版本）；幂等键去重；change-record 同事务追加 |
| 5 | timeline-projection | 2 | `scripts/agentic/preview/timeline.mjs` | 纯函数：冻结 Preview(+元数据)→Timeline VM（shots/track/narration 段）；只读冻结字段、零 schema 改动；未知组件降级 |
| 6 | patch-parser | 3 | `scripts/agentic/discussion/patch-parser.mjs` | utterance→MissionPatch；确定性规则内核 + 可注入 LLM iface（测试 mock）；超时/失败 fail-closed |
| 7 | patch-apply | 3 | `scripts/agentic/discussion/apply.mjs` | 校验后的 patch→新 preview 版本 + diff(changed 路径/reason)；合同相关字段必产 change-record；系统 wont 不可放宽 |
| 8 | confirm-entry | 3 | `scripts/agentic/discussion/confirm.mjs` | confirm/request_change/decline 决定记录（绑定 previewVersion+actor）；幂等；confirm→contract-draft-request 事件（W3 消费的接口，不直接动 mission） |
| 9 | preview-routes | 4 | `scripts/agentic/preview/routes.mjs` | `createPreviewRoutes({db,auth,parsePatch,now})`→(req,res,pathname)；GET preview(+versions, +timeline)、POST discuss、GET discussion、POST confirm；api-error 信封；SSE 渐进渲染留 seam 注释（渲染进度归 W11/W5） |

## 4. 门禁与证据

- 每模块先写 `tests/unit/agentic/preview/<模块>.test.mjs` 跑 RED 再实现；`node --test --experimental-test-coverage` 本流新增文件 line/branch ≥80%。
- `npm run test:unit` 不新增失败（基线 3 个已知失败为准）；`npm run verify:web` 过（TA2 例外只适用新增 web 资产，本流无 web 文件）。
- 契约一致性：产出 Preview/Timeline 全部过 `contracts.mjs` 校验、吃下 W0 `preview*.fixtures.json`。
- 证据：`/Users/chillbit/.claude-code-router/argus-cto/projects/donego/evidence/s2d-w6-<节点>.md`；终报 `.../s2d-w6-report.md`。
- 真实外部调用次数：0（无网关/模型/Codex 调用）；无新增依赖。
