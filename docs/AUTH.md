# Tango Done&Go 多用户身份模块

> **历史资料边界（2026-10-16）**：本文保留 React/Node 多用户身份模块方案，供追溯与后续研究使用。它不定义当前本地优先网页的产品入口、当前实现或上线标准。当前唯一产品基准是 http://localhost:5207/#today，主架构以 DONEGO-CANONICAL-ARCHITECTURE-2026-10-16.md 为准。

本模块依据 `mail2profile` 的邮箱验证码注册、密码登录、会话恢复、改密找回及管理员用户管理契约，接入现有 Node HTTP 服务。它不依赖 Python 服务，也不更换现有 React 信息架构。

## 身份与数据边界

- 注册必须验证发送到该邮箱的六位验证码。重发冷却默认 60 秒，验证码 10 分钟有效、最多尝试 5 次；重发使前码失效，成功使用后不可重放。
- 密码为 12 字符以上、最多 256 UTF-8 字节。使用随机盐和 `scrypt(N=32768,r=8,p=1)`，没有弱散列兜底。
- JWT 使用 HS256、固定 issuer/audience，并将会话 ID 存在 SQLite。浏览器只持有 `HttpOnly; SameSite=Lax` cookie，公网额外使用 `Secure`，响应不回显 bearer token。退出、改密、重置密码、账号停用和删除均撤销相应会话。
- 每次认证检查数据库中的账号存续和启用状态。注册只按配置的 `ADMIN_EMAILS` 白名单授予管理员角色；个人资料更新不能修改角色。
- SQLite 位于主机私有目录，文件权限 `0600`。验证码保存为带服务密钥的 HMAC，邮件地址和账号资料保留在本地主机。验证码及密码不写入版本库。
- 用户身份模块只管理账号。宿主业务读写必须从认证后的 `user.id` 获取数据命名空间，不接受客户端自行指定另一用户 ID；不能把已有公共浏览器存储自动归属到新账号。浏览器侧外观存储已按所有者隔离（登录用户追加 `:u:<id>` 键并在认证恢复时刷新），双账号切换闭环已在公网域名实测；其余宿主数据命名空间的隔离随各自模块验收。

## 服务接线

`server/auth/config.mjs` 导出 `readAuthConfig(env)`；`server/auth/service.mjs` 导出 `createAuthService({databaseFile,config,sendEmail?,now?,resourceHooks?})`。

服务返回 `handle(req,res,body)`、`authenticate(req)`、`requireAdmin(req)` 和 `close()`。`handle` 处理 `/api/auth/*`、`/api/admin/*`，返回布尔值表示是否接管。宿主应先完成有界 JSON 解析，再调用它；不要先使用旧的仅允许 loopback 的入口拦截已配置的公网域名。认证失败抛出含 `status/code/message` 的 `AuthError`；路由响应为 `{error,detail:{code,message}}`。

所有 API 客户端需要 `x-tango-client: tango-settings/1`。模块自己校验 Host 与 Origin：公网必须为 `TANGO_PUBLIC_ORIGIN`，本地开发允许 loopback；公网修改请求不能省略 Origin。设置 LLM 端点、测试端点、撤销设置等管理操作必须调用 `requireAdmin`，用户发起草稿生成调用 `authenticate`。

资源钩子为 `countUserResources(userId)` 和 `onUserDeleted(userId)`，允许异步。删除钩子失败时保留用户，不回报删除成功。钩子应幂等；若业务资源位于外部存储，钩子和账号数据库之间不是跨库事务。管理页面删除操作应先给用户明确确认。

## 接口

| 方法与路径 | 输入 | 成功响应 |
|---|---|---|
| GET `/api/auth/status` | 无 | `enabled,emailDelivery,registrationEnabled,passwordMinLength` |
| POST `/api/auth/send-code` | `email,purpose:register/reset` | `status:sent`；仅本地 console 可带 `devCode` |
| POST `/api/auth/register` | `email,code,password,displayName?` | `user`，设置 cookie |
| POST `/api/auth/login` | `email,password` | `user`，设置 cookie |
| POST `/api/auth/logout` | 无 | `status:ok`，清除 cookie |
| POST `/api/auth/reset-password` | `email,code,newPassword` | `status:ok`，撤销所有旧会话 |
| GET `/api/auth/me` | cookie | `user` |
| PUT `/api/auth/me` | `displayName?,settings?` | `user` |
| PUT `/api/auth/me/password` | `oldPassword,newPassword` | `status:ok`，替换 cookie |
| GET `/api/admin/users?limit=100` | 管理员 cookie | `users`，最多 500 条 |
| PATCH `/api/admin/users/:id` | `isActive` | `user` |
| DELETE `/api/admin/users/:id` | 管理员 cookie | `status:deleted` |

`user` 包含 `id,email,displayName,createdAt,role,emailVerified,isActive,settings`；管理员列表另含 `resourceCount`。发送验证码对已经注册的注册邮箱、不存在的重置邮箱返回相同的 `sent` 状态但不发送邮件，避免用该接口枚举账号。登录不存在账号与错误密码使用相同响应并执行同等密码派生步骤。

## 配置

| 配置 | 说明 |
|---|---|
| `TANGO_AUTH_SECRET` / `JWT_SECRET` | 至少 32 字节；必需、运行时注入，无开发默认密钥 |
| `TANGO_PUBLIC_ORIGIN` | 例如 `https://tango-donego.udify.fun`，必须是精确 HTTPS origin |
| `ADMIN_EMAILS` | 逗号分隔管理员邮箱白名单；只影响注册时授予角色 |
| `JWT_EXPIRY_HOURS` | 默认 72，允许 1–720 |
| `EMAIL_TRANSPORT` | `disabled`（默认）、`console`、`resend`、`smtp` |
| `CODE_TTL_SECONDS` / `CODE_RESEND_SECONDS` | 默认 600 / 60 |
| `RESEND_API_KEY` + `MAIL_FROM` | Resend 发信密钥与已验证域名发信地址 |
| `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS` + `MAIL_FROM` | SMTP 配置；465 使用 TLS，其他端口强制 STARTTLS |
| `TANGO_TRUST_CLOUDFLARE=1` | 仅信任 loopback 连接传来的 CF-Connecting-IP 用于限流；只在受控隧道入口启用 |

`EMAIL_TRANSPORT=console` 只用于独立本地开发，会在本地响应和日志展示验证码。配置公网 origin 或 `ENV/NODE_ENV=production` 时拒绝 console，不能用它给公网账号伪造邮箱验证。邮件未配置时账号状态接口明确 `registrationEnabled:false`；邮件发送失败返回 503、作废该码，不显示已成功发送。

SMTP 适配器使用 `nodemailer`，Resend 使用 Node fetch。账号模块不读取其他项目的邮件凭据，不自动发出真实邮件。公开注册需要配置真实邮件通道及管理员邮箱后再验证收信。

## 验证记录与边界

`node --test tests/unit/auth-service.test.mjs` 使用独立临时 SQLite 与真实本地 HTTP。覆盖双账号隔离身份、服务重启后会话恢复、退出撤销、验证码耗尽/过期/重发/重放、并发注册、输入校验、改密与找回、管理员权限/启停/删除、伪造 token、Origin/header 拒绝、邮件失败和公网不回显验证码。

测试使用注入邮件收件箱，Resend 适配器测试使用受控 fetch。通过这些测试不等于真实邮箱投递通过，也不等于宿主业务用户数据隔离或公网隧道端到端验收。账号前端交互、真实邮件收信、域名 cookie/HTTPS、账号切换后的所有 18 屏数据和管理权限，需要在内置浏览器或 Ego Lite 中另行验证。

Node 22.22.2 的 `node:sqlite` 会显示 ExperimentalWarning；该运行时警告没有被压制。SQLite 适合此阶段单实例本地部署，扩展多实例时需共同持久化会话、验证码和限流状态。
