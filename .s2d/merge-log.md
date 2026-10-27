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
