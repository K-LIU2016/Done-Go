# M26-release · 模块实现记录

- 执行：w13·实现·M26-release（模型 zai-api/GLM-5.3$max，工作流统一绑定）
- 基线：HEAD=6f16366（M24 提交，工作树干净）；任务=plan.md §1 G6 M26（brief §6 门禁 6 + §5.8）。
- 分工承接：M24 交接「M26 直接 import verifyReleaseCandidate 做真实候选校验与回滚回读，勿重写校验器」——本节点 gate 只 import M24 校验器；M23 golden-8（tests/agentic/integration/golden-release.test.mjs）为进程内 API 驱动的黄金场景验收，本节点补的是**真实 npm 命令门禁**（`npm run build:web`/`npm run build` 子进程、dist-web 真实候选、17711-17719 探活、不部署、cleanup 还原），两者互补不重复。

## 交付物（全在允许域）

| 文件 | 说明 |
|---|---|
| `tests/unit/agentic/integration/release-gate.test.mjs` | RED 先行 20 用例（先跑 rc=1 ERR_MODULE_NOT_FOUND，evidence/s2d-w13-release-red.log） |
| `scripts/agentic/integration/release-gate.mjs` | 全注入编排核心 runReleaseGate + 纯件（isForbiddenReleasePath / diffNewCandidateNames / evaluateStatusProbe / evaluateHealthProbe）；无 Date/env/fetch/子进程/IO |
| `scripts/agentic/integration/release-gate-cli.mjs` | 真实接线（npm 子进程、dist-web、M13/M14/M17、端口探测、cleanup）；仅由门禁真实执行，node 覆盖率 N/A（M23 pw-server.mjs 先例） |
| 证据 | `argus-cto/projects/donego/evidence/s2d-w13-release.md` + 6 个原始工件（report/run/red/verify-web/test-unit/coverage） |

## 关键决策

1. **上一候选语义**：W13 树内首个候选链——`npm run build:web`（先落地=上一候选）+ `npm run build`（当前候选）恰构成回滚对照；回滚复核=manifest 字节稳定+SHA 复验+服务行为再探（17712）。历史发布序列的回滚用同一 verifyReleaseCandidate 指向旧 donego-* 目录独立复核（M24 校验器天然支持任意历史候选）。
2. **候选树围栏**：文件集 === manifest ∪ {manifest.json, package.json}（extra/missing 双向）+ 禁入路径分类器（node_modules/.env*/.s2d/sqlite*/.db/.key/.pem/dist*/logs/.git/.tango-donego/.omo/test-results/artifacts/evidence）——「无历史 bundle/用户数据」双保险。
3. **cleanup finally 必达且只清自建候选**：发现歧义（一次构建 ≥2 新候选=并行干扰）即具名失败，绝不猜测、绝不动外来目录；dist-web 还原为门禁前快照。
4. **端口红线**：17711-17719 段内探测顺延，段外/段满=具名失败绝不静默离段。
5. **不部署为结构性承诺**：gate 无任何 git/远端/生产操作；网络仅两台 127.0.0.1 候选服务；候选目录在 gitignored dist-web/。

## 门禁结果（新鲜命令，详见 evidence）

| 命令 | rc | 结果 |
|---|---|---|
| `node scripts/agentic/integration/release-gate-cli.mjs --report …` | **0** | **21/21 步 PASS**：两候选 86 files/35 agentic assets SHA 全等、树围栏零违禁、17711 status+health 200、回滚字节稳定+复验+17712 双探 200、cleanup 还原、noDeploy |
| `node --test tests/unit/agentic/integration/*.test.mjs` | 0 | 224/224（M24 前态 204+20） |
| 覆盖率（M24 同命令+新用例） | 0 | 269/269；release-gate.mjs 94.59/83.58/100，integration 七模块逐项 ≥80% 不回退 |
| `npm run verify:web` | 0 | 227/227 |
| `npm run test:unit` | 1 | 2728/2723/**3**/2——3=M25 对账的 BUILD-PLAN 基线逐字复现；M26 在途 RED 已清零（M25 预测兑现） |

## 红线自查

- `git diff --check` rc=0；contracts/agentic 对 60fdc73 零 delta；FROZEN=v1 b9d9bdf…5734… 磁盘真值不变；零真实 gateway/Codex/media/email；未推远端（M27 职责）。
- 并行痕迹：M27-closeout 已开工（未跟踪 `.s2d/impl-M27-closeout.md`）——本节点不触碰、不提交该文件。

## 提交

- `flock /tmp/donego-s2d-w13-git.lock git add`（仅本节点 4 文件）+ 同锁 commit（HEAD 提交后回填 evidence §6）。
