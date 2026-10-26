# Agentic Contracts v1

> W0 是 Agentic 契约的唯一作者。本目录依据 `PRD.md` v0.2（§4、§6.4、§6.5、§6.8.2、§8.1、§10.3–§10.5）与 `BUILD-PLAN.md` §2.2 / §3 W0 编写。v1 冻结后只允许向后兼容地新增字段；不得改变既有字段语义，并且每次变更都必须更新本变更日志和 `FROZEN`。

## 契约文件与本地校验

- `*.schema.json`：29 个 JSON Schema 2020-12 子集 schema。
- `fixtures/*.fixtures.json`：每个 schema 对应一个 fixture 文件；`valid` 至少有 2 条，`invalid` 至少有 1 条。fixture 只含脱敏示例，不含真实密钥或外部调用结果。
- `scripts/agentic/contracts.mjs`：零运行时依赖的校验、规范化和 hash 工具；W0 不把契约路由挂到服务端。

```js
import {
  loadSchema, validate, assertValid, canonicalJson, contractHash,
} from './scripts/agentic/contracts.mjs';

const schema = loadSchema('work-order.schema.json', 'contracts/agentic');
const result = validate(value, schema, { schemaDir: 'contracts/agentic' });
if (!result.valid) throw new Error(result.errors);
assertValid(value, schema, { schemaDir: 'contracts/agentic' });
const hash = await contractHash(contract); // 64 位小写 SHA-256 hex
```

校验器支持：`type`、`required`、`properties`、`enum`、`items`、`format`（`date-time` / `date` / `time`）、`additionalProperties`、同目录 `$ref`，以及 schema 中使用的 `const`、数值边界、字符串长度/正则、数组数量/唯一性和 `allOf` / `anyOf` / `oneOf` / `not`。失败结果为 `{ valid: false, errors }`；`assertValid` 抛出 `error.code === 'CONTRACT_INVALID'`，不会把密钥写入错误信息。

## 对象目录与字段边界

字段名以 schema 为准；服务端产生的 `ownerId` 不由客户端提交来取得权限。

| Schema | 主要字段 / 职责 |
|---|---|
| `block` | `id`、`ownerId`、`revision`、日期/起止时间、`title`、`kind`、完成状态、来源；日程服务端权威副本 |
| `mission` | `blockId`、目标、交付类别、自治级别、生命周期状态及扫描/预演/合同引用 |
| `scan` | 版本、分类、置信度、资源、缺失项、可行性、理由与风险 |
| `preview` | 版本、置信度、声明式 `shape`、`storyboard`、旁白、边界、样张、预演片和场景 |
| `preview-sample` | 样张 `id`、布局、页标题、由 Shape 派生的文本、生图信息和水印 |
| `preview-reel` / `preview-scene` | HTML 组合物/时长/旁白音频/MP4；场景 `off`、排队、生成中或就绪 |
| `contract` | 目标、交付物、DoD、A1–A3 自治、will/wont、Need、能力范围、数据披露、预算、时间窗和打扰策略 |
| `grant` / `grant-ref` | 绑定 `ownerId`、`contractHash`、actor、能力/数据范围、过期时间、消费状态；工单只传最小引用 |
| `need` | 决定、数据、授权、到场或验收问题；截止时间、默认动作和处理状态 |
| `run` / `step` | 一次执行及其 plan/schedule/execute/verify/merge 步骤、检查点、重试和状态 |
| `artifact` / `acceptance` / `evidence` | 版本化交付物、用户验收决定和可核验来源/测试/差异等证据 |
| `work-order` / `work-result` | 父子 agent 的结构化通信；只传材料引用、验收标准、约束、预算、Grant 引用和结构化产出，不传聊天记录 |
| `artifact-ref` / `spend` | 工单输入/输出的交付物引用，以及调用次数、token、成本和本地占比 |
| `context-delta` / `suggestion-card` | §6.8.2 快慢双路感知的变化/风险证据与可点击建议动作 |
| `span` | OTel GenAI 对齐的 `invoke_agent`、`execute_tool`、`chat`、`donego.need` 追踪单元；正文不写入 span |
| `codex-plan` / `codex-choice` | Codex 只读规划产出和按复杂度/额度选择模型与 effort |
| `fact` / `playbook` / `connector` | 用户事实、交付配方和 MCP 能力/数据处理声明 |
| `api-error` | `{ error: { code, message, details?, requestId? } }` 统一错误信封 |

### owner 隔离

`ownerId` 是服务端派生的租户边界。持久化对象（包括 Block、Mission、Artifact、Fact、Playbook、Connector、Grant 等）必须带 `ownerId` 或落到数据库 `owner_id` 列；每次读取、修改、删除都必须在查询条件中绑定当前 owner。不存在或不属于当前 owner 的对象统一按 `NOT_FOUND` 处理，避免泄露对象存在性。客户端不得伪造、覆盖或仅凭请求体中的 owner 字段越权。

WorkOrder、WorkResult、Span 等运行时消息通过所属 Mission/Run/Step 的 owner 继承隔离；后续实现必须在查出父对象后再授权，不得把消息中的 id 当作跨 owner 的权限凭据。

## 状态机

```text
mission:  draft → scanned → previewed ⇄ discussing → contracted
          → prepping → live → reviewing → delivered
旁路：    blocked(need) / paused / cancelled / failed / expired（窗口过了未签约）

artifact: generating → ready → accepted | revision_requested → (new version) | rejected
need:     open → answered | defaulted（超时按默认） | waived | expired
grant:    proposed → active → consumed / revoked / expired / invalidated（合同变化即失效）
run:      queued → running → verifying → succeeded | partial | failed | unknown | cancelled
step:     pending → running → succeeded | failed | paused | skipped
```

状态约束：

1. `contracted` 之前只能执行已授权、只读、低成本的扫描/预演动作；不得产生外部后果或消耗用户付费资源。
2. Contract 任一字段变化都会产生新版本；旧 Grant 立即 `invalidated`，在途 Run 在下一个检查点暂停并请求确认。
3. 窗口开始仍未签约时 Mission 进入 `expired`，不自动开始；暂停后恢复必须重新校验 Contract hash。
4. A4（有外部后果）只能逐次确认，A5（金钱/法律）永不作为默认合同自治级别。

## 错误码与 HTTP 建议

| code | 含义 | HTTP |
|---|---|---:|
| `AUTH_REQUIRED` | 未登录或缺少会话 | 401 |
| `FORBIDDEN` | owner、Grant 或能力范围不允许 | 403 |
| `NOT_FOUND` | 对象不存在或不属于当前 owner | 404 |
| `CONTRACT_INVALID` | JSON Schema 或合同 hash 校验失败 | 400 |
| `CONFLICT` | revision / 并发版本冲突 | 409 |
| `RATE_LIMITED` | 外部或模型配额暂不可用 | 429 |
| `BUDGET_EXCEEDED` | 合同预算达到上限 | 409 |
| `NEED_HUMAN` | 需要用户决定、数据、授权或验收 | 409 |
| `UPSTREAM_UNAVAILABLE` | 网关、模型或本机桥不可用 | 503 |
| `INTERNAL_ERROR` | 未分类服务错误 | 500 |

统一错误信封：

```json
{ "error": { "code": "CONTRACT_INVALID", "message": "...", "details": {}, "requestId": "req_123" } }
```

`message` / `details` 不得包含 API key、凭据或原始敏感正文。`details` 与 `requestId` 为可选字段；`code` 必须使用 `api-error.schema.json` 的枚举值。

## API 列表（PRD §10.4）

W0 只定义输入/输出契约，不启动服务、不绑定路由。后续服务流应导出 `createXxxRoutes({ db, auth, ... })`，由第 3 批统一挂载；测试使用自建 harness。

```text
POST /api/blocks/sync                 本地日程 ↔ 服务端，含 revision 与冲突返回
POST /api/missions/:blockId/scan      幂等扫描，按 Block revision 去重
GET  /api/missions/:id/preview        SSE 分层预演进度
POST /api/missions/:id/discuss        { utterance } → 结构化补丁 → 新预演
POST /api/missions/:id/contract       生成合同草案（hash + 人话投影）
POST /api/contracts/:hash/sign        签约并绑定 actor
POST /api/runs/:id/pause|resume|cancel
GET  /api/runs/:id/activity           SSE 活动流
GET  /api/runs/:id/trace              owner/admin 可见的 span 树
GET  /api/inbox                       Need 收件箱
POST /api/needs/:id/answer
GET  /api/artifacts/:id
POST /api/artifacts/:id/accept|revise|reject
POST /api/actions/:id/confirm         A4 逐次确认
WSS  /api/bridge                      本机 Codex bridge
GET/DELETE /api/me/facts              用户事实
```

W0 不把路由挂到 `serve-tango.mjs`；本模块不修改 `serve-tango.mjs`、`scripts/build-web.mjs` 或发布清单。

## Contract 规范化与 hash

`contractHash(contract)` 的输入是执行器实际读取的 Contract 载荷，不是 UI 人话投影：

1. 递归稳定排序每个 JSON object 的 key；数组顺序保持不变。
2. 计算时剔除顶层已有的 `hash` 字段，避免自引用；其他字段不剔除、不改写。
3. 用无空白 `canonicalJson` 序列化，再计算 SHA-256，返回 64 位小写 hex。
4. 因此仅字段排列不同的等价 Contract hash 相同；任一字段值、数组顺序或嵌套值改变，hash 必须改变。

## 安全与实现边界

- W0 不进行真实外部调用；fixture 与单测必须 mock 外部依赖。
- 运行时网关密钥只能由 `scripts/agentic/gateway-key.mjs` 从 `~/.config/llm-gateway/endpoint.json` 的 `keys.donego` 读取；不得读取 `.env`，不得缓存、打印、落盘或提交密钥。
- 本目录 schema、fixture 和 README 是契约源；后续流合入 W0 后，应为自己的对象增加契约一致性测试。

## 变更日志

- **v1 / 2026-10-26**：首次冻结。覆盖 PRD v0.2 的核心对象与生命周期、Preview 四层（shape/samples/reel/scene）、Contract/Grant、结构化 WorkOrder/WorkResult、Codex、现场感知 ContextDelta/建议卡、OTel trace、API 错误信封，以及 owner 隔离、规范化 hash 和 W0 路由边界。
