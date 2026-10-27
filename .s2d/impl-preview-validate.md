# preview-validate 实现记录（S2D-W6 模块 2，group 1）

- 日期：2026-10-27 · 实现 actor：w6·实现·preview-validate（模型 GLM-5.3）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w6-preview` @ `feat/s2d-w6-preview`
- 基线：RED 测试提交 `d6858f3`（tests node 已交付 9 个 validate 用例）；W0 冻结 `b9d9bdf` 为 HEAD 祖先（.s2d/plan.md:3-4）

## 交付物

- 新增 `scripts/agentic/preview/validate.mjs`（1 个文件，本模块唯一产出）
  - `validatePreview` / `validateSample` / `validateReel` / `validateScene`：对冻结
    `preview.schema.json`（含同目录 `$ref` → sample/reel/scene）与三个子 schema 的
    `{valid, errors}` 谓词校验（plan.md:51 入库前校验）。
  - `assertValidPreview`：入库前断言门；失败抛 `code:'CONTRACT_INVALID'` + `.errors`
    （负路径 plan.md:31「payload 不过冻结 schema → CONTRACT_INVALID」的谓词来源）。
  - `assertPreviewRoundTrip`：读出往返门（plan.md:51）；JSON.parse 失败（损坏/半写行）
    fail-closed 包装为 `CONTRACT_INVALID`（断线/恢复负路径 plan.md:34 的读侧防线）。
- 实现约束：纯薄封装，全部校验语义复用 W0 `scripts/agentic/contracts.mjs`
  （validate/assertValid/loadSchema），零 schema 规则重实现；schema 只读缓存
  （contracts FROZEN，进程内一次加载）；无 IO、无时钟、无外部调用、不 mutate 入参。
  W11 播放字段（如 `timeline`/`autoplay`）经顶层与嵌套 `additionalProperties:false`
  拒绝（CTO-DECISIONS §2.3；测试 validate.test.mjs:44-50,91-96）。

## TDD 证据

1. RED 复跑（实现前）：`node --test tests/unit/agentic/preview/validate.test.mjs`
   → `# tests 9 / # pass 0 / # fail 9`（全部 ERR_MODULE_NOT_FOUND: validate.mjs）。
2. GREEN：`node --test --experimental-test-coverage tests/unit/agentic/preview/validate.test.mjs`
   → rc=0，`# tests 9 / # pass 9 / # fail 0`；
   覆盖率 `validate.mjs | line 100.00 | branch 100.00 | funcs 100.00`（门槛 ≥80%，plan.md:62）。
3. W0 冻结资产回归：`node --test tests/unit/agentic/contracts/*.test.mjs`
   → rc=0，`# tests 24 / # pass 24 / # fail 0`。
4. 语法/空白：`node --check scripts/agentic/preview/validate.mjs`、
   `git diff --check -- scripts/agentic/preview/validate.mjs` 均 rc=0。
5. 全 preview 目录现状：`node --test tests/unit/agentic/preview/*.test.mjs`
   → 77 tests / 14 pass / 63 fail；除本模块 9 例外另 5 例为 migrations 用例
   （并行实现 agent 已落 preview-001/002.sql，未提交）；其余 63 fail 均为
   store/discussion/timeline/patch/apply/confirm/routes 未实现（其余 agent 范围）。

## 未跑（如实声明）

- `npm run test:unit`、`npm run verify:web`：plan.md:63 的流级收尾门禁，归流收口
  节点统一执行；本模块未冒充流级检查。
- 真实外部调用：0；新增依赖：0；触碰归属外文件：0（contracts/db/W0-W11 文件零改动）。
