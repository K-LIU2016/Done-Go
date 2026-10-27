# S2D-W13 · M15-w1-adapter 实现记录（impl-M15-w1-adapter.md）

- 模块：M15-w1-adapter（组2/G2 集成件，plan.md §G2 行 99）
- actor：w13·实现·M15-w1-adapter（模型 zai-api/GLM-5.3$max，工作流统一绑定，显式声明）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 交付物：`scripts/agentic/integration/w1-adapter.mjs`（新文件，唯一实现件）+ `tests/unit/agentic/integration/w1-adapter.test.mjs`（补强组，只增不删不放宽）

## 1. 实现内容

纯函数 `adaptW1DtoToBlock(dto, { ownerId, now, schemaVersion=1 })`——W1 legacy DTO
（block-store store.mjs rowToBlock 形状，snake_case、prio 整数、source 'web'|'draft'）
→ W0 Agentic Block（block.schema.json，camelCase、prio 枚举、source 枚举）。

门控顺序（fail-closed；任何不足 → `{ok:false, outcome:'UNKNOWN', executionReady:false, reason, missing}`，**无 block 键**，行留 W1 同步层）：

1. `now` 非函数 → **throw**（接线错误；集成路径禁隐藏 wall clock，绝不缺省 `Date.now`）。
2. dto 非对象 → UNKNOWN（不崩、不产出块）。
3. 软删墓碑（deleted_at 置位）最先拦截 → UNKNOWN：墓碑与字段完备性无关，永不进入执行层。
4. 字段完备性逐项点名（missing 只列真缺陷，draft 用例锁定恰好 `['start','end']`）：
   ownerId（只取服务端会话，DTO 内任何 owner 字段一律不采信——伪造 owner_id 被剥除，测试锁定）/
   id 非空/revision 整数≥1/date YYYY-MM-DD/start/end 非空且 HH:MM|24:00（draft 的 null 在此拦截，
   TA1 缺口保持显式）/title 非空/kind 冻结枚举（不 coerce）/prio 整数 1..5（不静默缺省）/
   source 可映射进冻结枚举/done 布尔/note 字符串（缺省 ''）。
5. 服务端时间戳：`now()` 单次盖章 createdAt=updatedAt；产出非 ISO date-time → UNKNOWN 拒绝盖章
   （**不降级、不回读 DTO 时间戳**——测试锁定 `updated_at='1999-…'` 不得透传）。
6. 组装只拷贝冻结 schema 认识的字段（additionalProperties:false 兜底剥除 state/use/intent/…
   与一切 snake_case 键）；**兜底再过冻结 block.schema.json**（contracts.mjs validate），
   漏网缺陷（如 schemaVersion 被传 0）→ UNKNOWN 并回填 schema 错误路径。

映射语义（**非凭空约定**，锚定 W1 流 `tests/unit/agentic/blocks/contract-consistency.test.mjs:15-20,45-47`）：

- prio：1|2→high、3→normal、4|5→low（低数值=高优先，index.html prio-up 递减）；导出冻结表 `PRIO_TO_ENUM`。
- source：web|draft→manual（契约枚举无 web/draft，皆用户手工动作）；voice/manual/agent/sync/import/system 原样通过；导出冻结表 `SOURCE_TO_ENUM`。
- schemaVersion：常量 1。
- **与 W1 测试内适配层的唯一分歧（W13 裁决升级，w1-adapter.test.mjs:12-13 锁定）**：createdAt/updatedAt
  由集成根注入的服务端时钟补全，不再沿用 W1 测试层「以 updated_at 兜底」的有损路径（W1 终报 TA1 已列该损）。

时间顺序（start≥end）不在门内：冻结 schema 是唯一权威，接缝不发明 schema 之外的校验（头注明示）。

红线核对：纯函数零副作用（不写库/不发事件/无外部调用）；无隐藏 wall clock；不读 key；
不触碰 contracts/agentic、W1-W12 源文件、serve-tango/build-web/web。

## 2. TDD 轨迹（本会话实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/integration/w1-adapter.test.mjs` | rc=1，1 fail（ERR_MODULE_NOT_FOUND，13 用例随文件加载即死） |
| GREEN | 同上（实现落地后） | rc=0，14/14 |
| 补强 | 同上（补强组 +10 用例后，最终） | **rc=0，24/24 pass / 0 fail** |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/integration/w1-adapter.test.mjs` | rc=0，**line 100.00 / branch 96.67 / funcs 100.00**（M24 ≥80% 预达标；补强前 88.77/71.11/60.00 未达标，故补强） |
| 目录回归 | `node --test tests/unit/agentic/integration/*.test.mjs` | rc=1，127/121 pass/6 fail——fail 全为他模块预期 RED：health(M17)/projection(M16)/release-rollback(M26) ERR_MODULE_NOT_FOUND + release-manifest×3(M19) 断言 RED，逐一经查；dispatcher/context/w1-adapter 全绿，零回归 |
| W1 定向回归 | `node --test tests/unit/agentic/blocks/*.test.mjs` | rc=0，50/50 |
| 语法 | `node --check scripts/agentic/integration/w1-adapter.mjs` | rc=0 |

TAP 日志：`/tmp/m15-w1-adapter-tap.log`（14/14）、`/tmp/m15-w1-adapter-coverage.log`（24/24+覆盖率）、`/tmp/m15-integration-dir-tap.log`（127/121/6）、`/tmp/m15-blocks-regression.log`（50/50）。

## 3. 补强组说明（只增不删不放宽）

RED 文件（w13·测试先行 节点产出）13 用例原样保留、零修改；补强组 +10 用例覆盖实现内未被
原用例触达的分支（非对象 dto、缺 now 抛错、缺 ownerId、id/revision/done/note 缺陷点名、
时间坏格式、source 不可映射、时钟坏产出、schemaVersion=0 走 schema 兜底、draft×source=draft
组合锚点、映射表冻结锁定）——全部是**新增断言**，无任何既有断言被删除或放宽。

## 4. 域与冻结核对（本会话实测）

- `git status --short`：仅 `scripts/agentic/integration/w1-adapter.mjs`（新）+ `tests/unit/agentic/integration/w1-adapter.test.mjs`（改）——均在 plan §3 允许域。
- `git diff 60fdc73 --stat -- contracts/agentic` = 0 行；工作树 contracts 0 改动。
- `cat contracts/agentic/FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` ✓（磁盘真值）。
- 无迁移、无 serve-tango/build-web/web/index.html 改动（M18/M19/M20 各自模块）；无真实
  gateway/Codex/media/email 调用；无 Playwright。

## 5. 遗留与移交

- TA1 缺口（draft 无 start/end 在 W0 v1 schema 下不合法）**保持显式 UNKNOWN**，未抹平——
  CTO 裁决前 draft 永留同步层；本模块即裁决的执行机构（裁决改冻结 schema 时需同步改门 4）。
- 消费方：M16 projection / M21 harness / M22 黄金场景 1（草稿→W1 同步→M15 合法 Block/
  缺时间不入执行层）按 `result.ok` 分流；UNKNOWN 行不得送执行层（红线 7）。
- W1 终报 TA1「正式对齐归 CTO/W13」——本模块落地的映射即 W13 侧对齐（锚定 W1 测试先例 +
  服务端时钟升级），分歧与理由如上 §1；如 CTO 另有裁决以 CTO 为准。
