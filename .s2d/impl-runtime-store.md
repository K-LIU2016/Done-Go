# W7 M2 · runtime-store 实现记录

- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w7-runtime` @ `feat/s2d-w7-runtime`（基 W0 `60fdc73`，RED 基线 `7bf2dd2`）
- 模块：M2 runtime-store（组1，A4 agent runtime 持久层）
- 输入：`.s2d/plan.md` M2 + RED 测试 `tests/unit/agentic/runtime/store.test.mjs`（125 case 基线的 store 子集，22 case）

## 交付文件

| 文件 | 说明 |
|---|---|
| `scripts/agentic/db/migrations/w7-1-runtime-store.sql` | 4 张表 + 2 索引，全带 `owner_id`；引用 mission/contract/grant 无 FK |
| `scripts/agentic/runtime/store.mjs` | `createRuntimeStore({ db, now?, schemaDir? })` 十个方法 |
| `tests/unit/agentic/runtime/store.test.mjs` | 22（RED 基线）+ 9（实现节点补充）= 31 case，全绿 |

## 设计要点（与裁决⑥对齐）

1. **owner 过滤**：所有读写按 `(owner_id, …)` 复合主键；跨 owner 读 → `null`、写/更新 → `NOT_FOUND`，不泄露存在性。
2. **幂等**：`w7_work_orders` 以 `UNIQUE(owner_id, idempotency_key)` + `payload_hash`（canonicalJson 的 SHA-256）判定同 key 同载重放（`replayed:true` 不插行）/同 key 异载 `CONFLICT`（原行不动）；`w7_work_results` 同构（按 `(owner_id, order_id)`），且要求工单先存在（悬空结果 → `NOT_FOUND`）。
3. **乐观锁**：`revision` 首写=1；`updateWorkOrder` 须带 `expectedRevision`，旧值 → `CONFLICT`；`workOrder.id` 与 `orderId` 不一致 → `CONTRACT_INVALID`。
4. **检查点重放**：`w7_agent_steps` 执行身份 = `(owner_id, id, input_hash)`：同 inputHash 重放存储行（含 checkpoint），inputHash 变化 → 服务端权威 `attempt+1` 记新一次执行。
5. **state 机**：枚举直接取自冻结 `step.schema.json`（`pending/running/succeeded/failed/paused/skipped`，无 unknown）；跃迁表：非终态允许自跃迁（刷新 checkpoint）与前进，`succeeded/failed/skipped` 为终态（自跃迁也拒）。`unknown` → `CONTRACT_INVALID`（UNKNOWN 属 run 级，见 plan.md mismatch #1）。
6. **UNKNOWN 台账**：`w7_unknown_outcomes` 只 insert/list，模块不提供任何重试/出队入口（表也无重试状态列）。
7. **确定性时钟**：`now` 可注入（簿记列 `created_at/updated_at/recorded_at`）；预算窗口/expiry 判定不在本层（归 M3 engine 注入 clock）。
8. **fail closed**：`db` 缺失/无 `prepare` → 构造抛错；WorkOrder/WorkResult/Step 入库前均 `assertValid` 冻结 schema（`work-order`/`work-result`/`step`）。
9. 错误码对齐 `api-error.schema.json` 枚举：`NOT_FOUND`/`CONFLICT`/`CONTRACT_INVALID`，message 只含 id/revision 等结构信息。

## 验证（本节点实测）

- 命令：`node --test tests/unit/agentic/runtime/store.test.mjs` → **31/31 pass, 0 fail**（rc=0）
- 覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/runtime/store.test.mjs`：
  - `store.mjs`：**line 99.37% / branch 97.14% / function 100%**（未覆盖仅 46–47 行：跃迁表对冻结枚举的漂移守卫，仅当冻结 schema 改动才可达）
  - `git diff --check` → 干净
- 说明：`tests/unit/agentic/runtime/{ports,engine}.test.mjs` 仍为 RED（M1/M3 并行模块，非本节点范围）；`npm ci`/`npm run test:unit` 未在本节点执行（门禁节点统一跑，见 plan.md 门禁 2）。

## 遗留/边界

- 幂等指纹绑定在首次创建请求上（`updateWorkOrder` 不改 `payload_hash`）：更新后再重放原始创建请求 → `CONFLICT`（选择记原始请求指纹，注释已写明）。
- `recordStep` 重放判定比较 `input_hash`（null===null 视为同载）；重放返回的是存储行载荷（以存储为准）。
- `now` 缺省回落真实时钟，仅用于无语义簿记列；已加注入测试钉住。
