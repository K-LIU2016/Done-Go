# M09 contract-tests 实现记录

- 模块：`tests/unit/agentic/contracts/**`。
- 依据：`.s2d/plan.md:45-47` 要求先测后码，遍历全部 fixture 的 valid/invalid，覆盖关键字正反例、同目录 `$ref`、日期格式、额外属性、canonical JSON 与 hash 不变量；BUILD-PLAN §2.3 要求 Node ESM、TDD、单测覆盖率至少 80%。
- 读取标准：`contracts/agentic/README.md:4-22,124-137`；现有基线测试 `tests/unit/agentic/contracts/contracts.test.mjs:21-117`；M10 共用测试 `tests/unit/agentic/contracts/db-and-key.test.mjs:27-105`。
- 新增文件：`tests/unit/agentic/contracts/validator-edge.test.mjs`。
- 测试覆盖：组合 schema（allOf/anyOf/oneOf/not）、const/enum、字符串长度与正则、数字边界、数组数量/唯一性、对象属性数量、date/date-time/time 与未知 format、JSON Pointer/同目录/URL `$ref`、primitive type、`assertValid` 返回值、canonical JSON primitive/数组顺序。
- TDD 证据：先写测试，再执行 `node --test tests/unit/agentic/contracts/validator-edge.test.mjs`；该次执行为非零，7 个子测试中 6 通过、1 失败（时间格式断言，测试进程观察到当时的并发实现状态）；随后复跑同命令为 `1..7`, `# pass 7`, `# fail 0`。

## 检查

- `cd '/Users/chillbit/Proj/Done & Go/s2d/w0-contracts' && node --test --experimental-test-coverage tests/unit/agentic/contracts/*.mjs`：退出码 0；`1..24`，`# tests 24`，`# pass 24`，`# fail 0`。
- 同一命令覆盖率：`contracts.mjs` line 92.16% / branch 82.82% / funcs 89.66%；全部文件 line 96.89% / branch 86.31% / funcs 96.70%，达到 ≥80%。
- `cd '/Users/chillbit/Proj/Done & Go/s2d/w0-contracts' && git diff --check -- tests/unit/agentic/contracts/validator-edge.test.mjs && node --check tests/unit/agentic/contracts/validator-edge.test.mjs`：退出码 0，无输出。
- 未运行 `npm run test:unit` 或 `npm run verify:web`；它们属于 W0 收尾门禁 M11，不冒充本模块检查。
- 无外部调用、无新增运行时依赖、无 `.env` 读取、无真实网关 key。
