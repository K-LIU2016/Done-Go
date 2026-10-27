# W9 G2-M4 w9-contract-consistency 实现记录

- 日期：2026-10-27；worktree `/Users/chillbit/Proj/Done & Go/s2d/w9-delivery` @ `feat/s2d-w9-delivery`。
- 规约输入：`.s2d/plan.md` G2-M4（依赖 M1/M2/M3，均已落 commit 72c5e00/a4bde0f/8e0d27a）+ brief 裁决①③⑤ + RED 套件 `tests/unit/agentic/contracts/w9-contract-consistency.test.mjs`（commit d59000e）。
- 模块文件（归属内）：仅 `tests/unit/agentic/contracts/w9-contract-consistency.test.mjs`；本记录文件。`contracts/agentic/**` 零改动（`git diff 60fdc73 HEAD --stat -- contracts/` 为空、工作树干净）。

## TDD 状态对账（先红后绿）

- 开工实跑 `node --test tests/unit/agentic/contracts/w9-contract-consistency.test.mjs`：8 test 中 7 pass / 1 fail —— 唯一失败是 FROZEN 哨兵：测试常量为 `…574adab6bb`，磁盘/基线为 `…5734adab6bb`。
- 裁决依据（三方对账，文件为准）：`git show 60fdc73:contracts/agentic/FROZEN`、本 worktree `contracts/agentic/FROZEN`、`s2d/w0-contracts/contracts/agentic/FROZEN` 三份逐字相等，均为 `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`。brief/plan 行文里的 `…574adab6bb` 是转写笔误（5734→574a）。
- **文档-代码冲突清单（全局 AGENTS.md 要求）**：brief `/private/tmp/donego-w9-brief-20261027.md` 裁决① 与 `.s2d/plan.md:3` 的 FROZEN 全写值 `b9d9bdfa0511905a95b729753b82e574adab6bb` 均与冻结工件不符（缺 `3`，`5734a`→`574a`）；按既有代码/文件纠正为 `…5734adab6bb`，断言保持严格相等未放宽。plan 张力#4（CTO-DECISIONS §4 W9 行文与 brief/PRD §11 不一致）维持 plan 原记录，以 brief/PRD 为准。

## 交付改动（1 文件，+33/-1）

1. `FROZEN_EXPECTED` 常量纠正为真实基线（附注释记录笔误对账过程）。
2. 补 plan M4 子任务3 缺口：新增测试 `revision_requested never counts as benefit; only a fresh acceptance on the new version can` —— `revise`（带 comment）→ `decision='revision_requested'` 且过 acceptance.schema.json；`acceptedBenefit(revision_requested, 全清 verdictSummary)` 仍为 null；版本链继续（v2 put 成功、状态回 ready）；全新 `accept` 落 `w9_acceptances.artifact_version=2`（对外对象保持 schema 纯净无 version 字段，按 plan 张力#2 查 DB 列断言）后才计入收益。只加不删不放宽。
3. 29 个 schema SHA-256 哨兵经独立脚本逐文件复核（python hashlib），全部一致，无漂移。

## 验证（本机实跑，node v22.22.2，无 node_modules）

- `node --test tests/unit/agentic/contracts/w9-contract-consistency.test.mjs` → rc=0，`# tests 9 / # pass 9 / # fail 0`。
- 全 targeted：`node --test tests/unit/agentic/delivery/*.test.mjs tests/unit/agentic/verifier/*.test.mjs tests/unit/agentic/inbox/*.test.mjs tests/unit/agentic/contracts/w9-contract-consistency.test.mjs` → rc=0，`# tests 190 / # pass 190 / # fail 0`。
- 覆盖率（同上命令 + `--experimental-test-coverage`）：aggregate line 98.30 / branch 93.06 / funcs 97.50；逐模块 line/branch/funcs 全部 ≥80（delivery acceptance 93.55/86.84/100、artifact-store 97.70/93.83/100、benefit 100/100/100、routes 100/88.89/100、util 100/100/100；inbox attention 100/95.12/100、expiry 100/100/100、need-store 96.43/81.44/100、routes 100/85.42/100；verifier 全模块 ≥90.91 branch、funcs 100）。本测试文件自身 100/100/100。
- 已知事实（供门禁对账，非本模块失败）：W9 targeted 命令不含 W0 契约套件时 `scripts/agentic/contracts.mjs` 显示 81.18/64.10/67.86；补跑 `node --test --experimental-test-coverage tests/unit/agentic/contracts/*.mjs`（W0 所有的 4 文件）后 contracts.mjs 为 92.16/83.54/89.66、rc=0——剩余分支归 W0 套件所有，不属 W9 模块逐模块口径。
- `git diff --check` rc=0；改动仅本模块文件。未跑 `npm run verify:web` / `npm run test:unit`（属 G2 门禁节点，不冒充）。

## 红线自查

未改 `contracts/agentic/**`、W3/W4/W6/W10、serve-tango.mjs、web/**、.env；无新增依赖；无网络/外部命令；时钟全注入（seqClock）；未推 main/force；未删测试未放宽校验。
