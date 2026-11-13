# 在 Portainer 部署独立 AR 租赁服务

目标：在 `port.f.01xr.com` 的 Docker 环境运行独立 API 与全新 MySQL，域名为 `d.4mr.cn`。以下步骤由部署管理员执行；代码仓库和 CI 不会登录或更新 Portainer。

## 1. 确认环境与镜像

本 Stack 使用 **Docker Standalone / Docker Compose**，不适用于直接作为 Swarm Stack 部署。若 Portainer 环境为 Swarm，需要先按该环境调整 secrets、网络、调度与 Traefik 服务标签。

确认 `d.4mr.cn` 的 DNS 指向现有 HTTPS 入口，Traefik 能读取目标环境的容器标签。确认该 Traefik 实际加入的外部 Docker 网络名；默认示例为 `proxy`，可通过 `TRAEFIK_NETWORK` 覆盖。HTTPS entrypoint 默认 `websecure`，使用 `TRAEFIK_ENTRYPOINT` 对齐现有配置。

Stack 设置 `tls=true`，但没有猜测平台的证书解析器名称：若现有 entrypoint 已配置默认证书或默认 resolver，可沿用它；否则由管理员在 app 的 labels 添加以下配置，并替换成平台已有的真实 resolver 名称：

```yaml
- traefik.http.routers.ar-device-rental-api.tls.certresolver=EXISTING_RESOLVER_NAME
```

不要同时创建另一个相同 Host 规则的路由；Traefik 转发目标为 app 的容器端口 `8080`，不需要发布数据库或 API 的宿主机端口。

Stack 明确设置 `TRUST_PROXY=1`，仅适用于这里已知的单跳 Traefik 拓扑：app 没有发布宿主机端口，外部请求由 Traefik 转发，以客户端 IP 正确限流。不要未经调整就用于直接暴露 app 或增加其他代理层的环境；同一外部 Docker 网络也应仅连接可信服务。本机无反向代理运行时设置 `TRUST_PROXY=0`。

将后端提交推送到 `42task/ar-device-rental-api` 的 `main` 后，查看 GitHub Actions 的 verify / image 结果。镜像标签为：

```text
ghcr.io/42task/ar-device-rental-api:main
ghcr.io/42task/ar-device-rental-api:sha-完整40位提交号
```

正式部署优先填写经过验证的 `sha-...` 或镜像 digest，方便确认和回滚。`main` 随后续发布变化。

在 Portainer 的 Registries 中添加 `ghcr.io`，填写有包读取权限的 GitHub 用户名与 PAT classic（至少 `read:packages`，如组织要求则完成 SSO 授权）。凭据只保存到 Portainer 的 registry 配置，不写入 Git、Stack YAML 或镜像。首次 GHCR 发布默认私有，检查包是否关联正确仓库以及组织是否允许访问。详见 [GitHub 的 GHCR 认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 2. 准备独立配置与只读密钥

在 **Docker 宿主机**创建专用目录；远程 Portainer 不会自动读取操作电脑上的文件。示例镜像的运行用户 `node` UID/GID 为 `1000:1000`；若平台启用了 user namespace/rootless 映射，按实际映射调整所有者。

```sh
sudo install -d -m 0750 -o 1000 -g 1000 /srv/ar-device-rental/secrets
sudo sh -c 'umask 077; openssl rand -hex 32 > /srv/ar-device-rental/secrets/jwt-secret'
sudo chown 1000:1000 /srv/ar-device-rental/secrets/jwt-secret
sudo chmod 0400 /srv/ar-device-rental/secrets/jwt-secret
sudoedit /srv/ar-device-rental/secrets/wechat-app-secret
sudo chown 1000:1000 /srv/ar-device-rental/secrets/wechat-app-secret
sudo chmod 0400 /srv/ar-device-rental/secrets/wechat-app-secret
```

在 `wechat-app-secret` 中写入 **AR设备租赁** 的真实 AppSecret。不要将 JWT、AppSecret、商户私钥或 Portainer registry 凭据粘贴到仓库或聊天记录。目录仅授权管理员与容器用户读取，不要为了容器访问而设置全局可读权限。Stack 将该目录只读挂载到 `/run/secrets`。

在 Portainer Stack 的环境变量区域，按 [.env.example](../.env.example) 填写值。不要把占位密码直接用于部署。可在受控的密码管理器中生成并保存两个不同的随机 MySQL 密码。

| 变量 | 初次非支付部署的值 |
| --- | --- |
| `RENTAL_API_IMAGE` | 已验证的 GHCR `sha-...` 镜像 |
| `RENTAL_SECRETS_DIR` | `/srv/ar-device-rental/secrets`，宿主机真实绝对路径 |
| `TRAEFIK_NETWORK` / `TRAEFIK_ENTRYPOINT` | 平台已有网络 / HTTPS entrypoint |
| `PUBLIC_ORIGIN` | `https://d.4mr.cn` |
| `MYSQL_DATABASE` | `ar_device_rental`，全新库 |
| `MYSQL_USER` | `ar_rental`，仅供本服务使用 |
| `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | 两个不同的随机密码 |
| `JWT_SECRET_PATH` | `/run/secrets/jwt-secret` |
| `WECHAT_APP_ID` | `wx03dbf50c15cac06f`（Stack 已固定） |
| `WECHAT_APP_SECRET_PATH` | `/run/secrets/wechat-app-secret` |
| `WECHAT_PAY_ENABLED` | `0` |
| `RENTAL_CALLBACK_BASE_URL` | `https://d.4mr.cn/api/v2/rental` |

`JWT_SECRET` 与 `WECHAT_APP_SECRET` 留空时使用对应文件；JWT 内容至少32字节。除非明确改用内联值，不要清空必需的文件配置。支付尚未开通时，其余 `WECHAT_PAY_*` 密钥字段留空。

数据库服务固定为 Stack 内部的 `mysql:3306`。不要把旧服务数据库地址、账号或用户表配置进来。MySQL 创建独立命名卷保存数据，应用账号只在新库获得权限；root 密码仅供数据库管理，API 不使用 root。

## 3. 创建 Stack 并验证服务

在目标环境新建独立 Stack，例如 `ar-device-rental`，粘贴 [compose.portainer.yml](../compose.portainer.yml)，填写上述环境变量，选择已经配置好的私有 registry，然后部署。

启动顺序为 MySQL 健康检查 → `npm run migrate` → API。迁移只接受本项目的新库/受支持版本，创建 `ar_` 表并记录版本；不会迁移旧系统。迁移失败时 app 不启动，应检查日志中的安全错误提示、连接配置及所选数据库，不要通过删除卷或关闭校验强行继续。Compose 的健康依赖机制见 [Docker 官方说明](https://docs.docker.com/compose/how-tos/startup-order/)。

MySQL 不映射外网端口，只加入 `internal` 网络；app 同时加入内部网络和已有 Traefik 网络。app 以非 root 用户运行、根文件系统只读，临时文件写入内存中的 `/tmp`。

在 Portainer 查看两个容器 health 状态，检查 app 日志未输出密钥，再从外网访问：

```sh
curl --fail --silent --show-error https://d.4mr.cn/health
```

应返回健康状态及所部署的 `gitCommit`；以实际返回为验收依据。`503` 表示应用健康检查未通过，`404` 通常说明路由未指向这个服务或镜像/请求路径错误，`502` 则先检查 Traefik 网络和 app 容器是否就绪。TLS 失败应检查域名证书链和平台证书配置。

小程序公众平台中，将 **request 合法域名**配置为 `https://d.4mr.cn`，保持开发工具 `urlCheck:true`，刷新项目配置并重新编译。**普通链接二维码规则仍为** `https://c.4mr.cn/d` → `pages/device/index`。接口域名与二维码规则不是同一配置。

支付关闭时验收：扫码先显示 UUID/type；真实微信登录成功后，普通用户能看到设备状态；管理员可登记、配置设备。AppSecret 未配置或后台登录失败时，UUID 仍可显示，但不能完成需要身份的设备操作。

## 4. 初始化首个 root

先让目标管理员在新小程序中真实微信登录一次，生成新数据库中的普通用户。进入 app 容器的 Portainer Console，执行：

```sh
npm run admin -- list-users
npm run admin -- bootstrap-root --user-id 123
```

将 `123` 替换为列表中核对后的本人 ID；在共享机器或多人同时首登时先完成身份核对。初始化是显式管理操作，已有 root 时命令会拒绝再创建。不要猜测用户 ID，也不要从小程序端开放自助升级。

管理员退出页面重新进入或刷新后获取最新身份，再从 root 的用户管理入口授权 manager。新数据库不继承旧系统的角色、设备与订单。

## 5. 后续开通支付与退款

完成新 AppID 的微信支付商户关联与所需权限后，再提供以下配置并更新 Stack：

- `WECHAT_PAY_ENABLED=1`，以及真实 `WECHAT_PAY_MCH_ID`、`WECHAT_PAY_SERIAL_NO`。
- `WECHAT_PAY_PRIVATE_KEY_PATH=/run/secrets/wechat-pay-private.pem`，为商户私钥。
- `WECHAT_PAY_API_V3_KEY_PATH=/run/secrets/wechat-pay-api-v3-key`，或使用对应内联值。
- `WECHAT_PAY_PLATFORM_SERIAL_NO` 为平台证书序列号或 `PUB_KEY_ID_*`；`WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH=/run/secrets/wechat-pay-platform.pem` 为对应可信公钥。轮换期间可按客户端支持的 JSON 映射配置 `WECHAT_PAY_PLATFORM_KEYS_JSON`。
- `RENTAL_CALLBACK_BASE_URL=https://d.4mr.cn/api/v2/rental`。

支付通知完整 URL 为 `https://d.4mr.cn/api/v2/rental/payment-notify`，退款通知为 `https://d.4mr.cn/api/v2/rental/refund-notify`。保持这些接口可由微信服务访问，不加浏览器登录页；后台自行验签并校验业务金额、AppID、商户和订单。

配置后先检查服务返回的 `paymentReady`，再在真机上做经授权的真实交易验收：付款取消、付款成功后服务端同步、归还退押金、全额退款、异常退款查询及设备恢复。仓库测试仅模拟支付提供方，不代表这些真实金融操作已通过。不通过修改数据库或前端标记来模拟到账。

## 6. 更新、备份与故障定位

更新前备份独立 MySQL 数据，并记录当前镜像 digest/完整提交号。不要删除 `mysql_data` 卷；MySQL 的初始化环境变量只在新卷首次启动时生效，修改 Stack 密码不会自动修改已有数据库账号密码。按 MySQL 正规流程轮换后同步应用配置。

后续更新使用经 CI 验证的镜像版本，重新部署后核对 `/health` 的 `gitCommit`。应用会在启动阶段执行迁移；旧镜像是否可回滚应结合数据库版本判断，不应直接覆盖或恢复旧库到新服务。

| 现象 | 优先检查 |
| --- | --- |
| 私有镜像拉取失败 | Portainer GHCR 凭据、包访问权限、组织 SSO |
| app 循环重启 | MySQL 就绪、迁移错误、JWT 文件权限、环境变量 |
| 服务器显示健康但手机请求失败 | 新 App 的 request 域名、HTTPS证书及真机原始网络错误 |
| 登录失败 | 这个新 AppID 的 AppSecret、微信登录 code、服务端出站访问微信能力 |
| 能识别 UUID 但无设备状态 | 登录是否成功、是否已部署正确 API、设备是否已登记 |
| 无法发起支付 | 支付开关、商户关联、商户密钥/平台公钥、后台 paymentReady |

诊断时只分享脱敏的错误码、状态码、路径和构建提交号；不分享 Authorization、登录 code、完整回调报文或数据库内容。
