# S2D-W13 · M19-build-web 实现记录（impl-M19-build-web.md）

- 模块：M19-build-web（组3/G3 挂载与清单，plan.md §G3 行 105）
- actor：w13·实现·M19-build-web（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`（基线 dbf136b=M17 后）
- 交付物：`scripts/build-web.mjs`（M，files/assets 扩 + treeFiles/packagableFile）、`tests/unit/tango-release.test.mjs`（M，期望清单 +35 agentic 文件）、`tests/unit/agentic/integration/release-manifest.test.mjs`（M，+2 补强用例）

## 1. 实现内容

1. **files 数组 += `web/agentic/sync.js`**（build-web.mjs:11 尾项）——W1 终报 TA2 落地项原样落地：index.html 以免构建动态 `import('/agentic/sync.js')` 引用，此前不在发布清单 → tango-release「packages every web asset」失败（TA2 豁免）。
2. **`treeFiles('web/agentic')` 递归收集**（:19-22，brandFiles 同构）+ 导出谓词 `packagableFile(entry)`（:16-18，普通文件且非点文件）：W5 全量（ui/ 21 个 ES 组件 + shape/ 3 + assets/ 7 素材 + agentic.css + component.html + demo.html）与 W11 reel 三件（player.js/reel.css/README.md）整体进入候选——实测 35 个文件、点文件不入包。
3. **Set 去重**（:32）：files 显式项与目录扫描重叠（sync.js 双计）会撞 `writeFile flag:'wx'`，`[...new Set([...files, ...assets])]` 消除。
4. **moduleAssets 扩域**（:43）：`web/agentic/**.js` 与 web/voice/ 同为浏览器原生 ES 模块（免构建），从 vm.Script 经典校验改走 `node --check` ESM 语法校验（:45，ai-parse.js 先例）；.css/.jpg/.mp4/.html/.md 非脚本，两个分支都保留 `.endsWith('.js')` 守卫（防 v3-panel.css/agentic.css 误入 node --check）。
5. **tango-release.test.mjs 期望清单 +35**（:33-38）：逐文件钉死（ui 18 顶层 + shape 3 + assets 7 + reel 3 + css/html×2 + sync.js），manifest SHA 与 web/ 递归盘点双重锁定——TA2 由「允许的已知失败」转必须过。
6. **补强 2 用例**（release-manifest.test.mjs:107-127）：`packagableFile` 三分支（普通文件/dotfile/非文件入口）；CLI 直跑入口（`node scripts/build-web.mjs` 子进程，stdout 两行锚定 + manifest 含 sync.js/reel player，dist-web 已 gitignore、finally 清理）——把 build-web.mjs 分支覆盖从 77.27%（M19 前基线实测）拉回 ≥80 门槛。

## 2. TDD 轨迹（本会话实测；RED 用例为测试先行节点所立，逐字未动）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED（模块） | `node --test tests/unit/agentic/integration/release-manifest.test.mjs` | rc=1，**3 fail / 3 pass**（W1 sync/W5 UI/W11 reel 三用例 fail=manifest 缺 agentic 文件；SHA 完整性/无 stray/打包 server 三守卫 pass） |
| RED（TA2） | `node --test tests/unit/tango-release.test.mjs` | rc=1，**1 fail**（「the release packages every web asset index.html references at runtime」——/agentic/sync.js 不在 manifest） |
| GREEN（模块） | 同 RED 命令 | rc=0，8/8（原 6 + 补强 2） |
| GREEN（TA2+回滚） | `node --test tests/unit/tango-release.test.mjs tests/unit/tango-release-rollback.test.mjs` | rc=0，9/9 |
| 语法 | `node --check scripts/build-web.mjs` | rc=0 |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/release-manifest.test.mjs tests/unit/tango-release.test.mjs` | rc=0，10/10；**build-web.mjs line 100.00 / branch 82.76 / funcs 100.00**（M19 前同法基线 93.75/77.27/100——本模块净提升；残余分支=brandFiles 非 png/html 守卫 throw 等防御路径，CLI 块由子进程覆盖不计入父进程口径） |
| 集成目录回归 | `node --test tests/unit/agentic/integration/*.test.mjs` | rc=1，171/170/1——唯一 fail=M26 release-rollback.test.mjs（release.mjs 未实现的预期 RED，非本模块）；M19 前 169/165/4（3 M19 RED+1 M26），本模块消 3 留 1，零回归 |
| verify:web 全链 | `npm run verify:web` | **rc=0，227/227 pass**（M19 前 rc=1：TA2 短路 + 11 个 node --check 未跑；现全链贯通） |
| test:unit 全量 | `npm run test:unit` | rc=1，2675/2669/**4 fail**/2 skip；同树 stash 对照（M19 前）：2673/2663/**8 fail**——**消掉的 4 = M19 RED×3 + TA2×1（全部本模块范围），剩余 4 = M26 RED 文件 + 3 条 BUILD-PLAN 明载基线（streamChat typed deltas / independent authenticated accounts / AI uses selected shared fields），不多不少零新增** |

TAP 日志：`/tmp/m19-{verify-web2,test-unit-final,intdir,coverage4}.log`（stash 对照 `/tmp/m19-test-unit-before.log`、前态覆盖率 `/tmp/m19-coverage.log`）。

## 3. 设计取舍与自纠（不改校验、不删测试）

- moduleAssets 首版误删 `.endsWith('.js')` 守卫（v3-panel.css 会进 node --check）——落地前自查发现，双向恢复守卫后从未进入任何提交/测试运行。
- CLI 用例 stdout 解析首版用 `\S+` 捕路径——工作树路径含空格（Done & Go）匹配 null；改整行 `(.+)\n` 捕获（release-manifest.test.mjs:121 注释钉住原因）。两次自纠均在 RED→GREEN 迭代内完成，最终断言强于初版（路径含空格场景被永久钉住）。
- sync.js 显式进 files（TA2 锚点可见）+ 目录扫描全量：以 Set 去重共存，而非二选一——既保留 W1 终报指向的落地位置，又让 web/agentic/** 后续新增文件自动入包（扫描面），tango-release 精确清单仍钉死当次内容（不放宽）。

## 4. 域与红线核对（本会话实测）

- 允许域：改动仅 `scripts/build-web.mjs`、`tests/unit/tango-release.test.mjs`、`tests/unit/agentic/integration/release-manifest.test.mjs` + 本记录——`git status --short` 实测（并行兄弟节点 M18 的未跟踪 `serve-mount.test.mjs` 不属本模块，未触碰、不入本提交）。
- contracts/agentic：worktree diff 0 行、`git diff --name-only 60fdc73..HEAD -- contracts/agentic` 0 文件、树哈希 `cddcdf2e…` 与基线一致、`FROZEN`=`v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓。
- `git diff --check` → rc=0（无空白问题）。
- 无迁移、无 serve-tango/web/index.html 改动（M18/M20 各自模块）；无外部调用/端口占用/Playwright；CLI 子进程只读仓库树 + 写 gitignore 的 dist-web 并自清理。
- 候选内容卫生（用例 5 锁定）：manifest 与磁盘逐一 SHA 相等、无 dist-web/.data/node_modules/.env/cookie/.s2d 入包、无 stray 未记账文件。

## 5. 遗留与移交

- M26 release：CLI 入口已被本模块用例实跑验证（stdout 路径/manifest 含 agentic 文件），真实 dist-web 产物 SHA 校验、server 启动 + `/api/status` + `/api/agentic/health` 健康检查、回滚说明归 M26/M27。
- M18 serve-mount 未合入时，release 内 serve-tango 仍为 legacy 行为（agentic 路由 404→fallback）——不影响本模块清单正确性；M18 落地后 release 测试自然覆盖新挂载。
- test:unit 剩余 4 fail 的逐条对账（3 基线 + M26）归 M25；W0 期「4 预存」（metric-layout 等）在 60fdc73 后代树不复现，与 W1 终报 1034/1028/4+TA2 口径一致，M25 按此对账。
