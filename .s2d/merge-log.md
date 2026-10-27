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
