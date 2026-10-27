# W7 M7 · tool-registry-mcp 实现记录（组3）

- 日期：2026-10-27
- worktree：`/Users/chillbit/Proj/Done & Go/s2d/w7-runtime` @ `feat/s2d-w7-runtime`
- 依据：`/private/tmp/donego-w7-brief-20261027.md` 裁决⑤⑥ + `.s2d/plan.md` M7
- RED 基线：commit `7bf2dd2`（125 例先行的组成部分；本模块 14 例）
- 上游依赖：M6 `registry.mjs`（commit `64bbb60`，本会话实读核验其 API 后组合）

## 交付文件（本模块独有）

| 文件 | 说明 |
| --- | --- |
| `scripts/agentic/tool-registry/mcp.mjs` | `createMcpClient({transport, timeoutMs})` JSON-RPC 2.0 MCP 客户端；`createToolAuditStore({db, now?})` 台账；`invokeTool({...})` 调用全链路 |
| `scripts/agentic/db/migrations/w7-3-tool-registry.sql` | `w7_tools`（登记快照，(owner,connector) 幂等）+ `w7_tool_calls`（调用审计，(owner,idempotency_key) 幂等） |
| `tests/unit/agentic/tool-registry/mcp.test.mjs` | RED 基线 14 例全保留（断言零改动）+ 14 例补充 fail-closed 分支 |

## 设计要点（对齐 brief 裁决⑤⑥ / 红线）

1. **transport 全注入**：`createMcpClient` 只接受注入的 `{ send(request) → response }`（HTTP/stdio 真实接线归 W13）；不引 MCP SDK、不联网、不新增依赖（PRD §10.1 A6 建议引 SDK，BUILD-PLAN §2.3 + 红线⑤禁新增依赖 → 自写最小 JSON-RPC 封装，plan mismatch #3 的既定裁决）。
2. **结构化错误**：超时（Promise.race + 注入 timeoutMs）/ 断连 / JSON-RPC error / 非对象响应 / result 非对象 → `UPSTREAM_UNAVAILABLE`（message 保留上游 error code 如 `-32000` 供对账，绝不回显上游 message 正文——可能是注入载荷）；错误码全部落在冻结 api-error 枚举内。
3. **调用全链路**（`invokeTool`）：参数形状 → **Grant 状态纵深防御**（`grant.status !== 'active'` 即 FORBIDDEN，transport 零调用，不依赖 policyPort/M6 是否记得查）→ 幂等重放（只对账：succeeded 原样取回 result_payload、unknown/failed/rejected 重抛结构化错误，**绝不重新 invoke**）→ `registry.call`（M6 全部闸门：未登记 NOT_FOUND / policyPort / inputSchema / 资源 scope / dataDisclosure / quota / Grant 覆盖；拒绝先落账 status=rejected 再原样上抛）→ `client.callTool`（真实 MCP 调用）→ 外部内容扫描。
4. **UNKNOWN 语义（裁决⑥）**：tools/call 超时/断连 = 外副作不可知 → 台账 `status='unknown'` + 结构化上抛；同 key 重放拿回同一 UNKNOWN 结果，不自动重试；台账 API 面没有任何 retry/requeue 入口（同 w7_unknown_outcomes 约定）。
5. **外部内容只作数据（裁决⑤）**：结果一律包 `{kind:'external-content', data}`；指令劫持/越权模式扫描（与 M6 registry.mjs 的 INJECTION_PATTERNS 同清单语义 + work-order-rewrite）命中 → `quarantined:true` + evidence（哈希+命中清单，不携带原文），台账 status='failed'；工具自报 `isError:true` → status='failed'（内容仍只作数据返回）。本函数结构上不持有 WorkOrder/合同/权限的写路径 ⇒ 外部内容无法改变它们。
6. **幂等**：`(owner_id, idempotency_key)` 唯一；payload_hash = sha256(canonicalJson({toolName, args}))——同 key 同载 replay（不落新行、不二次打 transport），异载 CONFLICT。重放同样先过 Grant 状态检查（撤销后连重放也 fail closed）。
7. **owner 隔离**：两张表一切读写按 owner_id 过滤，跨 owner 行不可见（findToolCall/listToolCalls/listConnectors 均然）。
8. **确定性时钟（红线⑥）**：审计 called_at 优先用 registry 返回的 `.at`（M6 注入时钟/ctx.now 派生）或 invokeTool 可选注入 clock；store 单独直用时 now 可注入、缺省真实时钟仅作簿记列（同 M2/M5 store 约定；quota/expiry 判定不在本层，在 M6）。
9. **凭据脱敏**：审计 resultSummary 过 sanitizeMessage（bearer/Authorization/sk-/cookie/api-key/token 模式）后才落库；message 一律不含 key/上游正文。
10. **组间零依赖**：不 import G1 runtime/** 与 G2 model-router/**；registry 为注入鸭子类型 `{ call, listTools }`（listTools 仅 best-effort 反查 connectorId，失败落 null 不阻塞）；仅 import W0 冻结 `../contracts.mjs`（canonicalJson）。

## TDD 过程（本会话实际执行）

```text
1. RED：node --test tests/unit/agentic/tool-registry/mcp.test.mjs
   → 1 fail（ERR_MODULE_NOT_FOUND：mcp.mjs 不存在）——RED 基线成立
2. 实现 w7-3-tool-registry.sql + mcp.mjs 后：
   node --test tests/unit/agentic/tool-registry/mcp.test.mjs
   → # tests 14 / pass 14 / fail 0（RED 基线 14 例断言逐字未动）
3. 覆盖率不足（line 77.27% / branch 65.67%）→ 按 M5/M6 先例补 14 例
   fail-closed 分支测试（只新增，原断言零改动）→ GREEN
```

## 验证（本会话实际执行）

```text
node --test --experimental-test-coverage tests/unit/agentic/tool-registry/mcp.test.mjs
→ # tests 28 / pass 28 / fail 0；rc=0
   mcp.mjs line 99.33% | branch 83.98% | funcs 100%（≥80% 达标）

全量 targeted（plan 门禁 1 的实测文件通配形式，M8 文件另跑见下）：
node --test --experimental-test-coverage \
  tests/unit/agentic/runtime/*.test.mjs \
  tests/unit/agentic/model-router/*.test.mjs \
  tests/unit/agentic/tool-registry/*.test.mjs
→ # tests 203 / pass 203 / fail 0；rc=0
   aggregate line 98.58% | branch 93.20% | funcs 94.61%
   （逐模块全部 ≥80/80/80：budget 96.94/94.38/93.33 · engine 97.02/87.77/100 ·
    errors 100/90.48/100 · ports 100/98.46/100 · store 99.37/97.22/100 ·
    call 99.19/91.67/100 · router 99.29/97.56/100 · transport 96.95/84.62/100 ·
    mcp 99.33/83.98/100 · registry 98.94/94.38/96.67）

M8 契约一致性（G4，非本模块文件域，仅观测）：
node --test tests/unit/agentic/contracts/w7-contract-consistency.test.mjs
→ 7 tests / 5 pass / 2 fail —— 与 M5 记录的 2 个既有失败完全相同
   （FROZEN 哈希常量笔误 + M3 engine 无模型来源 unknown 判定），先于本模块
   任何文件存在（M5 已做因果隔离实验），非本模块引入，不碰不改。

git diff --check → 干净（rc=0）
git status → 仅本模块 3 文件 + 本记录；contracts/agentic、runtime/**、
model-router/**、registry.mjs（M6）零改动
```

## 与上游文档/相邻模块的对账说明

1. RED 基线 mcp.test.mjs 即规格（M5/M6 同例）：`invokeTool` 的链路是「registry.call(policy+scope+disclosure 闸) → client.callTool（真实 MCP 调用）→ 审计落账」，登记表内 tool.execute 只是 M6 闸门路径的占位/桥接，M7 不经它出网。
2. `createMcpClient` 不强制 initialize 先行（RED 基线负面用例在全新 client 上直接 callTool 并期待 UPSTREAM_UNAVAILABLE）；生产接线由 W13 保证握手次序。
3. plan M7「initialize/listTools/callTool 流程 + 超时/错误结构化」全部落地；`w7_tools` 由 `recordConnector` 写入（M6 registry 为内存登记表，本表是其 durable 快照，重登记按 manifest_hash 幂等）。

## 红线自查

不碰主仓/classic/thinkpad/生产/LiteLLM/.env；未读写打印任何真实 key（测试均为注入字面量）；未联网（transport/fetch 全注入 mock，模块无全局网络引用）；未新增依赖（实现仅 import node:crypto + W0 contracts.mjs；测试仅 node:test/assert/node:crypto）；文件域仅本模块 3 文件 + 本记录；contracts/agentic 零改动（FROZEN 只读）；端口段 17681–17689 未实际监听（无任何 socket）；TDD 负面路径先行（RED 基线 14 例 + 补充 14 例，断言零放宽）。
