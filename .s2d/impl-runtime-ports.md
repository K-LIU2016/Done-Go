# M1 runtime-ports 实现记录

- 模块：`scripts/agentic/runtime/ports.mjs`、`scripts/agentic/runtime/errors.mjs`、`tests/unit/agentic/runtime/ports.test.mjs`（plan.md M1，组1）。
- RED 基线：commit `7bf2dd2` 已含 ports.test.mjs（12 cases）；实现前实测
  `node --test tests/unit/agentic/runtime/ports.test.mjs` → rc=1，`ERR_MODULE_NOT_FOUND: scripts/agentic/runtime/errors.mjs`（RED 证据 /tmp/w7-m1-red.log 摘录于本文件下方）。
- 新增实现（纯结构定义 + 工厂校验，无业务判定）：
  - `errors.mjs`：`FAIL_CLOSED_CODES`（六码，均落在冻结 `api-error.schema.json` `error.code` 枚举内）；`sanitizeMessage`（Authorization/Bearer/sk-/cookie/api-key/token 脱敏，空串回退）；`failClosed(code, message, details?)` → Error（`.code`/`.details`，非法 code 抛 TypeError）；`toApiError(err)` → 冻结信封 `{error:{code,message,details?}}`，未知错误统一 INTERNAL_ERROR 且 message 不回显原文。
  - `ports.mjs`：`validatePolicyPort`（缺/非对象/无 check/check 非函数 → CONTRACT_INVALID fail closed）；`validateModelCaller`/`validateToolCaller`（非函数 → fail closed）；`validateSpanSink`（可选；给了必须 `{record()}`）；`validateClock`（必须 `{now()}`）；`readPolicyDecision`（`{allow:boolean, reason?, need?}` 形状）；`policyCheck(port, ctx, action)`（check 抛错 → FORBIDDEN fail closed，不放行不吞错）；`bindRuntimePorts({...})`（任一必需端口缺失 → 构造失败）；`createFixedClock(iso)`/`createSteppableClock(iso)`（epoch ms，advance 支持负步长，非法 ISO/非法 advance → CONTRACT_INVALID；只 Date.parse 注入字符串，不读真实 wall clock）。
- 测试新增（追加 8 cases，0 删除；覆盖 plan M1 负面清单中 RED 基线缺失的两条：check 抛错、clock 缺失，外加脱敏与时钟注入非法值）：合计 20 cases。
- 实测修复记录：追加测试初版 2 处测试侧缺陷（`assert.rejects` 用于同步函数、bare `Bearer` 断言），修测试+给 errors.mjs 补 bare-Bearer 脱敏规则后全绿；期间未放宽任何既有断言。

## 检查（全部本节点实测）

- GREEN：`cd '/Users/chillbit/Proj/Done & Go/s2d/w7-runtime' && node --test tests/unit/agentic/runtime/ports.test.mjs` → rc=0；`# tests 20 / # pass 20 / # fail 0`（/tmp/w7-m1-green3.log）。
- 覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/runtime/ports.test.mjs` → rc=0；
  `errors.mjs` line 100.00 / branch 90.48 / funcs 100.00；`ports.mjs` line 100.00 / branch 98.41 / funcs 100.00（逐模块 ≥80% 达标）。
  "all files" 80.19/76.65/76.64 系把非本模块的 W0 `contracts.mjs`（42.35 line）与测试文件自身计入；全 W7 aggregate 在门禁节点按 plan 门禁 1 的完整 glob 重测。
- 语法：`node --check scripts/agentic/runtime/ports.mjs && node --check scripts/agentic/runtime/errors.mjs` → rc=0。
- 边界自查：实现只 import `./errors.mjs`；无 `Date.now()`（仅文档注释提及禁令）、无 `process.env`/`.env` 读取、无 fetch/http、无网络、无 key 读写打印；未触碰 W0/W3/W4/W6/W10 文件与 `contracts/agentic/**`；测试对 RED 基线只追加（git diff 0 删除）。
- 未运行：`npm ci`/lint/`verify:web`/`test:unit`（属门禁节点；npm ci 已知 rc=1，lock 缺 sherpa-onnx-win-arm64@2.0.0）。
- 面向 M2/M3/M8 的接口事实：`createFixedClock`/`createSteppableClock` 被 engine.test.mjs 与 w7-contract-consistency.test.mjs 引用，签名与本实现一致（`now() → epoch ms`、`advance(ms) → epoch ms`）。
