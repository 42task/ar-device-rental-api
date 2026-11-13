import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import type { ApiRouter } from '../core/router';
import type { WeChatClient } from '../payments/wechat';
import { maskedPhone } from './phone';

export { bootstrapRoot } from './admin';
export interface RentalPrincipal { user: Row; appid: string; openid: string }
export interface RentalAuthOptions { jwtSecret?: string; jwtSecretPath?: string; issuer?: string; audience?: string; appId?: string; now?: () => number }
const role = (value: unknown) => value === 'root' || value === 'manager' ? value : 'user';
const publicUser = (user: Row): Row => ({ id: Number(user.id), role: role(user.role), nickname: user.nickname ?? null, avatar: user.avatar ?? null, tel: user.verified_phone ? maskedPhone(user.verified_phone, user.phone_country_code) : user.tel ?? null, ...(user.verified_phone ? { phoneVerified: true } : {}) });
const validIdentity = (value: unknown): value is string => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,128}$/u.test(value);

export class RentalAuth {
  webAuthenticate?: (ctx: Context) => Promise<RentalPrincipal>;
  readonly appId: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly now: () => number;
  private readonly jwtSecret?: string;
  constructor(private readonly db: Database, private readonly client: WeChatClient, options: RentalAuthOptions = {}) {
    this.appId = options.appId ?? client.config.appId ?? '';
    this.issuer = options.issuer ?? process.env.JWT_ISSUER ?? 'ar-device-rental-api';
    this.audience = options.audience ?? process.env.JWT_AUDIENCE ?? 'ar-device-rental-mini-program';
    this.now = options.now ?? Date.now;
    try {
      const path = options.jwtSecretPath ?? process.env.JWT_SECRET_PATH;
      this.jwtSecret = options.jwtSecret?.trim() || process.env.JWT_SECRET?.trim() || (path?.trim() ? readFileSync(path, 'utf8').trim() : undefined);
    } catch { /* Configuration errors are reported on auth use, without file details. */ }
  }
  private configured(): void {
    if (!/^wx[0-9a-f]{16}$/i.test(this.appId) || this.appId !== this.client.config.appId) throw new ApiError(503, '小程序 AppID 配置无效');
    if (!this.jwtSecret || Buffer.byteLength(this.jwtSecret) < 32) throw new ApiError(503, '登录签名密钥未配置或长度不足');
  }
  private issue(user: Row): Row {
    const now = Math.floor(this.now() / 1000), accessSeconds = 7200;
    const make = (purpose: 'access' | 'refresh', seconds: number) => jwt.sign({ uid: Number(user.id), appid: this.appId, purpose, iat: now, nbf: now, exp: now + seconds }, this.jwtSecret!, { algorithm: 'HS256', issuer: this.issuer, audience: this.audience, jwtid: randomBytes(16).toString('hex') });
    return { accessToken: make('access', accessSeconds), refreshToken: make('refresh', 2592000), expires: new Date((now + accessSeconds) * 1000).toISOString() };
  }
  private response(user: Row): Row { return { token: this.issue(user), user: publicUser(user), openid: user.openid, unionid: user.unionid ?? null, appId: this.appId }; }
  private async verify(value: unknown, purpose: 'access' | 'refresh'): Promise<Row> {
    this.configured();
    if (typeof value !== 'string' || !value || value.length > 8192) throw new ApiError(401, '登录已失效，请重新登录');
    let claims: JwtPayload;
    try {
      const parsed = jwt.verify(value, this.jwtSecret!, { algorithms: ['HS256'], issuer: this.issuer, audience: this.audience, clockTimestamp: Math.floor(this.now() / 1000) });
      if (typeof parsed === 'string' || !Number.isSafeInteger(parsed.uid) || parsed.uid < 1 || parsed.appid !== this.appId || parsed.purpose !== purpose
        || !['iat', 'nbf', 'exp'].every(key => typeof parsed[key] === 'number' && Number.isFinite(parsed[key])) || parsed.iat! > this.now() / 1000 || parsed.exp! <= parsed.iat!) throw Error();
      claims = parsed;
    } catch { throw new ApiError(401, '登录已失效，请重新登录'); }
    const user = await this.db.one('SELECT * FROM ar_user WHERE id=? AND appid=?', [claims.uid, this.appId]);
    if (!user || !validIdentity(user.openid)) throw new ApiError(401, '当前微信账号已失效，请重新登录');
    return { ...user, role: role(user.role) };
  }
  async login(code: unknown): Promise<Row> {
    this.configured();
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 1024) throw new ApiError(400, '微信登录 code 无效');
    const identity = await this.client.codeSession(code);
    if (!validIdentity(identity.openid) || identity.unionid !== undefined && identity.unionid !== null && !validIdentity(identity.unionid)) throw new ApiError(401, '微信登录身份无效');
    let user: Row | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        user = await this.db.transaction(async tx => {
          const existing = await tx.one('SELECT * FROM ar_user WHERE appid=? AND openid=? FOR UPDATE', [this.appId, identity.openid]);
          if (existing) {
            if (identity.unionid && existing.unionid && existing.unionid !== identity.unionid) throw new ApiError(401, '微信账号身份不一致');
            if (identity.unionid && !existing.unionid) {
              await tx.execute('UPDATE ar_user SET unionid=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [identity.unionid, existing.id]);
              existing.unionid = identity.unionid;
            }
            return existing;
          }
          // No cross-application/UnionID lookup; only this server's verified OpenID.
          return tx.insert('ar_user', { appid: this.appId, openid: identity.openid, unionid: identity.unionid ?? null, role: 'user' });
        });
        break;
      } catch (error: any) {
        if (!['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK'].includes(error?.code) || attempt === 2) throw error;
      }
    }
    if (!user) throw new ApiError(503, '微信登录暂时不可用');
    return this.response(user);
  }
  async refresh(value: unknown): Promise<Row> { return this.response(await this.verify(value, 'refresh')); }
  readonly authenticateBearer = async (ctx: Context): Promise<RentalPrincipal> => {
    const header = ctx.req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) { ctx.res.setHeader('WWW-Authenticate', 'Bearer'); throw new ApiError(401, '请先登录'); }
    const user = await this.verify(match[1], 'access');
    return { user, appid: this.appId, openid: user.openid };
  };
  readonly authenticate = async (ctx: Context): Promise<RentalPrincipal> => {
    if (ctx.req.headers.authorization === undefined && this.webAuthenticate) return this.webAuthenticate(ctx);
    return this.authenticateBearer(ctx);
  };
  private async users(ctx: Context): Promise<Row> {
    const principal = await this.authenticate(ctx);
    if (principal.user.role !== 'root') throw new ApiError(403, '仅 root 可以管理用户');
    const page = Math.max(1, Math.min(1000000, Math.floor(Number(ctx.query.page)) || 1)), pageSize = 20;
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.trim().slice(0, 100) : '';
    const searchSql = search ? ' AND (u.nickname LIKE ? OR u.tel LIKE ? OR p.phone_e164 LIKE ? OR CAST(u.id AS CHAR)=?)' : '';
    const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
    const values = search ? [this.appId, principal.user.id, pattern, pattern, pattern, search] : [this.appId, principal.user.id];
    const from = ' FROM ar_user u LEFT JOIN ar_user_phone p ON p.user_id=u.id AND p.appid=u.appid AND p.verified_ms>0 WHERE u.appid=? AND u.id<>?';
    const count = await this.db.one('SELECT COUNT(*) AS total' + from + searchSql, values);
    const items = await this.db.query(`SELECT u.*,p.phone_e164 AS verified_phone,p.country_code AS phone_country_code${from}${searchSql} ORDER BY u.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values);
    return { items: items.map(publicUser), page, pageSize, total: Number(count?.total || 0) };
  }
  private async setRole(ctx: Context): Promise<Row> {
    const principal = await this.authenticate(ctx);
    if (principal.user.role !== 'root') throw new ApiError(403, '仅 root 可以管理用户');
    const targetId = Number(ctx.params.id), nextRole = ctx.body.role;
    if (!Number.isSafeInteger(targetId) || targetId < 1 || !['manager', 'user'].includes(nextRole)) throw new ApiError(422, '用户编号或角色无效');
    const user = await this.db.transaction(async tx => {
      if (!await tx.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
      const actor = await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [principal.user.id, this.appId]);
      if (!actor || actor.role !== 'root') throw new ApiError(403, 'root 权限已变更，请重新登录');
      const target = await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [targetId, this.appId]);
      if (!target) throw new ApiError(404, '用户不存在');
      if (target.role === 'root') throw new ApiError(403, 'root 账号不可通过此接口修改');
      if (target.role === nextRole) return target;
      await tx.execute('UPDATE ar_user SET role=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [nextRole, targetId]);
      await tx.insert('ar_role_audit', { actor_user_id: principal.user.id, target_user_id: targetId, previous_role: target.role, next_role: nextRole, source: 'api', reason: typeof ctx.body.reason === 'string' ? ctx.body.reason.trim().slice(0, 255) || '管理员更新角色' : '管理员更新角色' });
      return { ...target, role: nextRole };
    });
    return publicUser(user);
  }
  registerAuth(router: ApiRouter): void {
    const route = (method: string, path: string, handler: (ctx: Context) => Promise<Row>) => router.add(method, path, ctx => { ctx.res.setHeader('Cache-Control', 'no-store'); return handler(ctx); });
    route('POST', '/v2/rental/auth/login', async ctx => ({ success: true, data: await this.login(ctx.body.code) }));
    route('POST', '/v2/rental/auth/refresh', async ctx => ({ success: true, data: await this.refresh(ctx.body.refreshToken) }));
    route('GET', '/v2/rental/admin/users', ctx => this.users(ctx));
    route('PUT', '/v2/rental/admin/users/:id/role', ctx => this.setRole(ctx));
  }
}
