# Tango Done&Go 部署指南

> 本文描述当前 Done&Go 产品的运行与部署：静态网页模块 + Node 服务 `scripts/serve-tango.mjs`。2026-09 的 Mac + Cloudflare Tunnel 公网部署资料统一保留在文末「历史部署资料」，仅作追溯，不构成当前上线或验证依据。

## 当前产品入口

当前唯一产品入口是本地优先网页，必须经服务访问；双击文件打开无法使用登录、AI 与协作：

    http://localhost:5207/#today

页面提供 7 个 hash 路由：`#today`、`#line`、`#review`、`#agreements`、`#settings`、`#assistant`、`#users`。

## 运行要求

- Node.js >= 22.22（交付镜像基于 `node:22.22`）。
- 登录认证、AI 对话与小组协作依赖服务端；`scripts/serve-tango.mjs` 是当前唯一服务入口。
- 仓库中的 React/Vite、`src/` 与 `server/start.mjs` 路线是历史实验，不属于当前部署对象。

## 本地运行

```sh
npm start        # 等价 npm run start:web，默认 http://localhost:5207，端口由 TANGO_PORT 调整
npm run dev:auth # 本地预览启动器，默认 http://127.0.0.1:5221
```

`npm start` 默认启用真实账号门禁：未登录只能看到注册/登录入口，业务 API、AI 与协作接口同样要求会话。注册和登录使用同一个账号输入框，支持邮箱或中国大陆手机号加 8–15 位密码，不需要验证码或邮件通道。

`npm run dev:auth` 是本地内测启动器：默认启用真实账号注册/登录，账号与协作数据保存在 `.tango-donego/local-auth-dev/collaboration.sqlite`；设置 `TANGO_DEMO_MODE=1` 才会恢复临时访客预览。验证码发送通道默认 console，仅服务端历史验证码/重置接口，当前注册与登录表单不使用它。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `TANGO_DEMO_MODE` | `1`：演示/访客模式，自动访客会话、注册隐藏、协作库使用内存数据库（重启清空）。未设置或 `0`：真实账号门禁。`npm start` 与 `npm run dev:auth` 默认真实账号门禁。 |
| `TANGO_AUTH_SECRET` | 会话签名密钥，至少 32 字节并持久保存；生产就绪检查要求显式提供。 |
| `TANGO_COLLAB_DB` | 账号/协作 SQLite 数据库路径。`npm start` 默认 `<项目>/.tango-donego/collaboration.sqlite`；`npm run dev:auth` 默认 `<项目>/.tango-donego/local-auth-dev/collaboration.sqlite`，接受绝对路径或 `:memory:`。生产必须指向持久目录。 |
| `ADMIN_EMAILS` | 管理员白名单（逗号分隔），示例 `ADMIN_EMAILS=admin@example.com`。匹配邮箱在注册完成那一刻获得管理员角色，可访问 `#users` 用户管理控制台与全局模型配置；白名单不追溯既有账号。 |

生产就绪检查 `npm run verify:production` 逐项要求：`TANGO_DEMO_MODE` 非 `1`、有效会话配置、`TANGO_PUBLIC_ORIGIN`（实际 HTTPS 域名）、`NODE_ENV=production`、`TANGO_AUTH_SECRET`（至少 32 字节）、`TANGO_COLLAB_DB` 持久路径（非 `:memory:`）以及安全会话 Cookie。邮箱通道仅在使用历史验证码或重置接口时另行配置；任何一项缺失即 `configurationReady=false`。

## Docker 示例

默认 `Dockerfile` 只包含当前网页与服务：`node:22.22` 基础镜像，镜像内固定 `TANGO_DEMO_MODE=0`（真实账号门禁），数据卷 `/app/.tango-donego`。

```sh
docker build -t tango-donego-local .
docker run --rm -p 127.0.0.1:5207:5207 tango-donego-local
```

注意：该示例启用真实账号门禁，但没有提供持久化数据库；需要将 `TANGO_COLLAB_DB` 指向挂载卷。账号注册/登录不需要邮件通道。容器构建与运行在当前环境未实测，验证状态为 UNKNOWN。

## 通用生产部署要点

- 目标主机安装 Node >= 22.22；`npm ci --omit=dev --ignore-scripts` 后先运行 `npm run verify:production`，通过后再 `npm start`。
- 生产模式需显式提供 `NODE_ENV=production`、`TANGO_PUBLIC_ORIGIN`、`TANGO_AUTH_SECRET` 与 `TANGO_COLLAB_DB`；密钥只保存在部署环境，不写入仓库、前端构建或日志。
- 公网发布所需的反向代理、TLS、进程守护、持久存储、备份恢复与压力测试需在目标环境另行验收。

## 历史部署资料（2026-09，Mac + Cloudflare Tunnel，仅供追溯）

> 以下内容为 2026-09 的历史部署记录，不代表当前可用性，也不是当前 Done&Go 的上线证明。隧道 ID、凭据路径等敏感信息已用占位符替代。

当时的公网形态：应用运行在一台 Mac 的 loopback `:5220`（`TANGO_PUBLIC_ORIGIN=https://tango-donego.udify.fun`、`TANGO_TRUST_CLOUDFLARE=1`、`EMAIL_TRANSPORT=resend`，密钥经 `.tango-donego/env` 的 `TANGO_SENDER_*` 变量映射）；公网 DNS 指向专用 Cloudflare Tunnel，不公开本机端口。本地另有 `:5201` console 发信的验收实例。

| 项目 | 历史值 |
| --- | --- |
| Tunnel 名称 | `tango-donego` |
| Tunnel UUID | `<tunnel-uuid>`（占位） |
| 公网域名 | `tango-donego.udify.fun` |
| Origin | `http://127.0.0.1:5220` |
| 配置 | `deploy/cloudflared.yml` |
| 凭据 | `<用户主目录>/.cloudflared/<tunnel-uuid>.json`，不在仓库内 |
| Metrics | `http://127.0.0.1:20246/metrics` |

当时的启动与校验命令（5220 为该部署专用端口，与当前 5207 入口无关）：

```sh
npm run build
TANGO_PORT=5220 npm start
cloudflared tunnel --config deploy/cloudflared.yml ingress validate
cloudflared tunnel --config deploy/cloudflared.yml ingress rule https://tango-donego.udify.fun/
cloudflared tunnel --config deploy/cloudflared.yml --no-autoupdate run
```

应用与 connector 曾由 launchd 专用服务托管（`com.udify.tango-donego-app`、`com.udify.tango-donego-connector`，KeepAlive + RunAtLoad），日常启停依赖桌面 `静驻启动.command`。同机还有承载其他项目的共享隧道；该部署使用独立 UUID、配置、端口和进程，不触碰共享 cloudflared 配置，也不使用无专用配置的 `cloudflared service install`。手动前台调试前先 `launchctl bootout` 停用 connector 服务，避免争用 metrics 端口 20246。

当时的运维结论：撤回公网访问即停止专用 connector，保留 DNS 与凭据便于恢复，不删除用户数据；隧道凭据与邮件密钥不写入前端构建、仓库、截图或运行日志；使用 info 日志，不开记录请求头的 debug 日志。配置与命令依据 Cloudflare 本地管理隧道文档与 Ingress 配置文档。
