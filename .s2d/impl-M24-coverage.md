# M24-coverage 实现记录

- 模块：plan.md §G6 M24-coverage（组 6 串行门禁链首节点）。
- 基 HEAD：42001cb（M23 后）；本节点产出见「提交」。
- 门禁：`tests/unit/agentic/integration/**` 全绿 + targeted+集成逐模块与 aggregate line/branch/function ≥80%（RED→GREEN 不删测试不放宽校验）。
- 证据汇总：`argus-cto/projects/donego/evidence/s2d-w13-coverage.md`（原始日志 4 份同目录 `w13-m24-*.log`）。

## 做了什么

1. **前态**：`node --test tests/unit/agentic/integration/*.test.mjs` → 197/198 pass，唯一 RED = `release-rollback.test.mjs` 整文件 ERR_MODULE_NOT_FOUND（`scripts/agentic/integration/release.mjs` 不存在；fd6b129 RED-first，M21/M22/M23 注记「归 M26」）。
2. **边界裁定**：G6 串行链 M24→M25→M26，M24 门禁即本目录全绿（且 test-unit.mjs 递归收集 tests/unit，M25 全量同被卡）。唯一不删不放宽的解 = 实现 RED 规格钉死的 `verifyReleaseCandidate`（允许域内）。GREEN 落 M24；M26 保留端到端门禁（真实候选 build、17711-17719 健康检查、不部署、回滚说明），应复用本校验器。
3. **实现**：`scripts/agentic/integration/release.mjs`（62 行，离线确定性：无 Date/env/fetch/子进程）——重读 manifest 逐文件复算 SHA-256 → `{ok, checked, mismatches, hasServerEntry, agenticAssets}`；文件缺=指名 mismatch；hasServerEntry=server 文件在清单 ∧ 候选 package.json start 仍指向 serve-tango；agenticAssets 清单投影（pre-W13 候选=空数组照常可回读）。
4. **补强用例**（append-only，原 4 用例断言零改动，仅 import 行加 `rm`）：清单在而文件缺 / 清单剥 server entry → hasServerEntry:false / package.json 缺席或 start 指向他处。

## 门禁结果（新鲜命令）

- `node --test --test-timeout=60000 tests/unit/agentic/integration/*.test.mjs` → rc=0，**204/204**。
- 合并覆盖（上命令的文件集 + tests/agentic/integration/{harness,golden-handlers,golden-scenarios,golden-release}.test.mjs，`--experimental-test-coverage`）→ rc=0，**249/249**。
- 逐模块（line/branch/function）：context 96.03/88.73/100 · dispatcher 100/97.89/100 · health 100/97.26/100 · projection 100/98.70/100 · **release 100/100/100** · w1-adapter 100/96.83/100 —— 全 ≥80%；六模块聚合 ≥80%（逐项≥80% 加权必然≥80%）。harness 97.84/85.46/96.59、golden-handlers 96.35/87.02/87.91 ✓。
- 接缝文件：build-web.mjs 100/82.76/100 ✓；serve-tango.mjs 并入 legacy tango-* 24 套件+serve-mount 后 85.97/89.77/53.33——**W13 接缝(:100-115)全覆盖**，缺口全为 W0 legacy（语音尾部/ws upgrade/CLI 引导读 .env），按 M18 口径不纳入 W13 逐模块门禁，如实记录。
- 「all files」77.96/74.06/74.79 = 把 W1–W12 传递加载内部一并计入，非 W13 新代码；已知缺口按红线 5 保留（W8 branch 78.27% PROVISIONAL 等），不借集成回改（禁改清单）。

## 红线自守

- 允许域：本节点仅 1 新增（scripts/agentic/integration/release.mjs）+ 1 修改（release-rollback.test.mjs append-only）+ .s2d/evidence。
- `git diff 60fdc73..HEAD -- contracts/agentic` = 0 行；FROZEN = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`；`git diff --check` 干净。
- 不删测试、不放宽校验：原 RED 断言逐字未动（diff 可核）。
- 零真实外呼/零部署/不读 key：release.mjs 只读候选目录。

## 提交

- `flock /tmp/donego-s2d-w13-git.lock git add …` + 同锁 commit：`feat(w13): M24 coverage — release.mjs greens fd6b129 RED spec, integration suite 204/204, per-module ≥80%`。

## 交接

- M25：`npm run test:unit` 收集 tests/unit 全树，本套件已绿；全量对账含 baseline 7 条照旧。
- M26：复用 `verifyReleaseCandidate`（勿重写）；release-rollback.test.mjs 7 用例已全绿，无需再动。
