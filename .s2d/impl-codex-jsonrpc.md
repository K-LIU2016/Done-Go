# S2D-W8 M1 实现记录：codex-jsonrpc

- 范围依据：`.s2d/plan.md:41-47`；先行测试契约：`.s2d/tests-red.md:18,34-60`。
- 实现文件：`packages/donego-bridge/src/codex/jsonrpc.mjs`。
- 提供 `createJsonRpcSession({spawn, argv, onNotify, onServerRequest, onParseError, now, requestTimeoutMs})`。
- 覆盖 JSONL 半包缓冲、请求 id 关联/乱序响应、RPC error、通知、服务端请求 reply、超时、EOF、close、客户端通知。
- 依赖通过 `spawn` 注入；未启动真实 Codex，符合 `.s2d/plan.md:15` 与本 ask 的“单测 mock”要求。

## 验证

命令：
`node --test --experimental-test-coverage tests/unit/agentic/bridge/codex-jsonrpc.test.mjs`

结果：12 tests / 12 pass / 0 fail；exit code 0。覆盖率报告：实现文件 line 94.25%，function 88.24%；全文件 line 96.84%。

## 变更与提交

已按 `/tmp/s2d-w8-git.lock` 与 pathspec 提交实现文件，commit：`cafc39ecacdcf10b1e4e8154533c4644446f0463`（`feat(bridge): add Codex stdio JSON-RPC session`，含 `Co-Authored-By: ZCode`）。未提交 `.s2d/` 工作流元数据或其他模块文件。
