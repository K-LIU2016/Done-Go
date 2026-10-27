# S2D-W6 impl · patch-apply（组3 · 模块7）

- 日期：2026-10-27 · 实现 actor：w6·实现·patch-apply（模型 GLM-5.3）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w6-preview` @ `feat/s2d-w6-preview`
- 基线：RED 测试 `d6858f3`（11 用例）；W0 冻结 `b9d9bdf` 为 HEAD 祖先
- 输入规格：`.s2d/plan.md` §3 模块7 + §2 负面路径 + `tests/unit/agentic/preview/apply.test.mjs`

## 产出文件（2）

| 文件 | 内容 |
|---|---|
| `scripts/agentic/discussion/apply.mjs`（新增） | `applyPatch({ownerId, missionId, actor, utterance, baseVersion, previewStore, discussionStore, parsePatch})` → `{replayed, preview, message, changeRecord}` |
| `tests/unit/agentic/preview/apply.test.mjs`（修复 1 处 + 追加 4 测） | 规格修复见下；追加 15–18 号用例（组合补丁/FORBIDDEN 反证/malformed 形状/无 facts 块） |

## 设计锚点

1. **零半应用**：所有门（CONTRACT_INVALID/FORBIDDEN/NOT_FOUND/CONFLICT/UPSTREAM_UNAVAILABLE）都在**任何 store 调用之前**跑完；版本插入成功后消息追加由 discussion-store 单事务保证（消息+change record 同事务）。写序 = 先 `previewStore.put` 后 `appendMessage`：崩溃窗口只可能留下**可审计的孤儿版本**，绝不出现消息引用不存在的版本（plan §2 断线/恢复）。
2. **重放优先于过期**：幂等键 `JSON.stringify(['discuss-v1', missionId, baseVersion, normalize(utterance)])`（normalize=trim+折叠空白 run），先于 stale 检查查线程——重试的 turn 即使 live 已前移也返回原记录（`replayed:true` + 原 preview 版本 + 原 change record）。
3. **过期基线=CONFLICT**：`baseVersion ≠ live.version` → `CONFLICT`（带 `currentVersion`），发生在 parse 之前（routes 契约：patch 为 null 的 stale 请求也要 409）。
4. **fail-closed 补丁词汇表**：apply 只认 `{sources, length, boundary}`；其余 MissionPatch 字段（dod/format/window…）一律 `CONTRACT_INVALID`——W6 拒绝不能忠实施加的字段，不静默丢弃。
5. **系统 wont 不可放宽**（PRD §8.1）：`SYSTEM_WONT_PATTERNS`（付款/支付/对外发送/发送邮件/发邮件/读凭据/读取凭据/删文件/删除文件/零打扰/入侵）子串匹配：`wont.remove` 命中 → FORBIDDEN；`will.add` 命中 → FORBIDDEN；`will.add` 与 owner 现有 wont 项冲突 → FORBIDDEN（后门撤销显式限制）。
6. **合同相关必留痕**：boundary 实际变更 → `contractChange={patch(整份), changedFields(['boundary.will'/'boundary.wont'])}` 随消息同事务落 `contract_change_records`（NOT NULL 兜底）；纯 no-op boundary 补丁（加已有项）→ 只记消息、零新版本、零记录（"无变更则无记录"）。
7. **diff 语义**：新版本 `diff={changed(点路径), reason(utterance 原文)}`，仅描述本步变更；sources → `shape.facts[来源范围]`（v=include.join('、')），length → `shape.facts[课时]`（缺项则**创建**，v=String(value)），boundary → `boundary.will|wont`。v1 无 diff（parser 失败测试断言原文未动）。纯函数 `applyPatchToPreview` 用 `structuredClone`，不改 mutate 输入。
8. **无外部副作用**：parsePatch 注入（测试 stub）；无网络/模型/时钟读取；时间戳全部来自两个 store 的注入 clock；`MAX_UTTERANCE_LENGTH` 复用 discussion/store.mjs（2000）。

## 规格修复（测试缺陷，非删测换绿，待 CTO 备案）

`apply.test.mjs` 原 test 10 末段（`next` 调用）：`baseVersion: 1` 期望产出 v3。与本文件 test 5（**同构状态**：v1+v2、一条 base=1 消息、不同 utterance → 期望 CONFLICT）及 `routes.test.mjs:186-191`（不同 utterance stale base → 409）和 plan.md §2（"baseVersion 过期并发讨论 → CONFLICT"）**逻辑矛盾**——两场景输入仅差经 stub 解析器丢弃的字符串，无确定性实现可同时满足。修复 = 该调用 `baseVersion: 1→2`（链到新鲜基线，保留"不同 utterance 链新版本"的测试意图），断言零删改。

## 门禁（本节点实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/preview/apply.test.mjs`（实现前） | 11/11 fail（ERR_MODULE_NOT_FOUND apply.mjs） |
| GREEN | 同上（实现后） | **15/15 pass**（11 原测 + 4 追加） |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/preview/apply.test.mjs` | **apply.mjs line 93.79 / branch 87.94 / funcs 95.45**（≥80）；未覆盖行为防御分支（requireNonEmptyString 单参、空 stores 注入等） |
| 全量单测 | `npm run test:unit` | 1079 tests：1064 pass / 13 fail / 2 skipped。13 = **3 基线已知**（streamChat typed deltas / independent authenticated accounts / AI shared fields，plan §1）+ **10 routes RED**（G4 preview-routes 未实现，兄弟节点范围）。本模块 0 失败 |
| 语法/空白 | `node --check` + `git diff --check` | rc=0 |

## 边界核对

- 文件归属：仅 `scripts/agentic/discussion/apply.mjs`（新增）+ `tests/unit/agentic/preview/apply.test.mjs`（修复+追加）；未碰 contracts、W0 db/index.mjs、兄弟节点文件。
- 无新增依赖；真实外部调用 0（无网关/模型/Codex）；无密钥读取；不推 main。
- 提交经 flock `/tmp/donego-s2d-w6-git.lock` 串行化（同 worktree 并行节点）。

## 给下游（G4 routes）的契约提示

- 直接调用：`applyPatch({..., previewStore, discussionStore, parsePatch})`；错误码即 api-error 映射：CONTRACT_INVALID→400、AUTH 层在前、NOT_FOUND→404、CONFLICT→409（error.currentVersion 可入信封）、FORBIDDEN→403、UPSTREAM_UNAVAILABLE→503。
- 成功体：`{replayed, preview(store 行，含 .preview.diff), message, changeRecord|null}`。
- routes 的 stale 409 用例要求：**不要**在调用前把 baseVersion 改写为 latest（stale 必须穿透到 apply）。
