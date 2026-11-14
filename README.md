# AR设备租赁 API

独立的 Node.js 24 / TypeScript / Express 5 后端，为原生微信小程序 **AR设备租赁**（`wx03dbf50c15cac06f`）提供登录、设备、租赁、微信支付与退款接口。使用全新 MySQL 8.4 数据库，所有业务表以 `ar_` 开头，不连接旧 `wechat` 服务或旧数据库，也不需要 Redis。

公开 API 目标为 `https://d.4mr.cn/api/v2`。设备二维码继续使用 `https://d.4mr.cn/d?i=UUID&t=rs2`；扫码入口与 API 域名分别配置。小程序源码位于独立仓库 [ar-device-rental-mp](https://github.com/42task/ar-device-rental-mp)。多商户接入、归属、设备和人员调拨、密钥轮换见[多商户运行说明](docs/multi-merchant.md)。

## 部署

使用 [Portainer 部署步骤](docs/portainer.md) 在 `port.f.01xr.com` 的目标 Docker Standalone 环境自行部署，Stack 文件为 [compose.portainer.yml](compose.portainer.yml)。它包含独立 MySQL、持久卷及 API；数据库仅加入内部网络，不发布宿主机端口。API 通过现有 Traefik 网络提供 `d.4mr.cn` 的 HTTPS 服务。

[.env.example](.env.example) 只含占位配置，不包含可用密钥。JWT、微信 AppSecret、商户私钥和平台公钥可通过只读文件提供。首次启动显式执行迁移，再启动应用；应用自身不会静默迁移旧数据库或导入旧用户。

`WECHAT_PAY_ENABLED=0` 默认为关闭支付。配置真实 AppSecret 后，可以测试微信登录、UUID 识别、设备登记、费用设置与角色管理；支付按钮保持关闭，不会生成模拟的成功支付或租赁。开通真实支付须完成商户与新 AppID 的关联，并配置支付密钥、验签公钥及回调地址。

仓库提供部署文件和 CI，不表示服务已经部署，也不表示真实扣款、退款已验证。镜像发布后仍需部署管理员在 Portainer 更新 Stack 并验收。

## 本地运行

需要 Node.js 24 和全新的专用 MySQL 数据库。

```sh
npm ci --ignore-scripts
cp .env.local.example .env
# 按 docs/portainer.md 配置本机专用数据库、JWT 和 AppSecret。
npm run build
npm run migrate
npm start
```

本文中的命令均在本仓库根目录执行；数据库迁移文件和 `.env` 从当前目录读取。

本机数据库应使用 `MYSQL_HOST=127.0.0.1` 及实际端口；从文件加载密钥时，`*_PATH` 也须改为本机文件路径。`RENTAL_API_IMAGE`、`TRAEFIK_*`、`RENTAL_SECRETS_DIR` 和 `MYSQL_ROOT_PASSWORD` 由部署文件使用，不是应用连接旧数据库的入口。

首次小程序登录会创建普通用户。首个 root 可通过环境变量 `ROOT_PHONE` 初始化：在 Portainer Stack 的环境变量区域填写目标管理员的手机号，点击 **Update the stack** 重新部署；本机则在 `.env` 中设置并重启 API。支持 `+86 <你的11位手机号>` 或 `<你的11位手机号>`，会忽略空格。Portainer 的值直接填号码；`.env` 中带空格的值须用双引号包围。示例中的占位文字必须替换为真实号码，真实配置不要提交 Git。

目标账号须先在当前小程序完成微信原生手机号授权。服务端只核对当前 AppID 的已验证绑定；匹配配置且系统尚无 root 时，在之后的登录、令牌刷新或身份校验中自动初始化首个 root，并记录 `env-root-bootstrap` 审计。旧 `tel` 字段、手填号码或仅完成微信登录都不能取得该权限。

`ROOT_PHONE` 留空时关闭自动初始化。已有 root 时不会新增、替换或撤销 root，修改或清空该变量也不会迁移既有权限；身份按 `root > adminer > manager > user` 继承，adminer 可管理其他 user、manager，仅 root 可管理 adminer；数据库保证全库最多一个 root。非空号码配置无效时，登录与身份校验返回安全的 503 配置错误，不回显号码。

也可保留受控控制台的人工初始化方式，先用已验证手机号核对账号：

```sh
npm run admin -- find-user-by-phone --phone-stdin
npm run admin -- bootstrap-root --phone-stdin
```

号码从标准输入读取，TTY 输入不回显。人工初始化同样要求系统没有 root，并再次核对微信已验证手机号，不支持按裸用户ID初始化。

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
| `/api/v2/rental/admin` | 管理员设备列表与 adminer/root 分级身份管理 |
| `/api/v2/rental/admin/auth` | 网页扫码挑战、小程序确认及独立浏览器会话 |
| `GET /api/v2/rental/admin/overview` | 管理总览 |
| `GET /api/v2/rental/admin/orders` | 当前 AppID 下所有用户的订单搜索与分页 |
| `GET /admin/` | 同源网页管理后台，见 [使用说明](docs/admin.md) |
| `POST /api/v2/rental/payment-notify` | 默认商户原配置的微信支付通知 |
| `POST /api/v2/rental/payment-notify/:configId` | 按原支付配置处理通知 |
| `POST /api/v2/rental/refund-notify` | 默认商户原配置的微信退款通知 |
| `POST /api/v2/rental/refund-notify/:configId` | 按原支付配置处理退款通知 |
| `/api/v2/rental/admin/merchants` | root 管理商户与独立微信配置 |

金额均使用整数分；支付与退款状态以经过服务端校验的微信结果为准。配置不完整时不会提供支付就绪状态。业务写入、设备占用与结算由数据库事务、唯一约束及幂等标识保护。

## 设备型号

前端登记使用 `Rokid Studio`、`Rokid Studio2`、`Rokid Studio3` 三个选项，默认 `Rokid Studio2`。数据库 `device_type` 保持字符串字段；已知型号和二维码短码 `rs`、`rs2`、`rs3` 统一为上述规范名称，历史其他类型仍可读取。schema 5 只调整新建设备的数据库默认值，不批量重写旧设备记录。
