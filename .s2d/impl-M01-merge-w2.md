# S2D-W13 · M01-merge-w2 模块明细（impl-M01-merge-w2.md）

- 会话：2026-10-28 · w13·实现·M01-merge-w2（模型 zai-api/GLM-5.3$max，工作流统一绑定）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 模块定义（plan.md §1 G1）：按 brief §2 顺序合入 W2 `862e4f9`；门禁包 = tip 核对 → merge（.s2d 按 §0.4 策略）→ `git diff --name-only` / `git diff 60fdc73..HEAD -- contracts/agentic` 0 行 / `cat contracts/agentic/FROZEN` / migrations 排序快照 / 同库双跑 `migrate()` 幂等（applied=[]）/ 本流 targeted 套件重跑（文件 glob）。

## 1. 状态与角色

- W2 合入已由合入会话（w13·合入·A）完成并提交：merge commit `42b754c0bb63b25ff4f68ee56b1f4a6caddf88a5`（parents `708e68c` = M00 基线 + `862e4f9d5ddec1fcf0ead7ecc145b50e098e42bf` = W2 tip，真双亲 merge commit，无 -X ours/theirs），批量收口 `ab9dcef`；逐门禁记录见 `.s2d/merge-log.md` §M01 与 `evidence/s2d-w13-merge-w2.md`。
- 本会话（w13·实现·M01）按「代码与新鲜命令为权威」对 M01 全部门禁在当前 HEAD（十二流合入后的集成树，`c82f11e`）**逐一新鲜重跑**，结果如下。未重放 merge 本身（`42b754c` 已在 HEAD 历史，`git merge-base --is-ancestor 862e4f9 HEAD` 实测通过；重复合并无操作且会制造空 merge）。

## 2. 新鲜门禁重跑（本会话实测，工作树起点干净 @ c82f11e）

### 2.1 tip 核对（零漂移）

```text
$ git rev-parse feat/s2d-w2-engine
862e4f9d5ddec1fcf0ead7ecc145b50e098e42bf          # = brief 派单值 862e4f9 ✓
$ git merge-base --is-ancestor 862e4f9 HEAD && echo OK
OK                                                 # W2 已在 HEAD 历史 ✓
$ git show --no-patch --format='%H %P' 42b754c
42b754c0bb63b25ff4f68ee56b1f4a6caddf88a5 708e68c1bb9afdf1306b330b5866563387be6be0 862e4f9d5ddec1fcf0ead7ecc145b50e098e42bf
$ git diff --name-only 708e68c..42b754c | wc -l
31                                                 # 与 merge-log 记录 31 文件一致 ✓
```

### 2.2 FROZEN 门禁（/tmp/w13-gate-frozen.sh）→ rc=0

```text
OK: empty                     # git diff --name-only 60fdc73..HEAD -- contracts/agentic (committed)
OK: empty (zero changes)      # 含 staged/worktree
base=cddcdf2e30dbace5288eb17cfaad7c23a06b2400 head=cddcdf2e30dbace5288eb17cfaad7c23a06b2400 OK
v1 b9d9bdfa0511905a95b729753b82e5734adab6bb    # FROZEN 磁盘真值（…5734…，非笔误值）OK
frozen_gate_rc=0
```

### 2.3 migration 排序/幂等门禁（node /tmp/w13-gate-migrations.mjs）→ rc=0

- 20 文件字典序（M01 时点 4 个 engine-*.sql；现为十二流累计 20 个，`engine-001-event-clock.sql → engine-004-policy.sql` 顺序保持）；
- 编号无冲突、103 个 DDL 对象跨文件零重名；
- 同一临时库首跑 `migrate()` applied=20（=字典序全量），**双跑 applied=0（幂等）**；
- `migration_gate_rc=0`。

### 2.4 本流 targeted 套件（文件 glob，node v22.22.2 拒绝裸目录）→ rc=0

```text
$ node --test tests/unit/agentic/engine/*.test.mjs tests/unit/agentic/contracts/*.test.mjs
TARGETED_RC=0    # tests 97 / pass 97 / fail 0
```

- 97 = M01 时点 75 + M10/M11 后续加入共享 contracts 目录的 w7/w9 contract-consistency 测试（R-6 语义：本套件以当前集成树为新鲜真值，全部通过，无回归）。

### 2.5 RED 套件联动观察（防污染）

```text
$ node --test tests/unit/agentic/integration/*.test.mjs
RED_RC=1    # tests 26 / pass 17 / fail 9（与合入链各批次终态完全一致）
```

- 9 fail 全部为缺 integration 实现（context/dispatcher/health/projection/w1-adapter/release-*；`scripts/agentic/integration/` 目录尚不存在，ls 实测）；6 个迁移 RED 预期由真实合入 engine-*.sql 等合法转绿。**无测试删除、无校验放宽、RED 状态未被污染。**

## 3. .s2d 处置回顾（沿 merge-log §M01，本会话核对无新冲突面）

- W2 的 impl-*/closeout/cto-decisions 净新增保留作溯源；`tests-red.md` 按 W2 删除语义保留删除；W13 `plan.md`/`merge-log.md` keep-ours。历史冲突解决清单见 `evidence/s2d-w13-merge-w2.md` §2。

## 4. 覆盖率口径

- M01 为合入模块：W13 侧零新增源码（唯一 W13 产出 = 门禁/记录文档），无模块专属 coverage 分母；R-6 硬门禁以 targeted 套件全绿（97/97，engine+contracts）代替，aggregate targeted 2045/2045 见 merge-log 批次三收尾。逐模块 line/branch/function ≥80% 的强制度量落在 M24（integration 实现 + 各流 targeted）。

## 5. 未尽事项（移交后续模块，非本模块缺口）

1. RED 套件 9 fail 待 M13-M17（context/dispatcher/w1-adapter/projection/health）转绿；M24 做集成覆盖率门禁。
2. `npm ci` rc=1（lock 缺 sherpa-onnx-win-arm64@2.0.0）为已知项，W13 域外不修 lock，进终报。
3. 全量 `npm run test:unit`/`verify:web` 对账归 M25；release 归 M26；收口归 M27。
4. W2 PROVISIONAL/UNKNOWN 沿其 closeout 原样保留，不在合入/复核中升级（本模块无新增）。
