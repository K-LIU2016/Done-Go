# 探戈 Done&Go P1：双人约定架构

更新日期：2026-10-16
状态：当前产品 P1 基线；本地受控演示已收口，真实双账号和服务端权威状态继续延期。

## 唯一产品入口

P1 属于探戈 Done&Go 本地优先应用，入口是 `http://127.0.0.1:5207/#agreements`，源码入口是 `web/index.html`，领域实现是 `web/agreements.js`，数据键是 `tango-donego.agreements.v1`。React 历史路由不定义当前 P1。

## 产品合同

请求不等于承诺。两个人只有对同一个 `termsVersion + termsHash` 都接受，才形成 Agreement；反提案创建新版本，并把双方响应清回 pending。Agreement 不包含执行授权，形成后 `executionRefs` 固定为空数组，日历或外部动作仍需每方单独批准。

当前领域契约支持：创建请求、接受、拒绝、反提案、撤回、到期刷新、条款哈希计算。约定状态为 `sent / received / withdrawn / expired / rejected / agreed`。

## 不可变边界

1. 只有请求双方能响应；其他身份 fail closed。
2. 响应必须携带当前 `termsVersion` 和 `termsHash`；旧版本或篡改 hash 不能被接受。
3. 单方接受只更新本人响应，不能形成共同 Agreement。
4. 反提案会保留旧版本记录、切换 currentVersion，并清空双方旧响应。
5. 已形成约定的请求不能重复响应；撤回只处理未成约请求。
6. 共同条款最小化：目的、时间范围、时区、投入范围、截止时间和材料引用；不复制私人日历正文或模型推测。
7. Agreement 与执行授权分离；UI 必须继续显示“执行授权仍为空”。

## UI 表现

`#agreements` 显示约定页、发起入口、共同条款版本和 hash、双方身份响应、有效期和状态。页面支持切换“我·林”和“同事·陈”两个演示视角，可执行接受、拒绝、反提案、撤回和重置演示。单方接受显示“等待双方确认”；同一版本双方接受后才显示“已形成约定”。反提案会生成新版本，并让双方重新确认。

## 当前验证

- `tests/unit/tango-agreements.test.mjs` 覆盖同版双方成约、单方不成约、反提案失效、旧 hash、身份越权、终态重复操作、撤回、到期和条款校验。
- `npm run verify:web` 覆盖时间闭环、隐私边界和约定域，并通过语法检查。
- 本地 UI 已按 `#agreements` 路由接入产品壳层。

## 未验证边界

真实双账号、服务端权威存储、跨设备恢复、公开部署、浏览器 E2E 和真人理解度均未验证。这些证据继续累计到 `docs/HUMAN-EVIDENCE-BACKLOG.md`，不得被单元测试冒充完成。

## 后续演进规则

P1 后续能力必须先进入 `web/index.html` 和 `window.TangoAgreements` 的当前产品边界，再考虑服务化。任何服务端实现都必须保留同 hash 成约、双方身份绑定、执行分离、可审计状态和最小共享字段。
