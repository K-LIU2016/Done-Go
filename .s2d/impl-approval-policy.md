# ImplOut · approval-policy

- **模块**：M4 approval-policy（G1）。
- **规格依据**：`.s2d/plan.md` M4 subtasks（审批三类映射、范围外 Need、高危拒绝、可扩展黑名单、`policyHook` 注入）；PRD §6.5 L420/L441 与 §8.3；BUILD-PLAN §2.1/§2.3/§3 W8。
- **实现文件**：`packages/donego-bridge/src/policy/approvals.mjs`。
- **行为**：实现 `decideApproval(request, contract, ctx)`；覆盖 command/file/patch 三类请求；worktree 与 deliverables 围栏；NeedSpec（`missionId` + 原请求）；高危命令黑名单（大小写、引号、短参数顺序、强推 refspec）；网络/依赖安装 Need；`policyHook` 可注入但不能覆盖高危拒绝；可选 `resolvePath` 钩子用于真实路径/符号链接校验。
- **测试**：`node --test --experimental-test-coverage tests/unit/agentic/bridge/approval-policy.test.mjs`。
  - 首次运行：31 pass / 1 fail；失败为测试夹具的 synthetic `a/base`、`b/base` 补丁头被当成目标路径。
  - 修正补丁路径解析后复跑：32 pass / 0 fail，退出码 0。
  - 覆盖率：源文件 line 94.64%、branch 76.25%、functions 100%；测试文件 line 100%；全次运行 line 96.19%、branch 79.79%、functions 96.88%。按 line 覆盖率门槛 ≥80% 通过；branch 数值也记录供门禁复核。
- **提交**：待本节点分步提交完成后填入 commit。
- **依赖申请**：无新增运行时依赖；仅使用 Node 内置 `node:path`。
- **未运行**：全量 `npm run test:unit`、`npm run verify:web`、真实 Codex 冒烟与 W0 契约一致性测试不属于本模块单测验收，本节点未运行。
