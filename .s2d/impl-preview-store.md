# S2D-W6 impl · preview-store（组2 · 模块3）

- 日期：2026-10-27 · 分支 `feat/s2d-w6-preview`
- 基线：60fdc73（W0 冻结 b9d9bdfa0511905a95b729753b82e5734adab6bb 为其祖先）
- 输入规格：`.s2d/plan.md:52`（模块3）+ `tests/unit/agentic/preview/store.test.mjs`（RED 提交 d6858f3，7 测试即规格）
- 前置：G1 preview-migrations（9ee19d9，`previews` 表）+ G1 preview-validate（0d6e47a，`validate.mjs` 冻结 schema 门）

## 产出文件（1 实现 + 1 测试追加）

| 文件 | 内容 |
|---|---|
| `scripts/agentic/preview/store.mjs` | `createPreviewStore(db, { now })` → `{ put, get, latest, list, softDelete }` |
| `tests/unit/agentic/preview/store.test.mjs`（+3 测试） | 追加 plan §2 负面路径测试（只增不改，原 7 断言零改动） |

## 设计锚点

- **不可变版本链**：`put` 自派版本号 = `MAX(version)+1`，**含软删行**（删除的版本号永不回收，避免与 `UNIQUE(owner_id, mission_id, version)` 撞车/审计混淆）；入参 `preview.version` 被改写为派生号后落库（store.test.mjs:23-29 规格）。行内容插入后不再 UPDATE（revision 恒 1）。
- **冻结 schema 双门**：入库前 `assertValidPreview`（W0 preview.schema.json）；读出 `assertPreviewRoundTrip` 重解析+重校验——损坏行 fail-closed `CONTRACT_INVALID`（store.test.mjs:126-138）。校验经 G1 `validate.mjs` 薄封装，本模块零 schema 规则复制。
- **owner 过滤**：所有 SQL 带 `owner_id = ?`；跨 owner 一律 null/[]/`NOT_FOUND`，零存在性泄露（store.test.mjs:67-79, 116-120）。
- **乐观并发**：可选 `baseVersion` ≠ 当前 live 版本（含链为空）→ 事务内 `CONFLICT` 回滚零写入（store.test.mjs:81-101）；错误带 `currentVersion` 供路由层 409 信封。
- **崩溃安全**：`put`/`softDelete` 全程 `BEGIN IMMEDIATE` 事务；任何失败点整体回滚（无孤儿版本）。UNIQUE 撞行（多进程文件库场景）包装为 `CONFLICT`。
- **序列化**：payload 存 `canonicalJson`（W0 contracts.mjs，键序稳定），利于跨进程字节稳定与审计。
- **零外部副作用 / 零隐藏时钟**：无网络、无模型调用；时间经注入 `now`（测试 makeClock 决定论）；id 为 `randomUUID()`。
- **输入守卫**（fail-closed）：ownerId/missionId 空串、preview 非对象、`preview.missionId` 与目标不一致、version/baseVersion 非正整数 → `CONTRACT_INVALID`。

## 已知未覆盖分支（3 处，防御性，进程内不可达）

覆盖率报告未覆盖行 148-149 / 153-154 / 196-197 = 两处 `ROLLBACK` 失败吞噬 `catch {}` + UNIQUE→CONFLICT 包装——均为多进程/连接已回滚场景的兜底，同步单进程测试无法触达；未剔除以保崩溃安全语义。

## 门禁（本节点运行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/preview/store.test.mjs`（实现前） | 0/7 pass（ERR_MODULE_NOT_FOUND store.mjs） |
| GREEN | 同上（实现后） | 7/7 pass；追加负面测试后 10/10 pass |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/preview/store.test.mjs` | **store.mjs line 97.04 / branch 90.38 / function 90.91**（均 ≥80；validate.mjs 84.31/83.33/37.50 为 G1 文件、经本测试复用） |
| 全量单测 | `npm run test:unit` | 1066 tests：1012 pass / 52 fail / 2 skipped。52 = 3 基线已知（streamChat typed deltas / independent authenticated accounts / AI shared fields，同 G1 记录）+ 49 兄弟模块 RED（apply 11、confirm 7、patch-parser 11、routes 10、discussion-store 部分 2、timeline 0 已由并行节点转绿，合计账目随兄弟进行中文件浮动）。**本模块 0 失败**（store.test.mjs 独立 10/10） |
| web | `npm run verify:web` | 227/227 pass，rc=0（本模块无 web 文件） |

## 边界核对

- 文件归属：仅 `scripts/agentic/preview/store.mjs`（新增）+ `tests/unit/agentic/preview/store.test.mjs`（追加）；未碰 contracts、W0 db/index.mjs、兄弟节点文件（discussion/、timeline.mjs、discussion-store.test.mjs 的并行改动留在工作区未提交）。
- 无新增依赖；无外部调用（0 网关/模型/Codex）；无密钥读取；不推 main。
- 提交经 flock `/tmp/donego-s2d-w6-git.lock` 串行化（同 worktree 并行节点）。

## 给下游（G3 apply / G4 routes）的契约提示

- `put` 返回 `{ id, ownerId, missionId, version, revision, preview, createdAt, updatedAt, deletedAt: null }`；`get/latest` 同形（`deletedAt` 略）。apply 产新版本直接 `store.put({ ownerId, missionId, preview, baseVersion })`，CONFLICT 上抛即路由 409。
- 读路径一律 fail-closed：损坏 payload 抛 `CONTRACT_INVALID`，路由层映射 400 信封（api-error.schema.json）。
- timeline.mjs（G2 兄弟）消费 `latest()`/`get()` 返回的 `preview` + `version/createdAt` 元数据，零 schema 改动。
