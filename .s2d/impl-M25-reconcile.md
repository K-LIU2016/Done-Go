# M25-reconcile · 模块实现记录

- 执行：w13·实现·M25-reconcile（模型 zai-api/GLM-5.3$max，工作流统一绑定）
- 对账基准快照：HEAD=42001cb、工作树干净（门禁启动前 `git status --short` 空）
- 任务（plan §1 G6）：`npm run verify:web`（tango-release 现必须过）+ `npm run test:unit` 全量逐条对账（基线 7 条=3 BUILD-PLAN 明载+4 预存 vs 新失败精确列表）。本模块纯门禁对账，零代码改动（允许域内无新增文件；唯一产出=证据+本记录）。

## 结果

| 门禁 | rc | 计数 |
|---|---|---|
| `npm run verify:web` | **0** | **227/227 pass / 0 fail**；TA2 `ok 188 - the release packages every web asset index.html references at runtime` 由豁免转必须过，实测过（M19 清单生效） |
| `npm run test:unit` | **1** | **2702 tests / 2696 pass / 4 fail / 2 skipped** |

## 逐条对账（fail=4，`grep '^not ok'` 全量）

1. `tests/unit/agentic/integration/release-rollback.test.mjs` — **M26 在途 RED**（release.mjs 未实现；impl-M21/M22 交接在案："unit 侧唯一失败 release-rollback 为 M26 范围"）。W13 自有 TDD RED，保留不删。
2. `streamChat accepts typed content deltas and a clean close without an explicit done marker` — BUILD-PLAN §2.4 基线 #1 逐字复现。
3. `independent authenticated accounts, read-only permissions, conflicts and idempotent personal links` — 基线 #2 逐字复现。
4. `AI uses selected shared fields, forbids permission actions, binds versions and rechecks revocation` — 基线 #3 逐字复现。

**预存基线 4 条（metric-layout / design-system / replays multi-clause / voice-pipeline-gateway）本树全转绿**：ok 342 / ok 528 / ok 2671 / ok 2676 实测锚点；机理=W13 node_modules 全量装（typescript 6.0.3+ws 在位）愈合 W9/W10 孤立树 npm ci 残缺环境，零代码变更。W9↔W10 基线枚举分歧为 W10 既有 PROVISIONAL，原样保留。

**新失败（超基线+在途 RED）= 0**；skipped 2 = Windows dictation（与基线同集）。

## 过程要点

- 门禁跑于 42001cb 干净快照；运行期间工作树出现 M26 并行开工痕迹（未跟踪 `scripts/agentic/integration/release.mjs` + 修改中 `release-rollback.test.mjs`）——本模块提交只 add 本记录文件，不触碰 M26 在途文件。
- 前置核验：`node --test tests/unit/agentic/integration/*.test.mjs` → 198/197/1（唯一 fail=release-rollback，与全量一致）。
- test-unit.mjs 收集器实测展开 270 文件（含 68 个 src/** 测试），src 侧无静默丢失。

## 证据

- 汇总：`argus-cto/projects/donego/evidence/s2d-w13-full-reconcile.md`
- 完整日志：同目录 `s2d-w13-full-reconcile-verify-web.log`（227 TAP+RC=0）、`s2d-w13-full-reconcile-test-unit.log`（2702 TAP+RC=1）

## 交接

- M26-release：release.mjs 实现落地后 release-rollback 转绿，全量 rc 应归 1→仅剩 3 条 BUILD-PLAN 基线；M26 门禁自行复核并引用本对账为前态。
- M27-closeout：终报引用本节点数字 + M26 后态；PROVISIONAL（W10 基线语义分歧、npm lock 缺口、W9/W10 枚举不一致）保留。
