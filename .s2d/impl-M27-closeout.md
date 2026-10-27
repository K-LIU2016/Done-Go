# M27-closeout · 模块实现记录

- 执行：w13·实现·M27-closeout（模型 zai-api/GLM-5.3$max，工作流统一绑定；DB dwf_actor id 6203 resolved_model=`zai-api/GLM-5.3` 实录）
- 节点：plan.md §G6 M27-closeout（组 6 串行门禁链末节点）；起点 HEAD=`6f16366`（M24 后），节点产出见「提交」。
- 任务：`git diff --check`、工作树干净、push + `git ls-remote` 回读；终报 + 批次一矩阵收口；PROVISIONAL/UNKNOWN 原样保留。
- 本节点零产品代码改动（收口编排节点）；产出=证据 + 终报 + 矩阵 + 本记录。工作树内唯一新增文件=本记录。

## 结果

| 门禁 | rc | 摘要 |
|---|---|---|
| `git diff --check 60fdc73..HEAD` | 0 | 无空白错误 |
| `git status --short`（本节点提交前） | — | 干净（仅本记录待提交；M26 已先行落地 `a12caa6`，其 4 文件全部入库） |
| `git diff --name-only 60fdc73..HEAD -- contracts/agentic` | 空 | 冻结契约零变化；`60fdc73:contracts/agentic` 与 `HEAD:` 树对象同一 `cddcdf2e30dbace5288eb17cfaad7c23a06b2400`；FROZEN=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| `npm run build:web` / `npm run build` | 0 / 0 | dist-web mkdtemp 候选各一（产物已清理，gitignored） |
| 发布候选独立复核 | 0 | 临时候选（golden-8 同配方，端口 17714）：build 86 文件 + `verifyReleaseCandidate` {ok,checked:86,mismatches:[],hasServerEntry:true,agenticAssets:35} + `/api/status` 200(app=Tango) + `/api/agentic/health` 200(单台账 20 migrations, container ok)；JSON=`evidence/s2d-w13-closeout-release-recheck.json` |
| 收口新鲜全量（最终 HEAD `a12caa6`） | 0 / 1 | `npm run verify:web` 227/227 rc=0；`npm run test:unit` **2728/2723/3/2 rc=1——3 条失败恰为 BUILD-PLAN §2.4 基线逐字复现，超基线新失败 0**（vs M25 2702/2696/4/2：+26=M26 规格 20 例+rollback 归位，fail 4→3）；日志=`evidence/s2d-w13-closeout-{verify-web,test-unit}.log` |
| push + 回读 | 待提交后执行 | 实测结果写 `evidence/s2d-w13-closeout.md` §6（工作树外证据；本记录先于 push 入库，提交序=记录→push→回读） |

## 过程要点

- **M26 并行在途管理**：节点运行期间 M26-release 持续开工（未跟踪 release-gate.test.mjs → release-gate.mjs → release-gate-cli.mjs 依次出现）。本节点：不触碰其文件；发布复核用临时 outputParent 避开 dist-web 并行写；npm build 产物即用即清；提交只 add 本记录。
- **actor provenance 实查**（`~/.zcode/cli/db/db.sqlite`）：现行 run `dwfrun-fde2919e…` w13 actor 25 NULL（缓存导入：规划→M20）+ 6 有值（M22-M27=`zai-api/GLM-5.3`）；前序 cancelled run `dwfrun-396e5ab9…` 同名节点全有值。NULL 按 brief §6.7 记 PROVISIONAL provenance，终报 §5 两说并陈。
- **远端前态**：origin 无 `feat/s2d-w13*`（首次推送）；13 条流分支在 origin 的 tip 与合入值逐一相同（零远端漂移）。
- 终报：`argus-cto/projects/donego/s2d-w13-report.md`；收口证据：`evidence/s2d-w13-closeout.md`；矩阵收口：`s2d-batch1-final-matrix.md` v3 追记（v2 原样保留）。

## 提交

- `flock /tmp/donego-s2d-w13-git.lock git add .s2d/impl-M27-closeout.md` + 同锁 commit：`docs(w13): M27 closeout — final report, matrix v3 closeout, push+ls-remote readback`（本文件随提交入库；HEAD 见 git log）。
