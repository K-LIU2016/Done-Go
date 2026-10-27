# choose-model 实现记录

- 模块：M3 choose-model（G1）。
- 规格依据：`.s2d/plan.md:58-64`；PRD §6.5.1 表及额度/让路规则见先行测试 `tests/unit/agentic/bridge/choose-model.test.mjs:30-139`。
- 新增文件：`packages/donego-bridge/src/model/choose.mjs`、`packages/donego-bridge/src/model/rate-limits.mjs`。
- 实现：复杂度纯判断、历史失败升档、LADDER 降档、>70%/ >90% 额度处理、spend-control 暂停、外来 Codex thread 让路、评审反向选模、额度快照；解析器支持顶层与 `weekly.usedPercent`，并夹取百分比。
- TDD 证据：实现前运行 `node --test --experimental-test-coverage tests/unit/agentic/bridge/choose-model.test.mjs`，退出码 1，`ERR_MODULE_NOT_FOUND`（缺失 choose.mjs）。
- 通过检查：同一命令实现后退出码 0，14 tests / 14 pass / 0 fail；最终修正后 choose.mjs line 98.17%、rate-limits.mjs line 100%、all files line 99.27%（branch 88.66%）。
- 运行时依赖：无新增；仅 ESM 纯函数。
- 真实 Codex 调用：0（本模块单测未调用外部服务）。
- 未运行：全仓 `npm run test:unit`、`npm run verify:web`、真实 Codex 冒烟；它们不属于本模块单测且本 ask 未要求作为本节点检查。
