# AR设备租赁 API

独立的 Node.js 24 / TypeScript / Express 5 后端，为原生微信小程序 **AR设备租赁**（`wx03dbf50c15cac06f`）提供登录、设备、租赁、微信支付与退款接口。使用全新 MySQL 8.4 数据库，所有业务表以 `ar_` 开头，不连接旧 `wechat` 服务或旧数据库，也不需要 Redis。

公开 API 目标为 `https://d.4mr.cn/api/v2`。设备二维码继续使用 `https://c.4mr.cn/d?uuid=UUID&type=TYPE`；扫码入口与 API 域名分别配置。前端源码在 [ar-device-rental-mp](https://github.com/42task/ar-device-rental-mp)。

## 部署

使用 [Portainer 部署步骤](docs/portainer.md) 在 `port.f.01xr.com` 的目标 Docker Standalone 环境自行部署，Stack 文件为 [compose.portainer.yml](compose.portainer.yml)。它包含独立 MySQL、持久卷及 API；数据库仅加入内部网络，不发布宿主机端口。API 通过现有 Traefik 网络提供 `d.4mr.cn` 的 HTTPS 服务。

[.env.example](.env.example) 只含占位配置，不包含可用密钥。JWT、微信 AppSecret、商户私钥和平台公钥可通过只读文件提供。首次启动显式执行迁移，再启动应用；应用自身不会静默迁移旧数据库或导入旧用户。

`WECHAT_PAY_ENABLED=0` 默认为关闭支付。配置真实 AppSecret 后，可以测试微信登录、UUID 识别、设备登记、费用设置与角色管理；支付按钮保持关闭，不会生成模拟的成功支付或租赁。开通真实支付须完成商户与新 AppID 的关联，并配置支付密钥、验签公钥及回调地址。

仓库提供部署文件和 CI，不表示服务已经部署，也不表示真实扣款、退款已验证。镜像发布后仍需部署管理员在 Portainer 更新 Stack 并验收。

## 本地运行

需要 Node.js 24 和全新的专用 MySQL 数据库。

```sh
npm ci
cp .env.example .env
# 按 docs/portainer.md 配置专用数据库、JWT 和 AppSecret；本机路径不能使用容器路径。
npm run build
npm run migrate
npm start
```

本机数据库应使用 `MYSQL_HOST=127.0.0.1` 及实际端口；从文件加载密钥时，`*_PATH` 也须改为本机文件路径。`RENTAL_API_IMAGE`、`TRAEFIK_*`、`RENTAL_SECRETS_DIR` 和 `MYSQL_ROOT_PASSWORD` 由部署文件使用，不是应用连接旧数据库的入口。

首次小程序登录会创建普通用户。部署管理员在受控控制台执行以下命令，先核对账号，再显式初始化首个 root：

```sh
npm run admin -- list-users
npm run admin -- bootstrap-root --user-id 123
```

`123` 只是示例，应替换为上一步核对的真实新用户 ID。已有 root 时，初始化命令不会继续创建 root。后续 manager 授权通过 root 管理界面完成。

## 构建与校验

```sh
npm test
npm run build
```

MySQL 集成测试另外使用隔离的本机测试实例，要求 `MYSQL_HOST=127.0.0.1` 或 `localhost`、`MYSQL_DATABASE=ar_rental_test`，以及可以创建、删除随机测试库的专用测试账号。不要把生产连接配置用于测试。

```sh
npm run test:integration
```

CI 在 `main`、`develop`、`publish` 三个分支运行测试、TypeScript 构建及 MySQL 并发测试。验证通过后，构建 Linux amd64 镜像并推送到腾讯云香港镜像仓库 `hkccr.ccs.tencentyun.com/gdgeek/ar-device-rental-api`。沿用参考 CI 已验证的单架构 Docker schema2 格式，关闭 provenance/SBOM 附加清单。

| Git 分支 | 镜像标签 |
| --- | --- |
| `main` | `main` |
| `develop` | `develop` |
| `publish` | `publish`、`latest` |

仅发布上述四个标签，`latest` 只由 `publish` 更新。拉取请求只校验，不登录镜像仓库或推送镜像；手动运行也仅允许这三个分支发布。每个分支的工作流串行执行，发布前核对远端分支提交。发布后重新查询每个远端标签的 digest，并拉取不可变镜像核对 OCI revision。镜像保留 `/health` 的 `gitCommit`，Actions 摘要记录镜像 digest，部署与回滚使用 `镜像仓库@sha256:...` 固定版本。

在本仓库的 **Settings → Secrets and variables → Actions** 配置 `TENCENT_DOCKER_USERNAME` 和 `TENCENT_DOCKER_PASSWORD`，账号须有香港目标镜像仓库的推送权限。参考仓库的 Secrets 不会自动共享给本仓库；凭据缺失时发布任务会明确失败。不要把真实凭据写入源码、镜像或聊天记录。

Portainer 单独配置同一香港 registry 的拉取凭据；默认使用 `publish` 标签。CI 负责测试和镜像发布，运行服务仍由 Portainer 部署并核对健康检查，详见 [部署文档](docs/portainer.md)。CI 无需生产数据库或微信支付密钥。

## 接口

| 入口 | 用途 |
| --- | --- |
| `GET /health` | 数据库及迁移就绪状态、构建 `gitCommit` |
| `POST /api/v2/rental/auth/login` | 微信 `code` 换取本服务身份令牌 |
| `POST /api/v2/rental/auth/refresh` | 刷新身份令牌 |
| `/api/v2/rental/devices` | 设备识别、登记及费用配置 |
| `/api/v2/rentals` | 租赁记录、支付、结束及退款查询 |
| `/api/v2/rental/admin` | 管理员设备列表与 root 身份管理 |
| `POST /api/v2/rental/payment-notify` | 微信支付通知 |
| `POST /api/v2/rental/refund-notify` | 微信退款通知 |

金额均使用整数分；支付与退款状态以经过服务端校验的微信结果为准。配置不完整时不会提供支付就绪状态。业务写入、设备占用与结算由数据库事务、唯一约束及幂等标识保护。

## 网页后台扫码登录

网页管理后台由独立的 `42task/ar-device-rental-admin` 仓库部署，入口保持 `https://d.4mr.cn/admin/`。本服务提供同源 `/api/v2/rental/admin/auth` 扫码会话、管理员总览及全量订单查询；不包含前端静态文件。部署及联调要求见 [后台登录说明](docs/admin.md)。
