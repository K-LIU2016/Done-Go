# S2D-W13 · M16-projection 实现记录（impl-M16-projection.md）

- 模块：M16-projection（组2/G2 集成件，plan.md §G2 行 100）
- actor：w13·实现·M16-projection（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 交付物：`scripts/agentic/integration/projection.mjs`（新文件，唯一实现件）+ `tests/unit/agentic/integration/projection-seams.test.mjs`（补强测试，M14「补充组」先例；主规格 `projection.test.mjs` 零改动）

## 1. 实现内容（brief §4.4 四条逐一落地）

只读投影层 `projection.mjs`——四个纯函数导出，无 IO/时钟/db/外部调用，输出深拷贝（改输出不影响输入）：

1. **W6 Preview 持久化 ↔ Timeline projection 分离**：`projectPreviewTimeline(preview, source)` 直接委托 W6 纯函数 `projectTimeline`（scripts/agentic/preview/timeline.mjs:98，单一事实源，集成层不分叉不重写）；前置条件沿用 W6 文档（输入已过 preview.schema.json 门，投影 validation-free）。集成路径获取 Timeline VM 只能经此入口。
2. **W11 播放字段经 projection 消费**：`projectPlayback(vm)` 从 VM 派生 `{durationSec, tracks}`；残缺 VM 诚实降级（null/空轨）不编造；Preview 持久化永不生长 player/autoplay/timelineVm/playback 键（主规格测试逐键锁定）。
3. **W9 Artifact/Acceptance/Need 只经显式查询接入**：`projectAcceptedBenefit(entries, ownerId)` 入参为调用方显式查出的 acceptance+verdict 行；围栏顺序 owner → `user:<ownerId>` actor → decision=accepted → W9 门禁，最终裁决复用 W9 `acceptedBenefit`（scripts/agentic/delivery/benefit.mjs:9）；verdict 摘要折算逐条锚定 W9 `db-gate.mjs:47`（overall!=='VERIFIED'‖任一 UNKNOWN‖HIGH+FAIL → blocking；仅 MEDIUM/LOW FAIL 不阻断的 plan 字面规则由补强测试锁定）。所有排除行带 reason（OWNER_MISMATCH / ACTOR_NOT_USER_OWNER / DECISION_NOT_ACCEPTED:* / VERDICT_MISSING / VERDICT_BLOCKING+计数），绝不静默丢行。
4. **W10 trace/matrix 只经显式查询接入 + 模型来源门禁（红线 7）**：`projectModelProvenance({actor,resolvedModel,modelSource,evidence,stale})` 裁决阶梯锚定 W10——resolved_model 缺失/空白 → UNKNOWN+MODEL_MISSING（vocabulary.mjs normalizeActor 规则，绝不回填）；无证据 → UNKNOWN（provenance.mjs evidenceStatusFor total===0）；来源不在 W10 `VERIFIABLE_MODEL_SOURCES={gateway,local}`（vocabulary.mjs:28，mock/fixture/cache-replay/unknown）或证据冲突（actorRoster CONFLICT 规则+证据模型≠声明）或 stale（cache.mjs:104 stale 永不算证据）→ 最多 PROVISIONAL；投影只降级不升级。`EVIDENCE_STATUS`/`VERIFIABLE_MODEL_SOURCES` 直接 import W10 导出（枚举不复制）。

R-7 语义表重叠围栏以源码自审固化（补强测试最后一组，context-seams.test.mjs:408 先例）：projection.mjs 无 db import/prepare/写表语句/Date.now/new Date/process.env/fetch/http/child_process，且不 import 任何写侧流模块（db/engine/mission/autonomy/runtime/bridge/perception）。

## 2. TDD 轨迹（本会话实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/integration/projection.test.mjs` | rc=1，1 fail（文件加载即死 ERR_MODULE_NOT_FOUND，/tmp/m16-red.log） |
| GREEN | 同上（实现落地后） | rc=0，14/14 |
| 补强 | `node --test tests/unit/agentic/integration/projection.test.mjs tests/unit/agentic/integration/projection-seams.test.mjs` | **rc=0，29/29**（14 主规格+15 补强；主规格文件零改动） |
| 覆盖率 | `node --test --experimental-test-coverage`（同两文件） | **projection.mjs line 100.00 / branch 97.40 / function 100.00**（补强前 branch 74.19<80 → 补强后全项 ≥80，M24 门槛预达标） |
| 目录回归 | `node --test tests/unit/agentic/integration/*.test.mjs` | 155 tests/150 pass/5 fail——fail=health(M17 未实现)、release-manifest×3(M19)、release-rollback(M26)，均为他模块预期 RED；对照 M14 记录基线 63/55/8：M13/M15/M16 由 RED 转 GREEN，零新增失败 |
| contracts 门禁 | `git diff 60fdc73..HEAD --stat -- contracts/agentic` → 0 行；`git status --short -- contracts/agentic` → 0；`cat contracts/agentic/FROZEN` → `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓ | 通过 |

TAP 日志：`/tmp/m16-red.log`、`/tmp/m16-coverage.log`、`/tmp/m16-integration-dir.log`。

## 3. 域与红线核对

- 允许域：新增仅 `scripts/agentic/integration/projection.mjs`、`tests/unit/agentic/integration/projection-seams.test.mjs`（均在 plan §G2/允许域清单内）；`git status --short` 实测工作树中本模块 delta 恰为此二文件（同目录 `health.mjs` 为并行 M17 agent 产物，本模块未触碰、不纳入提交）。
- 无迁移、无 serve-tango/build-web/web 改动（M18/M19/M20 各自模块）；无 Playwright；无真实 gateway/Codex/media/email 调用。
- 集成路径无隐藏墙钟/第二 auth/db/读 key（源码自审测试固化）。
- W9/W10 表零写入：projection 只消费显式查询结果（R-7 围栏）。

## 4. 遗留与移交

- M22 黄金场景将用 `projectAcceptedBenefit`/`projectModelProvenance` 投影 W9/W10 显式查询结果；M19 build-web 不涉及本模块。
- PROVISIONAL/UNKNOWN：本模块无新增；投影语义本身保证 mock/cache-replay/stale/conflict/NULL 在下游永远呈现 PROVISIONAL/UNKNOWN，不因集成升级（W8 19/21 actor NULL、W10 基线 rc=1 等既有保留项由 M27 终报原样汇总）。
- 本记录与实现以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。证据明细：`argus-cto/projects/donego/evidence/s2d-w13-projection.md`（由收口节点统一发布，本模块 TAP 日志路径见 §2）。
