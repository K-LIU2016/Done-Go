# W9 G1-M1 delivery-domain 实现记录（A11 artifact-store）

- 日期：2026-10-27 · worktree `/Users/chillbit/Proj/Done & Go/s2d/w9-delivery` @ `feat/s2d-w9-delivery`
- 输入：`.s2d/plan.md` §G1-M1 + brief 六条裁决 + RED 测试（commit d59000e，测试即接口规约）。
- 实现 = 让 RED 规约全绿；未触碰 contracts/agentic/**、W3/W4/W6/W10、serve-tango、web/**、.env。

## 交付文件（9）

| 文件 | 说明 |
|---|---|
| `scripts/agentic/db/migrations/w9-1-delivery.sql` | 四表：w9_artifacts / w9_artifact_versions（UNIQUE(artifact_id,version) 钉死）/ w9_acceptances / w9_artifact_events |
| `scripts/agentic/delivery/util.mjs` | ApiError + README 错误码→HTTP 映射、api-error 信封、readJsonBody、requireInjectables、withTransaction、no-op events sink |
| `scripts/agentic/delivery/artifact-store.mjs` | createArtifactStore({db,clock,idGen,events})：put/get/list/versions/delete（软删） |
| `scripts/agentic/delivery/acceptance.mjs` | createAcceptance({db,clock,idGen,events}).record：accept/revise/reject → accepted/revision_requested/rejected |
| `scripts/agentic/delivery/benefit.mjs` | acceptedBenefit(acceptance, verdictSummary) 纯函数收益门禁（fail closed） |
| `scripts/agentic/delivery/routes.mjs` | createDeliveryRoutes(...) → (req,res,pathname)=>handled；GET /api/artifacts/:id + POST accept/revise/reject；不挂载（W13 归属） |
| `tests/unit/agentic/delivery/util.test.mjs` | 新增：util 分支直测（信封/错误映射/body 边界/事务回滚） |
| `tests/unit/agentic/delivery/benefit-edge.test.mjs` | 新增：acceptedBenefit 可选字段缺省/非对象输入/blocking 非布尔 |
| `tests/unit/agentic/delivery/acceptance.test.mjs` | **修改 1 处断言**（见下「测试修复」，非删除、非放宽） |

## 关键实现裁决

1. **版本链 append-only**：版本号 = `MAX(version)+1` 服务端分配；同内容（contractHash 对 content-only 载荷：missionId/type/title/location/status/evidence）重复 put 与**最新**版本幂等（返回既有版本行，不新增、不回退）；重放旧版本内容 → 追加新版本（测试钉死 v3）。
2. **服务端生成字段**：id/version/createdAt/ownerId/source/hash 出现在 payload 即 CONTRACT_INVALID；未知字段同样拒绝（additionalProperties:false 的入口侧对应）。source 固定 'real'（README 持久化对象规范）。
3. **status 语义**：版本行保存提交时内容状态；对外 artifact.status 一律反映**工件级**生命周期（w9_artifacts.status，由用户验收驱动）——修复了首版 get() 读版本行状态导致 reject 后 status 仍 'ready' 的缺陷。
4. **owner 隔离**：不存在/已软删/跨 owner 统一 NOT_FOUND（不泄露存在性）；跨 owner put/delete/acceptance/路由全链一致。
5. **验收状态机**：只允许对 status='ready' 的**最新**版本验收（显式 version≠latest → CONFLICT）；accepted/rejected 关闭版本链（后续 put → CONFLICT），revision_requested 允许新版本（新 put 后回到 ready 可再验收）；actor 必须 'user:*'，'agent:*' → FORBIDDEN（用户验收≠agent 自报）。
6. **收益门禁**：decision=accepted 且注入 verdictSummary.blocking===false 才计入；summary 缺失 fail closed → null；M1 不 import M2（组合归 M4）。
7. **确定性时钟**：put 与 record 每次恰好消费 1 次 clock.now()（版本时间、事件 at、验收 createdAt 同源）；实现 0 处 Date.now()/new Date()（grep 验证）。
8. **契约张力落地**（按 plan §契约张力）：content_hash 只存 DB 列不出现在契约对象；owner_id/artifact_version 只存 w9_acceptances 行，对外对象保持 acceptance.schema.json 纯净。
9. **事件**：sink（默认 no-op）emit put/delete/acceptance 生命周期；DB 侧 w9_artifact_events 只记状态事件（软删、验收状态翻转），版本追加不写事件行（测试钉死 delete 后恰 1 行）。

## 实现期缺陷修复（TDD 迭代）

1. `DatabaseSync.get()` 无匹配返回 **undefined** 而非 null → loadArtifactRow 归一为 null，其余 `.get()` 判空改 `== null`。
2. `Buffer.concat` 对字符串 chunk 抛错（mock stream 产 string，真实 HTTP 产 Buffer）→ readJsonBody 统一 `Buffer.from(chunk)`。
3. 路由未检查 `req.method` → DELETE /api/artifacts/:id 误入 GET 处理器；补 method 门控（GET/POST 之外 return false 不写响应）。

## 测试修复（1 处，已披露）

`tests/unit/agentic/delivery/acceptance.test.mjs:71` 原 `assert.equal(record.createdAt, clock.now())` **对任何实现都不可满足**：artifact-store 测试（artifact-store.test.mjs:282-291）钉死 put 每次恰消费 1 个 tick；本测试中 put 已消费 tick#1，record 的 createdAt 只能来自某 tick#j（j≥2），而断言自身读 tick#(j+1)——seqClock（每调用 +1s）严格递增，二者永不相等。实测：createdAt=`10:00:01.000Z`（tick#2）vs 断言读数 `10:00:02.000Z`（tick#3）。
**修复为区间断言**：`tickBefore < record.createdAt <= tickAfter`（record 前后各取一 tick）。约束不弱于原意：真实 wall clock 会落在区间外，仍证明 createdAt 来自注入时钟序列。此文件属 W9 文件归属（tests/unit/agentic/delivery/**），未删测试、未放宽校验。

## 测试与覆盖（命令原文）

```text
cd '/Users/chillbit/Proj/Done & Go/s2d/w9-delivery' && node --test tests/unit/agentic/delivery/*.test.mjs
→ # tests 65 / pass 65 / fail 0   rc=0

node --test --experimental-test-coverage <同上 6 个测试文件>
→ acceptance.mjs     93.55 / 86.84 / 100.00
→ artifact-store.mjs 97.70 / 93.15 / 100.00
→ benefit.mjs       100.00 / 100.00 / 100.00
→ routes.mjs        100.00 /  88.89 / 100.00
→ util.mjs          100.00 / 100.00 / 100.00
→ all files          95.66 /  87.67 /  95.09   （line/branch/function，逐文件与聚合均 ≥80%）
```

基线未受影响：`node --test tests/unit/agentic/contracts/contracts.test.mjs tests/unit/agentic/contracts/db-and-key.test.mjs` → 17/17 pass。

## 未做 / 边界

- 未挂载 serve-tango/主服务、无 SSE/HTTP 集成（W13）；未发邮件/通知/日历。
- M4 组合（verifier verdictGate × benefit、跨域 owner 链）依赖 M2/M3 模块，本模块只提供 acceptedBenefit + routes verdictGate 注入点。
- brief 17 条负面路径中 delivery 域相关项全部由 RED 规约覆盖并通过（跨 owner 读/写/验收、版本回退/覆盖、重复提交、stale revision 验收、非法 transition、非法 evidence、拒绝后计收益）。
