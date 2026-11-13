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

CI 会运行测试、TypeScript 构建及 MySQL 并发测试。`main` 分支验证通过后，使用仓库的 `GITHUB_TOKEN` 发布 `ghcr.io/42task/ar-device-rental-api:main` 和 `:sha-完整提交号` 两个标签，构建 Linux amd64 / arm64 镜像。工作流不部署 Portainer，也不需要 TCR 或生产数据库 secrets。

GHCR 首次发布默认是私有包；管理员仍需检查组织包权限。Portainer 拉取私有镜像需另配有该包读取权限的账号及 `read:packages` 凭据，不能使用工作流中短期有效的 `GITHUB_TOKEN`。配置方法见 [部署文档](docs/portainer.md)，权限依据见 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

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
