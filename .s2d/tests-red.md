# W0 单测 RED 证据

- 日期：2026-10-26
- 工作区：`/Users/chillbit/Proj/Done & Go/s2d/w0-contracts`
- 依据：`.s2d/plan.md` M08–M10 要求先测后码；任务要求“为每个模块先写单测、跑出 RED”，且 BUILD-PLAN §2.3 要求 Node ESM、TDD。

## 命令与结果

```text
cd '/Users/chillbit/Proj/Done & Go/s2d/w0-contracts' && node --test --experimental-test-coverage tests/unit/agentic/contracts/*.test.mjs
exit_code=1
```

完整运行输出曾临时保存于 `.s2d/tests-red.raw`。最后一次结果：17 tests，10 pass，7 fail。

## 失败摘要

- `date-time format rejects impossible calendar dates`：现有校验器把 `2026-02-30T12:30:00Z` 判为 valid；断言期望 invalid。
- `validator rejects an unresolvable same-directory ref`：现有 `loadSchema()` 对缺失 `$ref` 文件抛 `ENOENT`，没有返回结构化 `unresolvable $ref` 校验错误。
- `openAgenticDb enables WAL and foreign keys for a file database`：目标 `scripts/agentic/db/index.mjs` 不存在，Node 报 `ERR_MODULE_NOT_FOUND`。
- `migrate sorts SQL files, records them, and is idempotent`：同上，目标模块不存在。
- `migrate rolls back a failed migration and does not record it`：同上，目标模块不存在。
- `gatewayKey reads the current donego key at call time`：目标 `scripts/agentic/gateway-key.mjs` 不存在，Node 报 `ERR_MODULE_NOT_FOUND`。
- `gatewayKey reports GATEWAY_KEY_MISSING without exposing a value`：同上，目标模块不存在。

## 已写测试范围

- 契约 fixture：每 schema 至少两条合法与一条非法样例；schema-fixture 一一对应。
- 校验器：required/properties/additionalProperties、enum/items/date-time、同目录 `$ref`、缺失 `$ref`、`assertValid` 错误码。
- README 契约边界：状态机、错误码、API、owner 隔离、W0 不挂路由、contractHash。
- 规范化/hash：递归 key 排序、数组顺序、字段顺序等价、顶层 `hash` 剔除、字段改变导致 hash 改变。
- SQLite：WAL、外键、owner_id 记录；迁移排序、记账、幂等、失败回滚。
- gateway key：临时 HOME 运行时读取、连续调用不缓存、缺失错误码且不泄露 key。

## 约束核对

本次只新增/修改测试归属目录 `tests/unit/agentic/contracts/**` 与测试证据文件；未写实现代码，未调用外部服务，未读取 `.env`，未打印或落盘真实密钥。
