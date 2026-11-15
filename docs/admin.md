# 网页管理后台

多商户权限、独立支付配置、root 商户管理与人员设备调拨见[多商户运行说明](multi-merchant.md)。`admin` 仅指管理平台，商户管理员角色为 `adminer`。下方历史部署记录不代表多商户版本已上线。

线上后台为独立 NGINX 容器，与 API、MySQL 放在 `port.f.01xr.com` 的同一个 `ar-device-rental` Stack。前端与 API 同域名，不开放跨域。入口为 `https://d.4mr.cn/admin/`；本工程 API 保留本机开发静态入口 `http://127.0.0.1:8080/admin/`。

前端独立私有仓库为 [42task/ar-device-rental-admin](https://github.com/42task/ar-device-rental-admin)，本机检出位于 `apps/admin`，由父工程忽略，不是子模块。线上配套 API 使用 [42task/ar-device-rental-api](https://github.com/42task/ar-device-rental-api)。前端 CI 仿照真实后端，发布 `hkccr.ccs.tencentyun.com/gdgeek/ar-device-rental-admin`；CI 不自动修改 Portainer。

## 首版功能

- 总览：设备可租、占用、租赁、结算和停租数量，以及订单数量、待完成退款数量和支付配置状态。
- 设备：搜索、分页、登记、使用费/押金配置和启停。金额输入单位为元，接口仍使用整数分；保存携带费用版本，冲突时须刷新。
- 订单：查询当前 AppID 下所有用户的订单，支持设备 UUID、名称、订单 ID 和状态筛选；查看支付、退款和租赁时间。首版网页不提供扣款或退款按钮。
- 用户权限：adminer 可查询用户并管理其他 user、manager；仅 root 可管理 adminer。身份变更记录角色审计。完整关系见[四级权限表](roles.md)。

manager、adminer 和 root 可以扫码进入。普通用户只有在微信已验证手机号匹配部署管理员配置的 `ROOT_PHONE`、且系统尚无 root 时，才会在登录或身份刷新时初始化为首个 root；普通扫码和手机号授权本身不授予管理权限。

## 授权管理员与办理归还

1. 被授权人先登录本小程序并完成微信手机号绑定，以便 ROOT 按手机号核对账号。
2. adminer 或 root 登录 `/admin/`，进入「权限管理」，搜索手机号或昵称，打开目标用户的身份管理，选择目标身份、填写原因并核对确认。adminer 只能在其他 user 与 manager 之间切换；root 还可授予或降级 adminer。所有人不能在此修改自己或 root，adminer 也不能修改同级账号。
3. 获授权的管理员刷新小程序身份后，扫描设备二维码，查看当前租赁并点击「管理员确认归还与退款」。管理员确认实物归还、填写原因，再选择「退还押金」或「全额退款」并核对退款金额、保留的使用费后确认提交；退款未确认成功时设备保持结算占用。

| 身份 | 租赁自己的设备 | 确认归还、选择退押金或全额退款 | 在网页授予或撤销管理员 |
| --- | --- | --- | --- |
| 普通用户 `user` | 可以 | 不可以 | 不可以 |
| 设备管理员 `manager` | 可以 | 可以 | 不可以 |
| 系统管理员 `adminer` | 可以 | 可以 | 其他 user、manager |
| 最高管理员 `root` | 可以 | 可以 | 其他 user、manager、adminer |

退款权限按当前账号角色判断。ROOT 或管理员即使也是该订单付款人，仍具有管理权限；使用同一个 ROOT 微信账号体验租赁和归还，会同时看到付款人与管理员操作。验证普通用户无退款权限时，应使用未授予管理权限的另一微信账号。

服务端对小程序 Bearer 令牌和网页 Cookie 会话都在每次请求时读取数据库中的当前角色。撤销后无需等待已有令牌或会话到期，后续管理、结束租赁和退款请求即失去权限；前端按钮即使尚未刷新也不能绕过服务端检查。授予和撤销记录操作者、目标账号、前后角色及原因，网页只显示查询和授权入口，实际归还退款仍在小程序操作。

在 Portainer 的 `ar-device-rental` Stack 环境变量区域设置 `ROOT_PHONE`，然后点击 **Update the stack** 重新部署。支持 `+86 <你的11位手机号>` 或 `<你的11位手机号>`，会忽略空格；占位文字须替换为本人真实号码。Portainer 值直接填号码，只有 `.env` 中带空格的值需要双引号。号码仅由后端配置，不能放入小程序源码或提交 Git。

目标账号先在当前小程序完成微信手机号授权，再刷新首页或重新扫码。服务端核对当前 AppID 的已验证绑定，并在事务中初始化、记录 `env-root-bootstrap` 角色审计。`ROOT_PHONE` 留空时禁用；已有 root 时不会新增、替换或撤销 root，换号或清空变量也不会自动迁移权限。非空配置无效时，登录与身份校验返回安全的 503 配置错误，不回显号码。后续 adminer 由 root 管理，manager 可由 adminer 或 root 管理。

如选择人工初始化，可在受控容器 Console 用已验证手机号核对：

```sh
npm run admin -- find-user-by-phone --phone-stdin
npm run admin -- bootstrap-root --phone-stdin
```

号码从标准输入读取，TTY 输入不回显；人工初始化同样要求系统没有 root 并再次核对微信已验证手机号，不支持按裸用户ID初始化。数据库保证全库最多一个 root，多个旧 root 会阻止升级，不静默降级。

## 微信扫码流程

1. 网页生成 5 分钟有效的登录小程序码和 6 位确认码。
2. 管理员使用微信扫码，进入 `pages/admin/login`。
3. 手机显示网页来源及确认码；本人核对后点击「确认登录」，也可取消。
4. 原浏览器领取 8 小时后台会话，跳转工作台。

二维码只携带随机挑战 ID，不包含网页会话或浏览器兑换凭据。挑战与原浏览器的 HttpOnly Cookie 绑定，一次性兑换由数据库事务串行保护；其他浏览器不能仅凭二维码领取会话。会话使用独立随机令牌，数据库只存摘要；退出会在服务端注销。每次业务请求读取当前用户角色，撤销 manager 后立即失去后台权限。

浏览器和小程序仍各自使用自己的会话，小程序 Bearer 令牌不会传给网页。浏览器写接口校验 `Origin`，正式站 Cookie 为 `HttpOnly; Secure; SameSite=Strict`，不在 localStorage 中保存令牌。

## 部署和联调

后端沿用已有 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`（或密钥文件），无需申请微信开放平台网站应用。还需确认：

- `PUBLIC_ORIGIN=https://d.4mr.cn`，必须是浏览器实际访问的来源，不含尾部 `/` 或路径。浏览器和 API 必须同源。
- 微信后台按实际接口要求配置服务器出口 IP；AppSecret 只放服务端。
- 小程序上传包含 `pages/admin/login` 的新版本。正式扫码默认 `ADMIN_LOGIN_ENV_VERSION=release`，确认页须已正式发布。
- 体验版联调可设 `ADMIN_LOGIN_ENV_VERSION=trial`，开发版可设 `develop`，扫码账号须有相应体验/开发权限。联调结束恢复 `release`。
- 小程序请求地址仍为生产 API；本机页面只能由指向同一后端的受控开发版本配合确认，启动本机后端不会改变小程序请求地址。

当前 schema 版本为 8，包含多商户归属与配置；从 schema 6 升级时仍先执行 schema 7 角色拼写迁移，启动迁移将已有系统管理员角色 `admin` 改为 `adminer`，同步更新用户及角色审计中的前后角色，保留原有权限。需配套发布 API、独立网页后台和小程序，具体见[角色拼写迁移](roles.md#角色拼写迁移)。早期 schema 2 新增了 `ar_admin_login_challenge` 和 `ar_admin_session`；迁移命令仍为：

```sh
npm run build
npm run migrate
npm start
```

Portainer Stack 沿用 API 启动迁移命令。新增 admin 服务只连接已有 `proxy` 网络，监听容器端口 8080，不挂载业务数据或密钥；Traefik 将 `/admin`、`/admin/` 前缀路由给 admin，其他请求仍去原 API。该环境 HTTPS entrypoint 为 `websecure`，证书 resolver 为 `letsencrypt`。前端模板在独立仓库的 `compose.portainer.yml`，更新时沿用既有证书设置。升级后核实 `/health` 的 `schema=ready`，再访问 `/admin/`。旧版本可能不兼容 schema 7 和 `adminer` 角色，回滚时需协调应用与数据库版本。

## 校验

本仓库执行 `npm test` 和 `npm run build`。新增认证测试覆盖角色权限、来源校验、原浏览器绑定、过期、取消、会话注销与一次性兑换；专用 MySQL 集成测试验证并发确认/兑换和多实例共享挑战，不使用真实支付。

```sh
# 按 development.md 设置专用本机测试实例变量后执行
npm run test:integration
```

自动测试不能代替真实微信扫码验收。后端部署、小程序上传、体验版验证和正式发布须分别完成、分别记录。

## 2026-11-13 部署验证记录

- 环境：`https://port.f.01xr.com`，endpoint 2，既有 Stack `ar-device-rental`（ID 27）。新增 `admin`，保留 `app`、`mysql` 和原数据库卷。
- 前端候选：`e580953342c5e702942127187d23771253cbee13`，镜像摘要 `sha256:edb857bc30acaa8c3a0d77b7d552b4da6cff88dca7a5b49fe6585f93e9beb5f6`。[CI](https://github.com/42task/ar-device-rental-admin/actions/runs/43450238535) 通过，`/admin/version.json` 核对一致。
- 后端候选：`9a42adb4c052f8481f265767687c5460d7512b3a`，镜像摘要 `sha256:15065d1f1ee8b9fbe8a6a0f864e3c120d36429f15717d2b8a96fc0cde717766f`。[CI](https://github.com/42task/ar-device-rental-api/actions/runs/43452536881) 通过，`/health` 返回该提交、数据库 up、schema ready、支付 disabled。
- 实机校验：后台 HTML/静态资源可访问；扫码挑战可创建；Cookie 含 HttpOnly/Secure；无 Origin 写请求返回 403，其他浏览器访问挑战返回 401，未授权确认返回 401。未执行扣款、退款或角色授权。
- 已修复部署检查发现的入口版本校验：`main.ts` 与健康检查共用 `SCHEMA_VERSION`。新增真实编译进程启动与 SIGTERM 回归，56 项单测、4 项隔离 MySQL 集成测试通过。
- 微信正式版生成确认页二维码返回 `41030`。小程序确认页尚待上传/发布及真机验证，因此候选停留在 `develop`，尚未推进 `main` / `publish`，不能将当前状态报告为扫码登录已验收。

## 2026-11-14 体验版联调准备

- 用户已授权上传体验版和扫码联调，不提交审核、不正式发布。
- 微信开发者工具 CLI 使用 AppID `wx03dbf50c15cac06f`，从 `apps/miniprogram` 上传 `1.0.1` 成功，包体 87,065 字节；描述为“Admin扫码登录联调：新增手机确认页，仅体验版验证，未提交审核”。上传前 53 项小程序测试和 8 页面上传配置校验通过。
- Portainer 中仅为 API 新增 `ADMIN_LOGIN_ENV_VERSION: trial` 并更新原 Stack；API 镜像仍为 `9a42adb4c052f8481f265767687c5460d7512b3a`，`/health` 正常，支付 disabled。
- 网页已成功显示微信返回的真实体验版登录小程序码。公众平台“设为体验版”及手机扫码确认尚待用户完成，不能将二维码生成成功等同于已登录。
- 自动浏览器访问 `mp.weixin.qq.com` 被站点安全策略直接阻止，未尝试其他浏览器、原始接口或间接方式绕过；设为体验版由用户在公众平台手动操作。
- 微信确认页正式发布前，不应将环境改回 `release`；正式发布后再切回，并分别核实二维码、手机确认和网页会话。`main` / `publish` 仍等待扫码功能验收。

## 2026-11-14 管理员扫码退款流程

- 普通用户不能结束租赁、主动同步退款或重试退款；退款进度通过 GET 查询持久化结果。管理员或 ROOT 扫描正在租赁的设备后，确认实物归还、原因与金额，选择退还押金或全额退款。退款使用订单实付快照，结算未成功时保持设备占用。
- 退款决定事务内重新查询并锁定当前角色，撤销管理员会阻止新的决定及后续主动管理请求；已获授权并持久化的退款仍由后台安全重试。失败重试使用原退款单号，不能通过重试切换退款方式。
- 小程序 `1.0.9-20261114-1310` 已上传（106,365 字节），用户已确认设为体验版。仅网页 ROOT 可见身份授权入口；小程序原身份管理页提供网页后台指引。
- API 提交 `38d821812e0574b102d874ff48f3ea2ff53fe43b`，[CI](https://github.com/42task/ar-device-rental-api/actions/runs/43560434318) 成功，镜像 `sha256:8f4531af2b40fd882f855ade1afa9c0ffcd970515ad3d57005da14a8592510fe`。
- 网页 admin 提交 `2a87d196f2f6498e3ac13eedb493b335b9aa1877`，[CI](https://github.com/42task/ar-device-rental-admin/actions/runs/43560644881) 成功，镜像 `sha256:22c0ec628baae7d87a28faaae086c8e60012d6e5f6d5bebd0d9b1307b43b9746`。独立前端只调整权限与退款说明。
- Portainer 原 Stack 仅替换这两个镜像，保留数据库容器、环境变量、支付开启状态及只读密钥卷。线上 `/health` 和 `/admin/version.json` 均健康，分别返回上述提交。禁止写入和支付提供方调用的服务诊断验证普通身份的 `end`、`syncRefund`、`retryRefund` 均为 403；客户可读进度，退款 action 标志均为 false，写入尝试及提供方调用均为零。
- 工程检查：118 项小程序测试、107 项 API 单测和 9 项隔离本机 MySQL 集成测试通过，涵盖 ROOT 网页授权/撤销、旧凭据失权、用户禁止退款、失败重试、并发退款方式选择及结算占用。临时数据库容器和测试凭据已清理。未更改线上用户角色，未发起新的真实扣款或退款；未推进 `main` / `publish`，未提交审核或正式发布小程序。


## 2026-11-14 四级身份与 Aero 部署核验

白底亮蓝后台和四级身份API已通过用户指定的内置浏览器部署至Portainer endpoint2/stack27。仅替换两条image摘要，完整Compose粘贴后复制比对；原支付/密钥卷/数据库/网络配置保留。

后台commit 4ad9736e8a8485494d1b2dadb8f9e95eaf72b1c6，CI43592042171成功；API commit 8afdee139d3764a8b5d26610bd3fad3ad3216a72，CI43591978763含MySQL验证成功。线上两个gitCommit分别匹配，三容器刷新后healthy，MySQL未重建，API database up/schema ready/payments enabled。不可变manifest及容器ID在artifacts/ui/aero/release.json，安全核验截图在同目录。

当时（角色更名前）使用 root>admin>manager>user 继承；admin 管理其他 user/manager，root 另可管理 admin，自己及 root 受保护。当前角色拼写已改为 `adminer`，后续发布与迁移须单独核实。root全库唯一并受微信已验证手机号初始化规则约束；没有更改真实用户身份。资金守卫、失败/重试/并发和退款未结算占用已有验证，没有新增真实付款或退款。仅推develop，main/publish未推；小程序仅上传开发版本，未正式发布。
