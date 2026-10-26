# S2D-W8 M5 worktree-mgr 实现记录

## 范围
- 依据：`.s2d/plan.md:84-89` 的 M5 files/subtasks；BUILD-PLAN §2.1 的 W8 归属规则。
- 代码：`packages/donego-bridge/src/git/worktree.mjs`。
- 未修改其他流代码；未读或使用任何 `.env`、真实项目目录或生产环境。

## 实现
- `createMissionWorktree(repoRoot, missionId, {base})`：创建 `feat/donego-<missionId>`，从当前分支或指定 base 创建；检测并复用已登记 worktree，也复用遗留分支而不重置其提交。
- `cleanupMissionWorktree`：移除 worktree；分支未合入 `HEAD` 时保留，已合入时删除；支持显式 `force` 清理有未提交改动的 worktree。
- `listMissions`：解析 `git worktree list --porcelain`，仅列出 `feat/donego-` 分支。
- `containedIn`：对 root 与候选路径做 realpath/最近存在祖先解析，拒绝 `..` 与 symlink 逃逸。
- git 调用使用 `execFileSync` 参数数组，未使用 shell 拼接；missionId 受限为安全的分支/路径字符集。

## 验证
- 命令：`node --test --experimental-test-coverage tests/unit/agentic/bridge/worktree-mgr.test.mjs`
- 结果：退出码 `0`；`1..6`，`# pass 6`，`# fail 0`。
- 覆盖率：实现文件 line `91.49%`、branch `71.70%`、function `100%`；全文件 line `94.95%`、branch `72.06%`、function `100%`。
- 测试覆盖创建/复用、指定 base、未合入保留分支、合入后删除、枚举、`..`/外部路径/symlink 围栏；测试仓库均为测试内 `mkdtemp` 临时 git 仓库。

## 依赖与待项
- 无新增运行时依赖；仅 Node 标准库和 git CLI。
- 未运行全仓 `npm run test:unit`、`npm run verify:web`、真实 Codex 冒烟：本 ask 仅要求本模块单测，且这些门禁由流收尾节点执行。
