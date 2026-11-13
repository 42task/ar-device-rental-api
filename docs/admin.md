# 网页后台扫码登录

网页前端单独由 `42task/ar-device-rental-admin` 构建和部署，与 API 同域 `https://d.4mr.cn`。Traefik 将 `/admin` 路径交给前端，`/api/v2` 继续交给本服务。后台代码不包含 AppSecret 或数据库配置。

浏览器创建 5 分钟登录挑战，微信扫码进入小程序 `pages/admin/login`。已授权的 manager/root 核对域名和 6 位确认码后主动确认；只有生成挑战的原浏览器可单次领取 8 小时会话。挑战和会话持久化到 MySQL，仅存凭据摘要，支持多节点；会话用 HttpOnly/Secure/SameSite=Strict Cookie，写操作校验 Origin，每次请求重读当前角色。退出在服务端注销。普通扫码不会成为管理员。

## 部署

- `PUBLIC_ORIGIN=https://d.4mr.cn`，必须与实际浏览器来源完全一致，不带尾部斜杠或路径。
- 沿用现有小程序 AppID `wx03dbf50c15cac06f` 和服务端 AppSecret，必要时在微信后台配置服务器出口 IP。
- 本次迁移新增 `ar_admin_login_challenge`、`ar_admin_session`，schema 升到 2，不修改资金状态或导入用户。仍由启动命令先 `npm run migrate` 再启动应用；升级前按原流程备份。旧版本 schema 1 的健康检查与新 schema 不兼容，回滚须协调数据库版本。
- `ADMIN_LOGIN_ENV_VERSION` 默认 `release`，小程序须已正式发布 `pages/admin/login`。体验/开发联调可设 `trial`/`develop`，仅相关测试账号可打开；联调后恢复 `release`。后端启动和前端上线不等于小程序已上传或正式发布。
- 首个 root 继续由受控服务器控制台显式初始化，网页不提供 root 授予接口。

## 新增接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/v2/rental/admin/auth/challenges` | 浏览器创建挑战 |
| `GET /api/v2/rental/admin/auth/challenges/:id` | 原浏览器查询状态 |
| `GET /api/v2/rental/admin/auth/challenges/:id/qrcode` | 原浏览器读取微信小程序码 |
| `POST /api/v2/rental/admin/auth/challenges/:id/scan` | 小程序管理员 Bearer 扫码 |
| `POST /api/v2/rental/admin/auth/challenges/:id/confirm` | 同一扫码者主动确认/取消 |
| `POST /api/v2/rental/admin/auth/challenges/:id/consume` | 原浏览器单次兑换 |
| `GET /api/v2/rental/admin/auth/session` | 读取当前网页身份 |
| `POST /api/v2/rental/admin/auth/logout` | 注销网页会话 |
| `GET /api/v2/rental/admin/overview` | 管理统计 |
| `GET /api/v2/rental/admin/orders` | 当前 AppID 全用户订单分页及搜索 |

后台查询继续复用现有设备、费用配置、用户授权和订单详情接口。网页首版不提供真实扣款或退款按钮。

## 验证

运行 `npm test`、`npm run build`；另在专用本机 MySQL 测试实例执行 `npm run test:integration`。新增测试覆盖来源校验、角色撤销、过期、取消、原浏览器绑定、会话注销、双节点并发取码及 8 次并发兑换仅一次成功，不使用真实支付。
