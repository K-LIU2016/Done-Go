# Agentic Contracts v1

> W0 唯一契约作者；依据 `PRD.md` v0.2 与 `BUILD-PLAN.md` §2.2 / §3 W0。契约冻结后只允许**新增字段**，不改既有字段语义；任何变更都必须更新变更日志并重新冻结版本。

## 文件与校验

- `*.schema.json`：JSON Schema 2020-12 子集。当前包含 29 个 schema，覆盖 PRD §4.1、§6.4、§6.5、§6.8.2、§8.1、§10.3、§10.4、§10.5。
- `fixtures/*.fixtures.json`：每个 schema 都有 `valid`（至少 2 条）与 `invalid`（至少 1 条）。
- `scripts/agentic/contracts.mjs`：零第三方依赖校验器。

```js
import { loadSchema, validate, assertValid, canonicalJson, contractHash } from './scripts/agentic/contracts.mjs';
const schema = loadSchema('work-order.schema.json', 'contracts/agentic');
const result = validate(value, schema, { schemaDir: 'contracts/agentic' });
if (!result.valid) throw new Error(result.errors);
const hash = await contractHash(contract); // 64 位 SHA-256 hex
```

校验器支持：`type`、`required`、`properties`、`enum`、`items`、`format`（`date-time`/`date`/`time`）、`additionalProperties`、同目录 `$ref`，以及 `const`、`minimum`/`maximum`、`minLength`/`maxLength`、`pattern`、数组数量/唯一性、`allOf`/`anyOf`/`oneOf`/`not`。

## 对象目录

| Schema | 来源/职责 |
|---|---|
| `block` | 日程服务端权威副本；`kind` 与 `web/index.html` 的 KINDS 一致 |
| `mission` / `scan` | 任务及版本化扫描结果 |
| `preview` / `preview-sample` / `preview-reel` / `preview-scene` | L0–L3 预演与媒体分层 |
| `contract` / `grant` / `need` | 签约边界、有限授权、需要你 |
| `run` / `step` / `span` | 执行、检查点、OTel GenAI 对齐追踪 |
| `artifact` / `acceptance` / `evidence` | 交付物、验收与证据 |
| `work-order` / `work-result` | 父子 agent 的结构化工单通信（不传聊天记录） |
| `artifact-ref` / `grant-ref` / `spend` | 工单引用、授权引用、花费 |
| `context-delta` / `suggestion-card` | §6.8.2 现场感知输出 |
| `codex-plan` / `codex-choice` | Codex 只读规划与自适应选模 |
| `fact` / `playbook` / `connector` | 画像事实、交付配方、MCP 能力清单 |
| `api-error` | API 统一错误信封 |

所有服务端持久对象带 `ownerId`（或 `owner_id` 数据库列），查询必须按 owner 过滤；客户端不得伪造服务端派生的 owner。

## 状态机

```text
mission:  draft → scanned → previewed ⇄ discussing → contracted
          → prepping → live → reviewing → delivered
旁路：    blocked(need) / paused / cancelled / failed / expired

artifact: generating → ready → accepted | revision_requested → (new version) | rejected
need:     open → answered | defaulted | waived | expired
grant:    proposed → active → consumed / revoked / expired / invalidated
run:      queued → running → verifying → succeeded | partial | failed | unknown | cancelled
step:     pending → running → succeeded | failed | paused | skipped
```

约束：`contracted` 之前只能做已授权、只读、低成本扫描/预演；合同任一字段变化产生新版本并使旧 Grant 失效；窗口开始仍未签约则 `expired`；暂停后恢复必须重新校验合同 hash；A4/A5 永不作为默认合同自治级别。

## 错误码

| code | 含义 | HTTP 建议 |
|---|---|---:|
| `AUTH_REQUIRED` | 未登录或缺少会话 | 401 |
| `FORBIDDEN` | owner / Grant / 能力范围不允许 | 403 |
| `NOT_FOUND` | 对象不存在或不属于当前 owner | 404 |
| `CONTRACT_INVALID` | JSON Schema 或合同 hash 校验失败 | 400 |
| `CONFLICT` | revision / 并发版本冲突 | 409 |
| `RATE_LIMITED` | 外部/模型配额暂不可用 | 429 |
| `BUDGET_EXCEEDED` | 合同预算达到上限 | 409 |
| `NEED_HUMAN` | 需要用户决定/数据/授权/验收 | 409 |
| `UPSTREAM_UNAVAILABLE` | 网关、模型或本机桥不可用 | 503 |
| `INTERNAL_ERROR` | 未分类服务错误 | 500 |

统一返回：`{ "error": { "code": "...", "message": "...", "details": {}, "requestId": "..." } }`；不得把密钥、原始敏感正文写入 message/details。

## API 列表（PRD §10.4）

```text
POST /api/blocks/sync
POST /api/missions/:blockId/scan
GET  /api/missions/:id/preview       （SSE 分层进度）
POST /api/missions/:id/discuss       { utterance }
POST /api/missions/:id/contract
POST /api/contracts/:hash/sign
POST /api/runs/:id/pause|resume|cancel
GET  /api/runs/:id/activity          （SSE 活动流）
GET  /api/runs/:id/trace
GET  /api/inbox
POST /api/needs/:id/answer
GET  /api/artifacts/:id
POST /api/artifacts/:id/accept|revise|reject
POST /api/actions/:id/confirm        （A4 逐次确认）
WSS  /api/bridge
GET/DELETE /api/me/facts
```

W0 不把路由挂到 `serve-tango.mjs`；各后续流导出 `createXxxRoutes({ db, auth, ... })`，第 3 批统一挂载。

## Contract 规范化与 hash

`contractHash(contract)`：递归稳定排序所有对象 key，数组顺序保持不变，使用无空白 JSON（`canonicalJson`）后计算 SHA-256 hex。顶层已有 `hash` 字段在计算时剔除，以避免自引用。字段顺序不同 hash 相同；任意字段值变化 hash 必须变化。hash 仅绑定执行器实际读取的 Contract 载荷，UI 人话投影不能替代它。

## 变更日志

- **v1 / 2026-10-26**：首次冻结。覆盖 PRD v0.2 对象、预演四层、结构化 WorkOrder/WorkResult、Codex、现场感知、trace、API 错误信封。
