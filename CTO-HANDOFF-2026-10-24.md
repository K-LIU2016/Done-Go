# Done-Go CTO 交接文档

**生成日期：** 2026-10-24（Asia/Shanghai）  
**项目：** Done-Go / Done&Go（Tango）  
**生产主机：** `argus-thinkpad`  
**生产目录：** `/home/jc/projects/Done-Go`  
**维护角色：** CTO 接管后的持续交付与验收记录

## 1. 这份文档解决什么问题

这份文档把本轮接手后的实现、发布、验证和遗留风险集中记录，供下一次 CTO 会话、ZCode 会话和 JC 亲自验收使用。文档中的证据严格区分为：

- **VERIFIED**：本轮直接读回或执行得到的证据。
- **HISTORICAL**：本轮之前已经记录的证据；代码合并后需要按当前 SHA 重跑，不能直接冒充当前发布证据。
- **INCONCLUSIVE**：存在部分证据，但还不能推出完整结论。
- **UNKNOWN**：没有足够的直接证据，下一步必须补齐。
- **FAIL**：直接检查发现失败。

邮件收件、真实账号注册、用户体验和外部服务可用性都属于独立验收层，不能由单元测试、Playwright、HTTP 200 或代理进程状态替代。

## 2. 当前真实状态

### 2.1 Git 与生产版本

| 对象 | 当前值 | 状态与含义 |
|---|---|---|
| GitHub `K-LIU2016/Done-Go` `main` | `00dc54342b3aba63ddaf2b502ec8b0bc933ee9eb` | **VERIFIED**；最新合并提交 `merge latest tunnel asset updates` |
| Mac CTO 工作副本 | `00dc543`，工作树干净 | **VERIFIED**；本轮已确认本地与 `origin/main` 一致 |
| ThinkPad 生产工作树 | `d1e1eb7bd5949de3e9298e52231fd21e365199c5` | **VERIFIED**；detached HEAD，当前生产比 GitHub `main` 少最新的 `web/app-auth.css` 居中样式合并 |
| ThinkPad 工作树 `origin/main` | `b4520d4` | **VERIFIED**；这是该副本的旧远端引用，使用前必须先 fetch，不能据此判断 GitHub 当前 main |
| ThinkPad 服务 | `donego.service` = `active` | **VERIFIED**；服务进入时间为 2026-10-24 11:40:38 CST |
| 应用本机入口 | `http://127.0.0.1:17507/` | **VERIFIED**；返回 HTTP 200 |
| 公网入口 | `https://donego.udify.fun/` | **VERIFIED**；本轮探测返回 HTTP 200 |
| 生产 `.env` | `/home/jc/projects/Done-Go/.env`，权限 600 | **VERIFIED**；只确认变量名和权限，不记录值 |
| 协作数据库 | `.tango-donego/collaboration.sqlite`，权限 600 | **VERIFIED**；未做清理、迁移回滚或恢复演练 |

生产工作树目前仍是 detached HEAD，不能把它当成 GitHub `main` 的自动跟随副本。下一次部署前必须先建立当前候选 SHA、备份点和服务读回证据，再明确切换到候选版本。

### 2.2 运行进程与隧道

- `donego.service` 的 `WorkingDirectory` 是 `/home/jc/projects/Done-Go`，启动脚本是 `scripts/serve-tango.mjs`。
- 本轮直接看到 Done-Go Node 进程监听 `127.0.0.1:17507`；此前看到的 `:3019` 属于另一进程，不能作为 Done-Go 健康端口。
- cloudflared 当前有独立进程使用 `/home/jc/.config/argus/cloudflared/ingress.yml` 运行；用户级 `cloudflared.service` 查询为 inactive。因此“隧道可用”已被直接探测，但“由哪个持久化服务托管”仍是 **INCONCLUSIVE**，不要只依据 systemd 服务名重启或恢复。
- 当前 Done-Go 路由为 `donego.udify.fun -> http://127.0.0.1:17507`，并设置了 `httpHostHeader: donego.udify.fun`。该 Host header 是处理代理/隧道源站校验的重要配置，备份文件为：
  `/home/jc/.config/argus/cloudflared/ingress.yml.bak-donego-hostheader-20261024`。

## 3. 本轮已完成的工作

### 3.1 真实账号入口与账户后台

已将 Done-Go 从只有登录表单的状态推进到可用的真实账号入口：

- 登录页提供“已有账号，去登录”和“还没有账号，去注册”两个明确入口。
- 注册支持邮箱验证码、密码、确认密码和可选称呼；登录与注册共用账号字段，邮箱和手机号分支由服务端识别。
- 邮箱验证码注册流程接入真实邮件配置；测试 fixture 仍使用虚拟邮箱和虚拟时间推进，避免把测试限流状态污染到真实环境。
- 登录后顶部显示“账户设置”和“退出登录”。
- 用户设置页增加账号与安全区：已验证邮箱、用户角色、称呼保存、修改密码、打开协作和退出登录。
- 退出后会话失效，应用回到登录墙；浏览器本地时间记录仍保留，不因退出账号被删除。
- 管理员入口与普通用户权限仍分离，不能用普通用户测试替代管理员验收。
- 已修复注册界面文案/本地化表变更导致的前端运行时问题；这是之前“页面只显示登录、看不到注册按钮”的主要代码侧原因之一。

涉及的主要提交：

- `5720946`：完成注册与账户设置主体。
- `2a0f158`：将最新认证实现和账户设置合并到发布线。
- `1bf1988`：认证页标题恢复居中布局。
- `00dc543`：将认证页和隧道资源修复合并到 GitHub `main`。

### 3.2 隧道静态资源修复

公网页面曾出现“根路径可达、但静态资源加载不稳定”的现象。问题不是单纯的应用路由，而是隧道/代理对静态响应头、连接关闭、压缩和大块响应的组合处理不稳定。修复按以下顺序保留了历史证据：

1. `786a68e`：补静态资源 `Content-Length`。
2. `745be42`：修正响应关闭行为。
3. `7e67974`：尝试压缩静态资源。
4. `d60d802`：恢复标准连接行为。
5. `4e7d55a`：改为分块发送静态资源。
6. `d1e1eb7`：最终保留不压缩、带 `Content-Length`、16 KiB 分块发送的兼容路径。
7. `00dc543`：把该路径和认证页增量合并到 GitHub `main`。

当前 ThinkPad 生产在 `d1e1eb7`，因此已经包含最终静态资源兼容实现；GitHub `main` 比它多的是认证页标题居中样式合并，需在下一次受控发布时统一。

### 3.3 配置与邮件边界

ThinkPad `.env` 中已确认存在以下变量名，值不写入本交接文档：

- `TANGO_AUTH_SECRET`
- `RESEND_API_KEY`
- `MAIL_FROM`
- `EMAIL_TRANSPORT`
- `TANGO_AI_KEY`

发送地址约定为 `Done-Go <noreply@udify.fun>`。真实验证码邮件是否到达用户邮箱，由 JC 亲自操作验收；CTO 不在文档、日志或消息中重复密钥、验证码和邮箱凭据。

## 4. 已有验证证据与证据边界

以下是本轮之前已记录的直接验证结果；因为随后 GitHub `main` 又完成了合并，所以在宣布下一次正式发布前需要按 `00dc543` 重跑：

- `npm run verify:account`：10/10 通过，覆盖邮箱注册、手机号注册、账户设置、密码更新和退出。
- `npm run verify:web`：227 项通过。
- 定向认证/手机号回归：29 项通过。
- 公网 Playwright/浏览器检查：根页面 200；匿名 `/api/auth/me` 返回 401；登录表单可见；注册入口可见；点击注册后确认密码字段出现。
- 通过新 Playwright 上下文检查过公网页面；不能把一个旧的、空白或失焦的浏览器标签页截图当作当前应用状态。
- 公网真实邮件没有由 CTO 代替 JC 做收件确认；这项保持 **UNKNOWN/待用户验收**。

这些证据证明了代码路径和部分公网可达性，不自动证明：真实邮箱收件、跨重启数据库持久化、完整 Tango Playwright 套件、数据库迁移回滚、所有外部 AI provider、完整管理员流程或用户本人最终验收。

## 5. 重要踩坑与处理原则

### 5.1 “HTTP 200”不是产品验收

根页面 200 只证明入口能返回内容。必须分别检查静态资源、认证墙、注册入口、验证码发送、实际收件、登录、退出、账号设置和数据隔离。匿名 `/api/auth/me` 的 401 是预期认证墙，不能把它当成服务故障。

### 5.2 旧标签页不能代表当前 UI

浏览器旧标签页可能保留失焦、空白或缓存状态。出现“没有注册按钮”时，要先用新上下文打开当前公网地址，检查 DOM 和控制台，再决定是 UI 缺陷还是浏览器状态问题。

### 5.3 隧道问题不能只看应用代码

静态资源经过 cloudflared/代理时，压缩、Content-Length、连接生命周期和分块方式都会影响浏览器结果。修复后要同时做本机 17507、隧道公网、静态资源和认证 API 检查，不能只 curl 根路径。

### 5.4 Git 分支和部署来源必须实名核对

ThinkPad 生产目录是 detached HEAD，且本地 `origin/main` 引用已经过期。部署前必须：

1. 在 ThinkPad 先 fetch 正确远端。
2. 用完整 SHA 标记候选版本。
3. 保留当前生产 rollback ref、`.env`、数据库和工作树状态。
4. 确认候选 SHA 在“候选仓库”和“服务仓库”都存在且一致。
5. 通过 service owner 切换并重启，随后做本机和公网读回。

禁止用 `reset --hard`、`clean` 或 force-push 掩盖来源不清和工作树差异。

### 5.5 测试 fixture 不能冒充真实邮件

测试邮件服务器可以验证验证码、限流和注册状态机，但不能证明 Resend 已投递，更不能证明用户收件箱能收到邮件。真实账号验收必须由用户控制邮箱完成。

### 5.6 代理服务进程的名字不能当作托管证据

本轮发现 cloudflared 进程确实在运行，但同名 user systemd unit 为 inactive。以后要记录 PID、启动命令、配置路径、路由和退出后的恢复方式；不要只凭 `systemctl is-active cloudflared.service` 判断公网是否健康。

### 5.7 先把 UNKNOWN 留在分母里

任何“完成”“PASS”文案都必须能追溯到真实命令返回码、精确 SHA、备份目录列表和读回结果。没有证据的真实邮件、迁移回滚、完整套件、provider 和用户验收都保持 UNKNOWN。

## 6. 当前未完成项

### P0：亲自验收前必须关闭

- JC 用真实邮箱完成：注册 → 收验证码 → 设置密码 → 登录 → 打开账户设置 → 修改称呼 → 退出 → 再次登录。
- 核对邮件发件人显示为 `Done-Go`，链接/验证码有效，失败时 UI 不泄露原始密钥或内部错误。
- 在 ThinkPad 用 fetch 后的 GitHub `main` 确认 `00dc543` 与生产 `d1e1eb7` 的差异和来源，不能直接覆盖当前生产工作树。
- 对候选 SHA 做一次受控部署前备份，部署后重新检查：本机 17507、公共域名、静态资源、匿名 401、注册入口和退出行为。
- 明确 cloudflared 的真实托管方式；如果仍由独立进程托管，记录恢复命令和持久化方案。

### P1：发布后必须补齐

- 按当前 `main` 重跑账户、网页和 demo direct-entry 门禁，并保存命令、返回码、SHA 和时间。
- 完整 Tango Playwright 套件：邮箱/手机号、管理员/普通用户、刷新/重启、权限边界和错误态。
- 数据库备份恢复与迁移回滚演练。当前只确认数据库文件存在且权限为 600，**没有**证明可恢复。
- 验证服务重启后的用户、会话和本地协作数据持久化；验证备份不包含密钥、cookie、验证码和用户正文。
- 完整 AI provider 可用性和额度仍单独验收，不把 LiteLLM Infra 纳入本项目 CTO 变更范围。

### P2：治理与清理

- 把交接文档入口加入项目 README，并在正式候选 SHA 上提交；避免只存在于某个 detached 工作树。
- 评估旧 `cto/final*`、旧临时 worktree 和 stale remote refs 的保留周期。未确认所有权前不删除。
- 将部署记录、回滚记录和用户验收记录按候选 SHA 关联，形成可追溯发布链。

## 7. 下一步执行单

### 第一步：用户验收窗口

等待 JC 在公网完成真实邮箱注册和登录体验。CTO 只协助定位失败，不代替用户确认收件结果。用户反馈后记录：时间、候选 SHA、页面路径、HTTP 结果、邮件是否到达和是否能完成登录；不记录验证码和密钥。

### 第二步：生产来源对账

在 ThinkPad 执行只读对账：

```sh
cd /home/jc/projects/Done-Go
git fetch origin main
git rev-parse origin/main
git rev-parse HEAD
git diff --stat HEAD origin/main
git status --short --branch
```

若工作树、`.env`、数据库或临时备份有变化，先保留并记录归属；只有在确认干净且候选身份一致后才进入部署。

### 第三步：受控发布 `00dc543`

发布前保存当前 HEAD、服务状态、`.env` 权限、数据库文件和 rollback ref。候选切换必须通过服务 owner 完成；发布后至少读回：

```sh
systemctl --user is-active donego.service
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17507/
curl -sS -o /dev/null -w '%{http_code}\n' https://donego.udify.fun/
curl -sS -i https://donego.udify.fun/api/auth/me
```

预期是根路径 200、匿名 `/api/auth/me` 401，并且页面静态资源与注册入口实际可见。任何一项失败都停止公开验收，保留现场，使用已核实的 rollback ref 评估恢复。

### 第四步：补齐发布后验证

按 P1 顺序执行完整 Playwright、重启持久化、备份恢复和迁移回滚。所有报告必须携带候选 SHA；旧构建的截图和测试结果只能作为历史参考。

## 8. 回滚锚点与保护规则

当前已保留的生产 rollback refs：

- `refs/rollback/donego-20261024-1044` → `acd734a`，认证邮件品牌化。
- `refs/rollback/donego-20261024-1129` → `2a0f158`，认证与账户设置合并线。
- `refs/rollback/donego-20261024-1133` → `786a68e`，静态资源 Content-Length。
- `refs/rollback/donego-20261024-1138` → `745be42`，响应关闭修复。
- `refs/rollback/donego-20261024-1142` → `7e67974`，压缩尝试。
- `refs/rollback/donego-20261024-1148` → `d60d802`，连接行为修复。
- `refs/rollback/donego-20261024-1154` → `4e7d55a`，分块静态资源。

回滚必须先验证目标是正确的 Done-Go commit，再切换服务；不清理 SQLite、不覆盖 `.env`、不删除用户数据、不 force-push。没有经过恢复演练前，数据库迁移回滚结论保持 UNKNOWN。

## 9. CTO 工作边界

- LiteLLM Infra 由 JC 独立负责，本项目 CTO 不迭代、不重启、不修改其会话或配置。
- Done-Go 真实邮件和账号链路默认按真实账号设计；用户验收是发布闭环的一部分。
- 技术问题、普通失败处理和 ZCode 工作流由 CTO 直接判断；只有需要 JC 身份、邮箱、凭据、现场验收或重大产品决策时才通知 JC。
- 所有变更都要保留现有 dirty/staged/untracked、备份和回滚证据；不得用清理现场制造“干净”。
- 任何生产发布都必须同时写清候选 SHA、服务状态、HTTP 读回、测试命令和剩余 UNKNOWN。

## 10. 一句话交接结论

Done-Go 的真实账号入口、注册/登录/退出和账户设置已经进入可验收状态，隧道静态资源兼容修复已在 ThinkPad 当前生产版本中生效；现在最重要的工作是由 JC 完成真实邮箱验收，然后把 ThinkPad 从 detached `d1e1eb7` 通过有备份、可回滚、可读回的流程对齐到 GitHub `main` 的 `00dc543`，并补齐完整 Tango 套件与数据库恢复/迁移回滚证据。
