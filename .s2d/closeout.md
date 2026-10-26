# CTO 收口令 [BATCH1-CLOSEOUT-1]（2026-10-27）

## 唯一契约基线
- FROZEN v1 = b9d9bdfa0511905a95b729753b82e5734adab6bb（feat/s2d-w0-contracts 当前）
- b2de664 只是历史旧冻结；必须升级到 b9d9bdf 后再验收
- 不改 schema 语义来掩盖适配问题；契约语义变化→停在 CTO 裁决清单
- W0 契约套件 24/24 独立通过；两个旧 date-time/bad-$ref 失败已修

## 逐流收口要求
### W0
- 报告 HEAD、FROZEN、24/24、覆盖率与未跟踪证据对齐；写清当前 HEAD 真实状态

### W1
- 纳入当前 HEAD 的双设备三场景 e2e；完成 HIGH 修复重跑；发布清单留 W13；升级 b9d9bdf

### W2
- 提交引擎源码和契约/迁移完整边界；完成 crash/pause/outbox/policy 门禁、契约一致性、安全审查和报告
- 报告 HEAD 必须等于实际 HEAD
- 契约合并冲突（.s2d/tests-red.md add/add）需解决：该文件是本地辅助产物，可安全删除后重合

### W5
- 完成 W0/W11/W12 字段对齐；补齐 shots/w5 双端双模式+reduced-motion；完成 demo 黄金场景、a11y/e2e、契约一致性及报告

### W8
- 升级/验证 W0 契约；保留真实 Codex smoke 原始证据；只有真实 plan→execute→test→review 才报成功

### W11
- 四路评审 actor 有明确模型；真实媒体调用账本；升级 b9d9bdf；超时不写成功

### W12
- 四路评审 actor 有明确模型；保留快路超2s真实数据；ContextDelta/SuggestionCard 分叉和 HEIC/XMP/视频钩子→裁决项；升级 b9d9bdf

## 统一验收
- 报告：精确 HEAD、每道门禁命令+rc、覆盖率、真实外部调用数、未修项、接口说明、待 CTO 裁决
- 不得引用已淘汰 HEAD；工作树状态分列；不吞 git/test 错误
- resolved_model 空→不报通过；无绑定→UNKNOWN

## 约束
- 收口后只返回七流对账表和待裁决项；不自动开下一批
