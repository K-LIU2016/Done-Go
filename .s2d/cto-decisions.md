# CTO 裁决 [DONEGO-S2D-DECISIONS-1]（2026-10-27，BUILD-PLAN §2.4 已同步更新）

## TA2：发布清单矛盾（所有流）
- `tango-release.test.mjs`「release packages every web asset」因新增 `web/agentic/**` 失败——**视为允许的已知失败**
- 各流仍不得改 `scripts/build-web.mjs`
- 报告里逐条列出对应的新增文件即可
- 发布清单由第 3 批 W13 统一更新

## TA3：W0 预存失败（仅 W0）
- 修复契约分支上的 2 个失败：
  1. `contracts.test.mjs` 的日历日期校验——`ISO_DATE_TIME` 要校验真实日历
  2. 坏 `$ref` 应抛结构化错误而不是裸 ENOENT
- 修复后在 `contracts/agentic/README.md` 变更日志记一条
- **不改 v1 语义、不动 FROZEN**

## TD1：W1 e2e 未交付（仅 W1）
- 授权用已有的 `tests/agentic/blocks/harness-server.mjs` 补完三场景 e2e：
  1. 两设备同步（A 新增 → B 拉到）
  2. 冲突上报不丢数据
  3. 断网补写
- Playwright 走全局锁（flock /tmp/donego-s2d-pw.lock）
- 完成后更新 s2d-w1-report.md 第 6 节与门禁⑥

## TA5：已在 BUILD-PLAN 更新基线说明
