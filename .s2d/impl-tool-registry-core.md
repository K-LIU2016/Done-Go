# W7 M6 · tool-registry-core 实现记录

- 模块：M6 tool-registry-core（G3，plan.md M6；brief 裁决⑤）
- 交付文件（2）：
  - `scripts/agentic/tool-registry/registry.mjs`（新增，~450 行）
  - `tests/unit/agentic/tool-registry/registry.test.mjs`（RED 基线 16 例全保留原断言，追加 18 例防御分支补充；共 34 例）
- 依赖：仅冻结共享校验器 `../contracts.mjs`（W0 骨架）；不 import G1 runtime/**、G2 model-router/**（plan「无跨组源文件依赖」）；零新增 npm 依赖。

## API（与 RED 测试契约一致）

- `createToolRegistry({ policyPort, schemaDir?, clock, audit? })`
  - 缺 policyPort / policyPort 无 check / 缺 clock / audit 非函数 → 构造期 CONTRACT_INVALID（fail closed，不静默降级）。
  - schemaDir 默认仓库 `contracts/agentic`（懒加载冻结 connector.schema.json 并按 dir 缓存）。
  - clock：确定性时钟 `{ now() → epoch ms }`，quota 日窗与审计时间戳唯一时间来源；`ctx.now`（ISO）可按调用覆盖，同样只认注入值。
- `register(manifest, tools)`：manifest 先过冻结 connector.schema.json（assertValid → CONTRACT_INVALID）；工具描述符 `{name, inputSchema, capability, execute}` 逐项校验；工具名/connector id 重复 → CONFLICT；**原子语义**：任一失败整批不登记；manifest 登记为深拷贝快照（调用方事后改原对象不影响登记表）。
- `listTools({ grant })`：按 grant.capabilities 等值或子路径（`scope` / `scope/...`）过滤；只暴露 `{name, capability, connectorId, transport, risk, processing}`，不泄漏 execute。
- `call(toolName, args, ctx)`（ctx = `{ownerId, actor, grant, contract, now?}`）检查顺序：
  1. 未登记 → NOT_FOUND（不触 policyPort，记审计）
  2. ctx 形状（ownerId/actor/grant.capabilities/contract.dataDisclosure）→ CONTRACT_INVALID
  3. `policyPort.check({ownerId,actor,grant,contract}, {type:'tool.call', tool, connector, capability, resource?})` → 拒绝/抛错/返回非 `{allow:boolean}` → FORBIDDEN / FORBIDDEN / CONTRACT_INVALID（全部 fail closed）
  4. args 必须过工具级 inputSchema（冻结校验器）→ CONTRACT_INVALID
  5. `args.resource`（字符串）必须被 manifest.reads[].scope 等值或子路径覆盖 → FORBIDDEN
  6. 命中 read 的 dataClass：`secret` 永拒（合同写了也拒）；其余要求合同 dataDisclosure 存在 `dataClass` 相同且 `to` 与 manifest.processing 匹配（local↔'local'，cloud↔'cloud-model'，`plugin:<connectorId>` 亦认）→ FORBIDDEN
  7. `quota.perDay`：注入时间的 UTC 日分桶，只数放行调用 → RATE_LIMITED
  8. grant.capabilities 必须覆盖 tool.capability（纵深防御，独立于 policyPort）→ FORBIDDEN
  9. execute：抛错 → UPSTREAM_UNAVAILABLE（不回显原始错误文本，防注入/防泄密）；结果一律 `{kind:'external-content', data, tool, at}`。

## 外部内容只作数据（红线⑤）

- 恶意外部内容检测（`inspectExternalContent`）：canonicalJson 序列化（>64KiB 截断扫描并标记 truncated；BigInt/循环等不可规范化 → 直接按可疑隔离）+ 8 条指令劫持/越权正则 + 递归扫描越权键名（workOrder/contract/grant/systemPrompt(Override)/autonomy/dataDisclosure/permissions/capabilities，限深 8）。
- 命中 → `{kind:'external-content', quarantined:true, data, evidence}`；evidence 只带 sha256 dataHash + detected 清单 + 时间/工具标识，**不携带外部原文**。
- 绝不修改 WorkOrder/合同/Grant/登记表（测试 deepEqual 前后对照 + 登记表状态断言）。

## 审计（best-effort 进程内；durable 归 M7 w7_tools/w7_tool_calls）

- 每次拒绝/放行都记 `{decision:'allowed'|'rejected', tool, connectorId?, ownerId, actor, at, code?, reason?, resource?, quarantined?}`；audit 注入器抛错不掩盖原错误、不改变判定（有测试钉住）。

## 测试与覆盖（本机 Node v22.22.2）

- `node --test --experimental-test-coverage tests/unit/agentic/tool-registry/registry.test.mjs` → **rc=0，34/34 pass**
- 覆盖率（registry.mjs）：**line 98.94% / branch 91.93% / function 96.67%**（门槛 ≥80% 全过；残留未覆盖：fail() 内部非法码 TypeError 守卫 46-47、scanKeys 限深守卫 137-139，均为不可从外部触发的防御守卫）
- 负面路径对账（brief 清单中属 M6 的项）：工具未登记、scope 越界、disclosure 越界（sensitive 未授权 / secret 永拒 / local 数据进 cloud 工具）、quota 超限、Grant 不匹配、恶意外部内容、缺 policyPort —— 全部有测试；「预算超限」归 M3 budget/M5（本模块闸为 quota.perDay，已测）。

## 回归与已知事实（如实记录，不属本模块修复）

- 全 targeted 套件（runtime+model-router+tool-registry+w7-contract-consistency）：180/183 pass，3 fail 均与本模块无关：
  1. `mcp.test.mjs` 模块加载失败 —— M7 未实现（本流 RED 基线，属 M7 节点）。
  2. M8「FROZEN 仍为 W0 基线」：**plan.md L5 与该测试的期望常量把哈希写成 `…5734→574adab6bb` 笔误**（期望 `b9d9bdfa0511905a95b729753b82e574adab6bb`，实际 FROZEN 文件与 brief 均为 `…5734adab6bb`）。已用 `git stash -u` 在干净 HEAD 复现同样 2 失败 → 预先存在，非本模块引入。按 AGENTS.md 以现有 FROZEN 文件为准，mismatch 列报给 M8/gate 节点修（该测试文件归 M8 所有）。
  3. M8「无模型来源的 run 绝不产生 status=done」：期望 unknown、M3 engine 实际返回 done —— M3/M8 节点间对账问题，同样在干净 HEAD 复现，非本模块引入。
- 未运行（不属本模块门禁）：npm ci（已知 rc=1，lock 缺 sherpa-onnx-win-arm64）、verify:web、test:unit、lint、Playwright —— 归 gate 节点。
- 本模块零联网、零真实 MCP/模型调用、不读写打印任何 key；时钟全注入。

## 红线自查

主仓/classic/thinkpad/生产/LiteLLM/.env 未碰；只新增/修改归属内 2 文件；contracts/agentic/** 未动（git status 确认）；TDD（RED 基线先commit 于 7bf2dd2，本次实现转 GREEN，补充测试只增不删）；大产出写本文件。
