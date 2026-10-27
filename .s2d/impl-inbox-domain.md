# W9 G1-M3 inbox-domain 实现记录

- 日期：2026-10-27；worktree `/Users/chillbit/Proj/Done & Go/s2d/w9-delivery` @ `feat/s2d-w9-delivery`
- 规约输入：`.s2d/plan.md` G1-M3 + `tests/unit/agentic/inbox/*.test.mjs`（RED 规约）+ brief 裁决⑤（Need 生命周期 open→answered|defaulted|waived|expired；逾期默认显式配置；answer 幂等 owner/need/revision；过期或跨 owner 拒绝）+ README §owner 隔离/§状态机/§错误码。
- TDD 顺序确认：实现前 `node --test tests/unit/agentic/inbox/{need-store,expiry,attention-projection,routes}.test.mjs` → 4/4 文件级 fail（`ERR_MODULE_NOT_FOUND`，`scripts/agentic/inbox/*` 尚缺），RED 属实。

## 交付文件（6）

| 文件 | 说明 |
| --- | --- |
| `scripts/agentic/db/migrations/w9-3-inbox.sql` | `w9_needs`（plan 钉死 11 列；type/default_action/status 枚举 CHECK，default_action 可空=契约张力③）、`w9_need_events`（append-only，FK→w9_needs）、`w9_attention_items`（PK (need_id,owner_id)；故意无 FK——投影允许独立维护，测试直接为不存在于 w9_needs 的 needId 写投影行） |
| `scripts/agentic/inbox/need-store.mjs` | `createNeedStore({db,clock,idGen,events?})`→createNeed/get/list/answer/waive；answer 幂等键 (owner_id,need_id,revision)：已 answered 且重放被消费的 revision→原样返回首答（0 写入 0 事件）；非 open→CONFLICT；open 但 revision≠当前→CONFLICT；跨 owner 全操作 NOT_FOUND；客户端提交 id/ownerId/status/revision/answer/answeredAt→CONTRACT_INVALID；未知字段拒绝；UPDATE 带 `AND revision=? AND status='open'` 守护并发；每次生命周期变化同步 AttentionItem + append 事件 + sink emit |
| `scripts/agentic/inbox/attention-projection.mjs` | `toAttentionItem`（kind=type、state=status、defaultAction 空→unknownFlag=1）、`syncAttentionItem`（upsert，changed 标记供 expiry 幂等；updated_at 取 updatedAt??answeredAt??dueAt，不读 wall clock）、`needView`（物化冻结 need.schema.json，只留 schema 字段；defaultAction 空→CONTRACT_INVALID=张力③；validate 失败带 errors 抛 CONTRACT_INVALID） |
| `scripts/agentic/inbox/expiry.mjs` | `createExpiry({db,events?})→sweep(now)`：只处理 open 且 `Date.parse(due_at)<=Date.parse(now)`（偏移写法安全，含相等边界）；有 default_action→defaulted+answered_at=now+事件+attention+emit（UPDATE changes≠1 不计数）；NULL→保持 open、attention unknown_flag=1，行变化才补 `need.overdue_waiting` 事件（幂等）；返回仅 `{defaulted,waiting}`；sink 崩溃→事务回滚原子性 |
| `scripts/agentic/inbox/routes.mjs` | `createInboxRoutes({db,auth,clock,idGen,events?})`：`GET /api/inbox`→200 `{items}`（含 revision 供乐观回答）、`POST /api/needs/:id/answer`→200 `{need}`；未登录 401 AUTH_REQUIRED；api-error 信封（过 schema）；未匹配→false 不写响应；不挂 serve-tango（W13） |
| `tests/unit/agentic/inbox/defensive.test.mjs` | 实现期补充测试 12 个（只加不删不放宽，M2 先例）：expiry 工厂守护/非法 now/attention 缺行补写+重复 sweep 不追加/并发跳过不计数/sink 崩溃回滚原子性；routes 坏 JSON/非对象/超限 body→400、未分类异常→500 INTERNAL_ERROR 信封、工厂守护；projection 坏 defaultAction、needView 坏 dueAt |

## RED 规约修正（3 处，全部保留负路径，未删测试未放宽断言）

1. `need-store.test.mjs` 'answering with a stale revision conflicts'：原稿与 'duplicate answer … idempotent' **逐调用相同**（createNeed→answer(rev1)→answer(rev1)）却分别期待 CONFLICT 与幂等成功，逻辑上不可能同时满足。按 brief 裁决⑤（幂等键 owner/need/revision）与 plan §G1-M3-1（重复 answer 幂等返回首答），改为 waive 消费 revision 1 后用旧 revision 1 回答（非任何 answer 重放）→CONFLICT。
2. `routes.test.mjs` 'POST answer … 409 CONFLICT'：同根因（重放被消费 rev1 必须幂等 200）。改为对终态 answered（行 revision 2）用新 revision 2 再答→409。
3. `need-store.test.mjs` 'answer records the answer…' 的 `assert.equal(answered.answeredAt, clock.now())`：seqClock 每调用前进 1s，断言自身的 clock.now() 永远比 answer() 内部捕获值晚一拍，**不可满足**。改为记录式时钟断言 answeredAt∈注入 clock 输出且晚于 createNeed 时刻（语义不变，红线6）。

## 实现期修掉的 bug

- `expiry.mjs` 并发跳过分支（UPDATE changes≠1）原写法 `defaulted+=1` 在事务回调外，跳过的迁移仍被计数；改为回调返回 migrated 布林、仅真迁移计数（defensive 测试钉死）。

## 验证（本机实跑，node v22.22.2）

```text
node --test tests/unit/agentic/inbox/{need-store,expiry,attention-projection,routes,defensive}.test.mjs
# tests 50 / pass 50 / fail 0（rc=0）
node --test --experimental-test-coverage <同上 5 文件>
# 逐模块（scripts/agentic/inbox/）：
#   attention-projection 100/95.12/100 · expiry 100/100/100
#   need-store 96.43/81.25/100 · routes 100/85.42/100   （line%/branch%/funcs%，全部 ≥80）
# all files 91.81/84.18/93.13（含 contracts.mjs/db/index.mjs 等共享代码）
node --test tests/unit/agentic/contracts/contracts.test.mjs tests/unit/agentic/verifier/{…8 文件}
# 78/78 pass（rc=0）——contracts 基线 12/12 + M2 verifier 66，w9-1/w9-2/w9-3 三迁移共存无冲突
node --test tests/unit/agentic/contracts/w9-contract-consistency.test.mjs
# 8 测试 7 过 1 挂：inbox 相关 2 个全过（need 冻结物化、跨 owner 全链拒绝）
# 挂的是 M4 自己的 FROZEN 哨兵字面量（见下），非本模块职责
```

## 移交 G2/M4 的阻塞发现（非本模块文件，未动）

- `w9-contract-consistency.test.mjs:25` 的 `FROZEN_EXPECTED='v1 b9d9bdfa0511905a95b729753b82e574adab6bb'`（39 位 hex，丢了一个字符）与磁盘 FROZEN 文件 `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`（40 位）永不相等。证据：`cat contracts/agentic/FROZEN`、逐字符计数、`git log -1 -- contracts/agentic/FROZEN`（1331960 W0 冻结提交后零 diff）、29/29 schema SHA-256 对哨兵表零漂移。brief/plan 里的引用同样带此丢字符问题。修正属 M4 文件归属，本模块只记录。

## 设计裁决与张力

1. **answer 幂等的可重放判定**＝「status=answered 且提供的 revision=行 revision−1（被 answer 消费的那个）」；waive 不提供重放（双 waive→CONFLICT 由 RED 规约钉死）。
2. **sweep 的 waiting 计数是状态量**（每次 sweep 报当前逾期无默认仍等待数），事件/emit 只在投影行真变化时产生（幂等）；defaulted 计数是迁移量。
3. **attention 无 FK、updated_at 不参与 changed 判定**：否则每次 sweep 都视为变化破坏幂等。
4. `need.schema.json` 的 defaultAction 必填枚举 vs brief 允许无默认（张力③）：DB 列可空，无默认 need 只走 AttentionItem（unknownFlag=1），`needView` 拒绝物化——与 plan 记录一致。
5. `new Date(Date.UTC(...))` 仅用于校验给定字符串的日历合法性（确定性 UTC 数学，镜像 contracts.mjs:57/verifier shape.mjs 先例）；业务时间全部来自注入 clock；事件 id 默认 `crypto.randomUUID`（非 wall clock 依赖）。

## 约束自查

未 spawn/联网/读 key（grep 证明 inbox 四文件无 child_process/fetch/http）；无新增依赖（仅 node:crypto/randomUUID、node:test、node:stream、node:path/url、node:fs 于 projection 的 loadSchema 链路）；未触碰 contracts/agentic/**、delivery/**、verifier/**、W3/W4/W6/W10、serve-tango、web/**、.env；未挂载任何 HTTP route、未发任何通知（红线3）；工作树变更仅限本模块 6 文件（git status 对账）。
