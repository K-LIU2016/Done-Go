# S2D-W13 合入日志（merge-log.md）

- 合入会话：2026-10-28 · w13·合入·A（模型 zai-api/GLM-5.3$max，工作流统一绑定）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 基线：W0 `60fdc73`（分支基点）+ `fd6b129`（W13 RED 测试，先于本会话提交）
- 冻结契约：`contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`（磁盘真值）
- 每步固定门禁：`git diff --name-only 60fdc73..HEAD -- contracts/agentic` 空 + `cat contracts/agentic/FROZEN` 不变 + migrations 排序/编号唯一/跨文件表名不冲突 + 同库双跑 `migrate()` applied=[] + 本流 targeted 套件（文件 glob）重跑。

## M00 · 基线提交

- 提交规划会话产出的 `.s2d/plan.md`（W13 盘点规划，覆盖 W0 遗留版本）。plan §0.4 预判 ".s2d 4 文件未跟踪" 实测已过时：43f12b3（W1/W2 的 merge-base）与 60fdc73 均已 track 这 4 文件，故 M01 起的 .s2d 差异是 base 上的 modify/delete 而非 add/add；W13 侧 plan.md 的 modify 会通过 3-way 合并自动保留（对方未改），无需逐文件解冲突——本日志仍逐流记录实际 .s2d 变更与保留决策。
- rev-parse 核对（merge 前）：W2 `862e4f9d5ddec1fcf0ead7ecc145b50e098e42bf`、W1 `30332659f55a44d7881c2a36a8f69b1c50a35c15`、W8 `9a6dfdff5a7a06ebf223bb9d69b4661495a846f3` —— 与派单 brief §2 完全一致，零漂移。
- npm 状态：`npm ci` 已知 rc=1（EUSAGE 缺 sherpa-onnx-win-arm64@2.0.0，plan §0.5 本会话前实测）；过渡 `npm install --no-save --no-package-lock`（W13 不修 lock，域外）。

## M01 · merge W2（feat/s2d-w2-engine @ 862e4f9）

- tip 核对：`git rev-parse feat/s2d-w2-engine` = `862e4f9d5ddec1fc0ead7ecc145b50e098e42bf` = 派单值 862e4f9 ✓（零漂移）。merge-base vs HEAD = `43f12b3`。
- 命令：`git merge --no-commit 862e4f9` → rc=0，**自动合并干净，零冲突**。
- 变更面（31 文件）：`scripts/agentic/engine/**`（db/event-clock/hash/index/outbox/policy/run-engine）、`scripts/agentic/db/migrations/engine-00{1..4}-*.sql`、`tests/unit/agentic/engine/**`（7 test 文件 + fixtures + helpers）、`.s2d/` 8 个 W2 实现记录新增 + `tests-red.md` 删除。
- .s2d 处置：W2 的 impl-*/closeout/cto-decisions 为净新增（无碰撞，保留作溯源）；`tests-red.md`（W0 内容，W13 侧未改）按 W2 分支的删除保留删除语义，W0 原文仍可从 `43f12b3` 检出；W13 `plan.md`/`merge-log.md` 保留 ours（对方未改，3-way 自动保留）。
- FROZEN 门禁：`git diff --name-only 60fdc73..HEAD -- contracts/agentic` 空 + worktree 对比空 + `contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` + contracts 树哈希 cddcdf2e… 与基线相同 → rc=0。
- migration 门禁：4 个 engine-*.sql 字典序 engine-001→004、编号无冲突、15 个 DDL 对象跨文件零重名、同库双跑 `migrate()` 第二次 applied=[] → rc=0。
- targeted 快测：`node --test tests/unit/agentic/engine/*.test.mjs tests/unit/agentic/contracts/*.test.mjs` → rc=0，75 tests / 75 pass / 0 fail（W2 套件首次在 60fdc73 对齐后的 contracts 上跑，R-6 核销：无回归）。
- RED 套件联动观察：`tests/unit/agentic/integration/*.test.mjs` 26 tests 由基线 11 pass/15 fail → 17 pass/9 fail；新增 6 pass 全部是 migrations.test.mjs 的迁移 RED 预期（单台账/字典序/幂等/无 DDL 碰撞/无 stray），由真实合入的 engine-*.sql 合法转绿；其余 9 fail 均为缺 integration 实现（context/dispatcher/health/projection/w1-adapter/release-*），RED 状态未被污染。

## M02 · merge W1（feat/s2d-w1-blocksync @ 3033265）

- tip 核对：`git rev-parse feat/s2d-w1-blocksync` = `30332659f55a44d7881c2a36a8f69b1c50a35c15` = 派单值 3033265 ✓（零漂移）。merge-base vs HEAD = `43f12b3`。
- 命令：`git merge --no-commit 3033265` → rc=0，**自动合并干净，零冲突**。
- 变更面（19 文件）：`scripts/agentic/block-store/**`（index/routes/store）、`scripts/agentic/db/migrations/blocks-001-blocks.sql`、`tests/unit/agentic/blocks/**`（7 test 文件含 contract-consistency）、`tests/agentic/blocks/**`（Playwright 双设备同步 spec + harness + 两 config）、`web/agentic/sync.js`（新增）、`web/index.html`（M，W1 侧唯一改动方：动态 import /agentic/sync.js、删除上行接线、onboard 收尾保留）。
- .s2d 处置：W1 对 .s2d 零改动（其树 4 文件与 43f12b3 逐 blob 相同），无冲突面。
- FROZEN 门禁：committed+worktree 对 `contracts/agentic` 零 delta、树哈希 cddcdf2e… 不变、`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` → rc=0。
- migration 门禁：5 文件字典序 blocks-001 → engine-001..004、编号无冲突、19 DDL 对象跨文件零重名、双跑 `migrate()` 第二次 applied=[] → rc=0。
- targeted 快测：`node --test tests/unit/agentic/blocks/*.test.mjs` → rc=0，50 tests / 50 pass / 0 fail。含 contract-consistency（W1 对象经适配层过 W0 校验、W0 fixtures 往返、draft 缺口锚定）——首次在 60fdc73 对齐后 contracts 上跑，R-6 核销：无回归。
- RED 套件：26 tests 保持 17 pass / 9 fail（与 M01 后一致，W1 未触碰 integration 预期）。
- 备注：`web/index.html` 属 W13 允许域（M20 接缝），本合入保留 W1 版本原样；后续 M19/M20 再统一处理发布清单与 UI 接缝。

## M03 · merge W8（feat/s2d-w8-codex-bridge @ 9a6dfdf）

- tip 核对：`git rev-parse feat/s2d-w8-codex-bridge` = `9a6dfdff5a7a06ebf223bb9d69b4661495a846f3` = 派单值 9a6dfdf ✓（零漂移）。merge-base vs HEAD = `60fdc73`。
- 命令：`git merge --no-commit 9a6dfdf` → rc=0，**自动合并干净，零冲突**。
- 变更面（51 文件）：`scripts/agentic/bridge-hub/**`（hub/devices/pairing/routes）、`scripts/agentic/db/migrations/bridge-001-devices.sql`、`packages/donego-bridge/**`（client/wss、codex adapter/jsonrpc/threads、config、git/worktree、model/choose+rate-limits、policy/approvals、runtime/session、cli、donego-bridge.js 入口、generate-codex-ts）、`tests/unit/agentic/bridge/**`（18 文件含 _fake-codex、contract-consistency、security-gates）、`tests/agentic/bridge/**`（loopback.e2e、codex-smoke、SMOKE-LOG）、`.s2d/` 11 个 W8 实现记录新增。
- .s2d 处置：W8 的 `closeout.md`/`cto-decisions.md` 与 W2 已合入版本逐 blob 相同（abd35f2 / b498f9f，两流共享同一收口产物）→ 内容一致自动保留，无冲突；`tests-red.md` 基线有/ours 已删（M01 随 W2 删除）/theirs 未改 → 删除保持；W13 `plan.md`/`merge-log.md` 保留 ours。
- FROZEN 门禁：committed+worktree 对 `contracts/agentic` 零 delta、树哈希 cddcdf2e… 不变、`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` → rc=0。
- migration 门禁：6 文件字典序 blocks-001 → bridge-001 → engine-001..004、编号无冲突、24 DDL 对象跨文件零重名、双跑 `migrate()` 第二次 applied=[] → rc=0。
- targeted 快测：`node --test tests/unit/agentic/bridge/*.test.mjs` → rc=0，143 tests / 143 pass / 0 fail（W8 门禁原跑于 b561a7b，本次在 W13 合并树上重验通过）。
- RED 套件：26 tests 保持 17 pass / 9 fail（与 M01/M02 后一致）。
- PROVISIONAL 保留（不因合入抹平，进终报）：W8 报告的 19/21 actor resolved_model=NULL、真实 Codex smoke 0 完成回合、branch 覆盖率 78.27%<80%——代码原样合入，状态原样保留。

## 批次收尾（W2+W1+W8 三连合入完成）

- 聚合快测：`node --test tests/unit/agentic/{engine,blocks,bridge,contracts}/*.test.mjs` → rc=0，268 tests / 268 pass / 0 fail。
- `git diff --check 60fdc73..HEAD` 初次 rc=2（两条 .s2d 记录的尾随空白/EOF 空行，系 W2/W8 源分支原样带入）→ 已在 W13 树修剪（8f386d9，源 worktree 未动），复跑 rc=0。
- 工作树干净（`git status --short` 空）。
- W13 RED 套件终态：26 tests / 17 pass / 9 fail——6 个迁移预期由真实合入转绿，9 fail 全为缺 integration 实现，待 M13-M17。
- 三条 merge commit：42b754c（W2）、2f810d2（W1）、10584f7（W8），均为真双亲 merge commit，无 -X ours/theirs。
- 待后续批次：W11(4a51457)→W12(8cd9b4f)→W5(1d638af)→W3(c972ba7)→W4(c9a865b)→W6(cbc79ed)→W7(1388636)→W9(472b6d4)→W10(f06d7e5)。

---

- 合入会话：2026-10-28 · w13·合入·B（模型 zai-api/GLM-5.3$max，工作流统一绑定）；沿用合入·A 的固定门禁包与 /tmp/w13-gate-{frozen.sh,migrations.mjs} 脚本。
- 批次前置实测：RED 套件基线 26 tests / 17 pass / 9 fail（与批次一终态一致）；三流 tip `git rev-parse` 全部与派单一致（零漂移）；三流对 `contracts/agentic` 自 merge-base delta=0。

## M04 · merge W11（feat/s2d-w11-media @ 4a51457）

- tip 核对：`4a514575cb10478195f5aef03c50aed17492faf4` = 派单值 4a51457 ✓（零漂移）。merge-base vs HEAD = `43f12b3`。
- 命令：`git merge --no-commit 4a51457` → rc=0，**自动合并干净，零冲突**。
- 变更面（51 文件）：`scripts/agentic/media/**` + `scripts/agentic/composer/**`（compose-reel/sample、export、html、timeline、5 模板）+ `scripts/agentic/tts/**`（engine/subtitles/download-model/models.md）、`tests/unit/agentic/media/**`（22 test 文件）、`web/agentic/reel/{player.js,reel.css,README.md}`、shots/w11 5 png。无 migration。
- .s2d 处置：W11 树内 4 文件与 43f12b3 逐 blob 相同（plan 81bd378 / tests-red 00852fc / impl-* 同现值）→ 3-way 自动保留 ours（W13 plan + tests-red 删除语义），无冲突面。
- FROZEN 门禁：contracts 零 delta（committed+worktree）、树哈希 cddcdf2e… 不变、FROZEN=v1 b9d9bdf…5734… → rc=0。
- migration 门禁：6 文件不变式复验（排序/编号/24 DDL/双跑 applied=[]）→ rc=0。
- targeted 快测：`node --test tests/unit/agentic/media/*.test.mjs tests/unit/agentic/media/*/*.test.mjs` → rc=0，164/164 pass。含 contract-consistency（preview-sample/scene/reel schema）——首次在 60fdc73 对齐后 contracts 上跑，R-6 核销。
- RED 套件：26/17/9 不变。提交 `0198b05`（ab9dcef+4a51457，真双亲）。

## M05 · merge W12（feat/s2d-w12-perception @ 8cd9b4f）

- tip 核对：`8cd9b4f1190547f3e4fbbc5047d7ec894fb7db52` = 派单值 8cd9b4f ✓（零漂移）。merge-base = `43f12b3`。
- 命令：`git merge --no-commit 8cd9b4f` → rc=0 **git 层零冲突**（35 文件净新增：perception 19 源 + fixtures、perception-0001-init.sql、14 test 文件 + helpers）。
- **R-6 语义冲突（targeted 快测暴露）**：首跑 `node --test tests/unit/agentic/perception/*.test.mjs` → rc=1，183/184，1 fail：contracts-consistency「ContextDelta 投影过 W0 schema」报 `$.evidence must be object`。根因实测：`git diff 43f12b3..60fdc73 -- contracts/agentic` 改 9 文件，context-delta.schema.json 的 evidence 由字符串数组 → `{imageRef}` 对象；W12 `toContractContextDelta` 仍产 `evidence:[imageRef]`（43f12b3 形状），而其内部 `buildContextDelta` 本就是 `{imageRef}`——60fdc73 恰把 schema 对齐成 W12 内部形状。
  - 解决（W13 树内、保双方功能）：contract-projection.mjs:61 `evidence:[imageRef]`→`evidence:{ imageRef }`（1 行）+ 头注释（分叉清单：原第三处「evidence 数组 vs {imageRef}」已消除；FROZEN 引用 b2de664→b9d9bdf）；contracts-consistency.test.mjs:51 期望字面量随冻结 schema 更新为对象形状——**validate 断言原样保留**（非删测试/非放宽）。拒投影语义（missing-*/unmappable-risk）零改动，W0 冻结 schema 与 W12 流水线均未动。
  - 复跑 rc=0，184/184 pass。
- FROZEN 门禁 rc=0（解决后复跑）；migration 门禁 rc=0：7 文件字典序 blocks-001→bridge-001→engine-001..004→perception-0001、30 DDL 零重名、首跑 applied=字典序、双跑 applied=[]。
- RED 套件：26/17/9 不变。提交 `3bb41e8`（0198b05+8cd9b4f，含语义冲突解决）。

## M06 · merge W5（feat/s2d-w5-frontend @ 1d638af）

- tip 核对：`1d638afc3d4307b3c0a57fe8d291aa0adaeddfc9` = 派单值 1d638af ✓（零漂移）。merge-base = `60fdc73`。
- 命令：`git merge --no-commit 1d638af` → rc=1，**2 冲突均在 .s2d，逐个解决**；101 文件自动合并（web/agentic/ui 21 模块+shape 3+assets 7+css+component/demo.html、tests/agentic/ui 21 spec+config+harness+unit 19 test、shots/w5 29 png）。
- 冲突 1 `.s2d/plan.md`（modify/modify，ours f536ebf vs theirs 9bf915a，两份不同文档）：按 plan §0.4 keep-ours + theirs 逐字节归档 `.s2d/import-w5-plan.md`（blob 9bf915a，W5 规划 DAG 171 行溯源保留）。
- 冲突 2 `.s2d/cto-decisions.md`（add/add，ours 911866e vs theirs b498f9f）：diff 实测仅差 1 行 EOF 空行（8f386d9 已修剪的同源空白）→ keep-ours，无内容损失（theirs blob 经 merge parent 可达），不另归档。
- 其余 .s2d：closeout.md 双方同 blob（abd35f2）自动保留；tests-red.md 保持删除；impl-* 三方一致。
- FROZEN 门禁 rc=0；migration 门禁 rc=0（W5 无 migration，7 文件不变式复验）。
- targeted 快测：`node --test tests/agentic/ui/unit/*.test.mjs`（显式 glob，不在 test:unit 收集内）→ rc=0，501/501 pass，含 contracts-consistency（preview.schema.json FROZEN v1）——R-6 核销。
- RED 套件：26/17/9 不变。提交 `9801c0c`（3bb41e8+1d638af）。

## 批次收尾（W11+W12+W5 三连合入完成）

- 聚合快测（含批次一防交叉回归）：`node --test` engine/blocks/bridge/contracts + media(含子目录) + perception + tests/agentic/ui/unit → rc=0，**1117 tests / 1117 pass / 0 fail**（= 批次一 268 + 媒体 164 + 感知 184 + W5 UI 501）。
- `git diff --check 60fdc73..HEAD` → rc=0（本批无尾随空白带入，无需修剪提交）。工作树干净。
- W13 RED 套件终态：26 tests / 17 pass / 9 fail——与批次一终态一致，无污染。
- 三条 merge commit：0198b05（W11）、3bb41e8（W12，含 R-6 语义冲突解决）、9801c0c（W5，含 .s2d 双冲突解决），均真双亲，无 -X ours/theirs。
- PROVISIONAL 保留（不抹平，进终报）：W11 视频 UNKNOWN（403 配额+400s 超时）+ 安全 3 MEDIUM + TTS BZNSYP 许可；W12 TD2 分叉仅消除 evidence 一项（risk 枚举/全字段非空仍待 CTO 裁决）+ 真实 vision 不自动启用；npm lock 缺 sherpa-onnx-win-arm64（npm ci rc=1）；W5 Playwright spec 留 M23、W11/W5 播放接缝留 M16/M19。
- 待后续批次：W3(c972ba7)→W4(c9a865b)→W6(cbc79ed)→W7(1388636)→W9(472b6d4)→W10(f06d7e5)。
