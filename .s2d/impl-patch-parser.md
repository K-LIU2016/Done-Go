# S2D-W6 模块 6 实现记录：patch-parser

- 节点：G3 patch-parser（plan.md:55，模块 6）
- 日期：2026-10-27 · 分支 `feat/s2d-w6-preview`（基线 60fdc73，W0 冻结 b9d9bdf 为祖先）
- 文件（2 归属文件 + 本记录）：
  - `scripts/agentic/discussion/patch-parser.mjs`（新增，纯解析层）
  - `tests/unit/agentic/preview/patch-parser.test.mjs`（RED 批次 11 测为冻结规格、零改动；追加 5 测覆盖 plan §2 负面路径在解析层的分支）
- 提交：见 `git log` "feat: patch-parser — …"（flock `/tmp/donego-s2d-w6-git.lock` 串行提交）

## API（与 RED 测试及 G3 apply / G4 routes 的注入期望对齐）

`parsePatch(utterance, options?)` → Promise `{ utterance, patch, origin }`

- **确定性规则内核**（默认路径，零 I/O、零时钟、零外部调用）：
  - R1 `只看X`（负向后顾排除 `不只看到…`，捕获到子句标点止，顿号拆列表项）→ `patch.sources = { include: [...] }`
  - R2 禁读邮箱（`别/不/不要/禁止 (+再) 读|看|查|访问 (我的) 邮箱`；`允许读邮箱` 不触发）→ `patch.boundary = { wont: { add: ['读取邮箱'] } }`
  - R3 `N 单位`（课时|小时|分钟|字|页，首处命中，数值化）→ `patch.length = { unit, value }`
  - 多规则命中合并进同一 patch（PRD §5.2 组合话语例）；命中任一规则 → `origin:'rules'`，**绝不**再调用注入的 LLM（规则优先且免费可审计）
- **可注入 LLM iface**：`options.llm = { parse: async utterance => MissionPatch | null }`，仅在规则全不命中时调用；结果为对象 → `origin:'llm'` 原样透传，`null` → `origin:'llm', patch:null`（LLM 合法回答"无补丁"）；未注入 → `origin:'none', patch:null`
- **fail-closed（plan §2 超时行）**：注入上游的一切失败——超时（`timeoutMs`，默认 10s）、rejection、返回数组/原始值——一律 `UPSTREAM_UNAVAILABLE`（cause 保留），**绝不**伪造补丁；调用方 apply.mjs 以此实现"预演零变更、无半应用补丁"
- **输入校验先于任何上游调用**：utterance 非字符串/纯空白/>2000 字、`llm.parse` 非函数、`timeoutMs` 非正数 → `CONTRACT_INVALID`；`MAX_UTTERANCE_LENGTH` 从 `discussion/store.mjs` 导入（单一事实源，与存储层同值）
- **职责边界**：本模块只提取意图不授权——内核只会收紧（sources 收窄/wont.add/length），放宽系统 wont（PRD §8.1 默认禁止项）的 FORBIDDEN 判定归 apply.mjs

## 关键决策

1. **超时竞速的善后**：上游 promise 预挂 no-op `.catch`，竞速已决后迟到的 rejection 不会变成 unhandled rejection；`finally` 清 timer。
2. **LLM 同步 throw 也走 rejection**：`Promise.resolve().then(() => llm.parse(...))` 包裹，同步异常统一被包装为 `UPSTREAM_UNAVAILABLE`（cause 保留）。
3. **数组返回值视为上游失败**（`typeof [] === 'object'` 但不是 MissionPatch）；`null` 例外为合法"无补丁"。
4. **R1 顿号拆分 + 负向后顾**：`只看论文、公开官网` → `include:['论文','公开官网']`；`不只看到海外案例` 不触发（非收窄语义）。
5. **超时消息含 "timeout" 字样**（测试 /timeout/i 断言）：`llm patch parse timeout after Nms`。

## 测试证据（本会话实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/preview/patch-parser.test.mjs`（实现前） | **rc=1，11 测 0 pass / 11 fail**（ERR_MODULE_NOT_FOUND patch-parser.mjs） |
| GREEN | 同上（实现后） | **rc=0，16/16 pass**（11 冻结规格 + 5 追加） |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/preview/patch-parser.test.mjs` | **patch-parser.mjs line 100.00 / branch 98.25 / function 100.00**（≥80 过；未覆盖 1.75% 分支为 `options ?? {}` 的 null 入参分支已由追加测试覆盖、余为防御性 `error?.` 短路组合） |
| 全量 | `npm run test:unit` | 1075 tests：1049 pass / **24 fail** / 2 skipped；24 = apply 11 + routes 10（G3/G4 兄弟节点未实现的 RED）+ 基线 3（streamChat typed deltas、independent authenticated accounts、AI shared fields，与 plan §1 记录一致）。**patch-parser.test.mjs 0 失败**（16/16）；文件级归因口径，worktree 多节点共享、全量数字随并行提交浮动 |
| web | `npm run verify:web` | **227/227 pass，rc=0**（本模块无 web 文件） |
| lint | `npx oxlint <两个文件>` | 0 warnings / 0 errors |

- 真实外部调用：0（无网关/模型调用；LLM 一律测试 mock 注入）
- 新增依赖：0；密钥读取：0
- 文件归属：仅 `scripts/agentic/discussion/**` 与 `tests/unit/agentic/preview/**` 内新增/追加；contracts、W0 db/index.mjs、兄弟节点文件零触碰
