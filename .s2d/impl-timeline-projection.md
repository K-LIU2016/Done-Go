# timeline-projection 实现记录（S2D-W6 模块 5，group 2）

- 日期：2026-10-27 · 实现 actor：w6·实现·timeline-projection（模型 GLM-5.3）
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w6-preview` @ `feat/s2d-w6-preview`
- 基线：RED 测试已在 `d6858f3` 交付（timeline.test.mjs 9 用例）；W0 冻结 `b9d9bdf` 为 HEAD 祖先（.s2d/plan.md:3-4）

## 交付物

- 新增 `scripts/agentic/preview/timeline.mjs`（1 个文件，本模块唯一代码产出）
  - `projectTimeline(preview, source = null)`：冻结 Preview(+可选库存元数据)→W11
    播放器 Timeline VM 的单向投影 seam。输出
    `{ missionId, version, shots, durationSec, tracks, narration{text,segments},
    samples, shape{kind,title,blocks}, fallbacks, source }`，端到端 JSON 可序列化。
  - **零 schema 改动**（CTO-DECISIONS-2026-10-27 §2.3）：只读冻结
    preview.schema.json 已有字段（storyboard/reel/narration/samples/shape），
    绝不为播放器便利扩展冻结契约；W11 播放字段不进 Preview schema。
  - **纯函数**：无 IO/时钟/外部调用；输出全部深拷贝（structuredClone），
    不 alias 冻结输入（测试 deepFreeze 反证）；`source` 元数据 verbatim
    深拷贝随行，缺省为 `null`——投影永不要求非契约元数据（测试
    timeline.test.mjs:100-106）。
  - **加法式映射**：storyboard 1:1 保序 → shots（`need` 用户触点按需保留，
    PRD §5.2.3）；`reel.durationSec`/`reel.tracks` 直通（tracks 可选，缺省
    `[]` 不报错，timeline.test.mjs:32-39）；samples 原样透传给播放器排版。
  - **narration 分段**：确定性规则按句终标点（。！？!?；;）切段，段为
    `{text}` 对象且保留终止符，`segments.map(s=>s.text).join('') === 原文`
    （timeline.test.mjs:46-56 的重组不变量）；尾段无终止符也成段。
  - **未知组件降级**（PRD §10.3「未知类型降级为纯文本」）：
    KNOWN_COMPONENTS = PRD §10.3 首批 12 组件（outline/facts/table/cards/
    checklist/timeline/slides/diffSummary/mapRoute/personCard/caveat/sample）；
    已知组件 `{type, known:true, data:<原块深拷贝>}`；未知组件降级为
    `{type, known:false, fallbackText}`（块内非空 `text` 优先，否则
    `unsupported component: <type>`），并在 `fallbacks` 记录来源路径
    `shape.blocks[i].type=<type>`（timeline.test.mjs:69-90）。
  - 前置条件（不在此复检）：`preview` 已过 validate.mjs 冻结 schema 门；
    投影刻意不含验证，保持为纯读侧变换（路由层先验后投影）。

## TDD 证据（本节点实跑）

1. RED 复跑（实现前）：`node --test tests/unit/agentic/preview/timeline.test.mjs`
   → exit=1，`# tests 9 / # pass 0 / # fail 9`，全部 `ERR_MODULE_NOT_FOUND`
   （/tmp/w6-timeline-red.log）。
2. 迭代修正：首版 narration 段为纯字符串，测试要求段对象（`segment.text`，
   timeline.test.mjs:53）→ 改为 `{text}` 对象后转绿。终版 GREEN 前无其他返工。
3. GREEN：`node --test --experimental-test-coverage
   tests/unit/agentic/preview/timeline.test.mjs` → exit=0，
   `# tests 9 / # pass 9 / # fail 0`；
   覆盖率 `timeline.mjs | line 100.00 | branch 95.24 | funcs 100.00`（门槛
   ≥80%，plan.md:62）。未覆盖分支 1 处：narration 尾段无句终标点的成段
   push（fixture 均以。结尾）——95.24% 达标，不为凑数加断言。
4. W0 冻结资产回归：`node --test tests/unit/agentic/contracts/*.test.mjs`
   → exit=0，`# tests 24 / # pass 24 / # fail 0`。
5. W0 fixtures 投影 ad-hoc 检查（node --input-type=module 内联脚本）：
   preview.fixtures.json 全部 2 条 valid 样例过 projectTimeline，校验
   纯性（输入快照不变）、narration 重组不变量、无空段、JSON 可序列化，
   2/2 通过；样例 fallbacks 为空（组件均在首批目录内）。
6. 语法/空白：`node --check scripts/agentic/preview/timeline.mjs`、
   `git diff --check -- scripts/agentic/preview/timeline.mjs` 均 rc=0。
7. preview 目录现状：`node --test tests/unit/agentic/preview/*.test.mjs`
   → 82 tests / 41 pass / 41 fail；本模块 9/9 绿；validate 9/9、migrations
   6/6（已提交）、store 10/10（兄弟节点进行中未提交）亦绿；discussion-store
   7/9（兄弟进行中）；patch-parser 0/11、apply 0/11、confirm 0/7、routes 0/10
   仍 RED——归其余实现 agent，非本模块范围。

## 未跑（如实声明）

- `npm run test:unit`、`npm run verify:web`：plan.md:63 流级收尾门禁，归流
  收口节点统一执行（沿 preview-validate/migrations 先例）；本模块未冒充流级检查。
- 真实外部调用：0；新增依赖：0；触碰归属外文件：0（contracts/db/W0-W11
  文件零改动；工作树内兄弟 agent 未提交产物未触碰、未入本提交）。

## 提交

- `flock -w 900 /tmp/donego-s2d-w6-git.lock` 下 `git add` 仅
  `scripts/agentic/preview/timeline.mjs` + 本文件后 `git commit`
  （commit hash 见终报/证据文件）；不推 main、不 force、不 --no-verify。
