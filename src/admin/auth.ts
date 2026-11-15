import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { RentalAuth, RentalPrincipal } from '../auth';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { requireManager, userRole } from '../core/roles';
import type { ApiRouter } from '../core/router';
import type { WeChatClient } from '../payments/wechat';
import { requireVerifiedPhone } from '../auth/phone';
import { currentMerchant, entryMerchant } from '../merchants/context';
import { findIdentityUser, requireAccountScope } from '../auth/identity';
import { publicMerchant, publicUser } from '../auth';

const BASE = '/v2/rental/admin/auth';
const BROWSER_COOKIE = 'ar_admin_browser', SESSION_COOKIE = 'ar_admin_session';
const CHALLENGE_MS = 5 * 60_000, SESSION_MS = 8 * 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
const loopback = (address: string | undefined) => !!address && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

export interface AdminAuthOptions { publicOrigin?: string; envVersion?: 'release' | 'trial' | 'develop'; now?: () => number }

/** Durable, browser-bound authorization; scanning a code never creates a session. */
export class AdminAuth {
  private readonly now: () => number;
  private readonly publicOrigin: string;
  private readonly envVersion: string;
  constructor(private readonly db: Database, private readonly defaultClient: WeChatClient, private readonly auth: RentalAuth, options: AdminAuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
    this.envVersion = options.envVersion ?? process.env.ADMIN_LOGIN_ENV_VERSION ?? 'release';
  }
  private get client(): WeChatClient { return entryMerchant()?.client ?? this.defaultClient; }
  private origin(ctx: Context): string {
    const entry = entryMerchant();
    let configured = entry?.origin ?? this.publicOrigin;
    if (entry && loopback(ctx.req.socket?.remoteAddress) && !ctx.req.headers['x-forwarded-host'] && !ctx.req.headers['x-forwarded-for'] && !ctx.req.headers['x-forwarded-proto']) {
      try {
        const local = new URL(`${ctx.req.protocol}://${ctx.req.headers.host}`);
        if (['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) {
          configured = '';
          if (this.publicOrigin) {
            const explicit = new URL(this.publicOrigin);
            if (['localhost', '127.0.0.1', '[::1]'].includes(explicit.hostname)) configured = this.publicOrigin;
          }
        }
      } catch { /* The configured merchant origin remains authoritative. */ }
    }
    if (configured) {
      try {
        const url = new URL(configured);
        if (url.origin !== configured || configured.length > 255 || url.username || url.password || !['https:', 'http:'].includes(url.protocol)
          || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error();
        return url.origin;
      } catch { throw new ApiError(503, '后台 PUBLIC_ORIGIN 配置无效'); }
    }
    // Only direct loopback development may derive its origin from Host.
    try {
      if (!loopback(ctx.req.socket?.remoteAddress)) throw Error();
      const url = new URL(`${ctx.req.protocol}://${ctx.req.headers.host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw Error();
      return url.origin;
    } catch { throw new ApiError(503, '请配置后台 PUBLIC_ORIGIN'); }
  }
  private requireOrigin(ctx: Context): string {
    const expected = this.origin(ctx);
    if (ctx.req.headers.origin !== expected) throw new ApiError(403, '后台请求来源无效，请从管理页面操作');
    return expected;
  }
  private cookie(ctx: Context, name: string): string | undefined {
    const header = ctx.req.headers.cookie;
    if (typeof header !== 'string' || header.length > 8192) return undefined;
    const values = header.split(';').map(value => value.trim()).filter(value => value.startsWith(name + '=')).map(value => value.slice(name.length + 1));
    return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0]) ? values[0] : undefined;
  }
  private setCookie(ctx: Context, name: string, value: string, milliseconds: number): void {
    const secure = this.origin(ctx).startsWith('https://') ? '; Secure' : '';
    ctx.res.append('Set-Cookie', `${name}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(milliseconds / 1000))}${secure}`);
  }
  private challengeId(ctx: Context): string {
    if (!/^[a-f0-9]{32}$/.test(ctx.params.id || '')) throw new ApiError(404, '登录二维码不存在');
    return ctx.params.id;
  }
  private async challenge(db: Database, ctx: Context, browser: boolean, lock = false): Promise<Row> {
    const row = await db.one(`SELECT * FROM ar_admin_login_challenge WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [this.challengeId(ctx)]);
    if (!row) throw new ApiError(404, '登录二维码不存在');
    const entry = entryMerchant();
    if (entry && ((row.application_id != null ? Number(row.application_id) !== entry.id : Number(row.merchant_id) !== Number((entry as any).legacyMerchantId ?? entry.id)) || row.appid && row.appid !== entry.appId)) throw new ApiError(404, '登录二维码不属于当前小程序入口');
    if (browser) {
      const secret = this.cookie(ctx, BROWSER_COOKIE);
      if (!secret || !same(hash(secret), row.browser_hash) || row.origin !== this.origin(ctx)) throw new ApiError(401, '请在生成二维码的浏览器继续登录');
    }
    if (Number(row.expires_ms) <= this.now() && ['pending', 'scanned', 'confirmed'].includes(row.status)) {
      if (lock) await db.execute("UPDATE ar_admin_login_challenge SET status='expired' WHERE id=?", [row.id]);
      return { ...row, status: 'expired' };
    }
    return row;
  }
  private status(row: Row, details = false): Row {
    return { status: row.status, expiresAt: iso(row.expires_ms), ...(details ? { confirmationCode: row.confirmation_code, origin: row.origin } : {}) };
  }
  private async managementMerchant(db: Database, user: Row): Promise<Row | undefined> {
    const entry = entryMerchant(), selected = currentMerchant() ?? entry;
    if (!entry || userRole(user) === 'root' || Number(user.merchant_id) === selected?.id) return publicMerchant();
    const row = await db.one('SELECT * FROM ar_merchant WHERE id=?', [user.merchant_id]);
    if (!row || row.app_id !== entry.appId) throw new ApiError(403, '所属商户未关联当前小程序');
    return { id: Number(row.id), code: row.code, name: row.name, status: row.status, origin: row.origin, appId: row.app_id,
      ...(row.active_config_id ? { configId: Number(row.active_config_id) } : {}) };
  }
  private async create(ctx: Context): Promise<Row> {
    const origin = this.requireOrigin(ctx), id = randomBytes(16).toString('hex');
    const browserSecret = this.cookie(ctx, BROWSER_COOKIE) || randomBytes(32).toString('hex');
    const now = this.now(), confirmationCode = String(randomInt(1_000_000)).padStart(6, '0');
    // Retain terminal login status briefly; bound cleanup work on every new code.
    await this.db.execute('DELETE FROM ar_admin_login_challenge WHERE expires_ms<? LIMIT 100', [now - 86_400_000]);
    await this.db.execute('DELETE FROM ar_admin_session WHERE expires_ms<? LIMIT 100', [now - 86_400_000]);
    const entry = entryMerchant();
    if (entry) await this.db.execute('INSERT INTO ar_admin_login_challenge (id,browser_hash,origin,confirmation_code,status,created_ms,expires_ms,merchant_id,appid,application_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, hash(browserSecret), origin, confirmationCode, 'pending', now, now + CHALLENGE_MS, Number((entry as any).legacyMerchantId ?? entry.id), entry.appId, entry.id]);
    else await this.db.execute('INSERT INTO ar_admin_login_challenge (id,browser_hash,origin,confirmation_code,status,created_ms,expires_ms) VALUES (?,?,?,?,?,?,?)', [id, hash(browserSecret), origin, confirmationCode, 'pending', now, now + CHALLENGE_MS]);
    this.setCookie(ctx, BROWSER_COOKIE, browserSecret, CHALLENGE_MS);
    return { id, expiresAt: iso(now + CHALLENGE_MS), confirmationCode, qrcodeUrl: `/api${BASE}/challenges/${id}/qrcode` };
  }
  private async scan(ctx: Context): Promise<Row> {
    const principal = await this.auth.authenticateBearer(ctx); requireManager(principal.user);
    await requireVerifiedPhone(this.db, principal);
    return this.db.transaction(async db => {
      const row = await this.challenge(db, ctx, false, true);
      if (row.scanned_user_id && Number(row.scanned_user_id) !== Number(principal.user.id)) throw new ApiError(409, '该二维码已由其他管理员扫描，请刷新后重试');
      if (row.status === 'pending') {
        if (entryMerchant()) await db.execute("UPDATE ar_admin_login_challenge SET status='scanned',scanned_user_id=?,auth_version=? WHERE id=?", [principal.user.id, principal.authVersion, row.id]);
        else await db.execute("UPDATE ar_admin_login_challenge SET status='scanned',scanned_user_id=? WHERE id=?", [principal.user.id, row.id]);
        row.status = 'scanned';
      }
      return this.status(row, true);
    });
  }
  private async confirm(ctx: Context): Promise<Row> {
    const principal = await this.auth.authenticateBearer(ctx); requireManager(principal.user);
    await requireVerifiedPhone(this.db, principal);
    if (typeof ctx.body.approved !== 'boolean') throw new ApiError(422, '请选择确认或取消登录');
    return this.db.transaction(async db => {
      const row = await this.challenge(db, ctx, false, true);
      if (Number(row.scanned_user_id) !== Number(principal.user.id)) throw new ApiError(403, '请由扫描二维码的管理员确认');
      const desired = ctx.body.approved ? 'confirmed' : 'cancelled';
      if (row.status === 'scanned') {
        const user = entryMerchant() ? await findIdentityUser(db, Number(principal.user.id), this.auth.appId, principal.identityId, true) : await db.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [principal.user.id, this.auth.appId]);
        if (!user) throw new ApiError(401, '当前微信账号已失效，请重新登录');
        if (entryMerchant()) { requireAccountScope(user); if (Number(user.auth_version) !== Number(row.auth_version) || Number(user.auth_version) !== principal.authVersion) throw new ApiError(401, '账号归属已变更，请重新扫码'); }
        requireManager(user);
        await requireVerifiedPhone(db, { ...principal, user });
        await db.execute('UPDATE ar_admin_login_challenge SET status=? WHERE id=?', [desired, row.id]);
        row.status = desired;
      } else if (![desired, 'expired', 'consumed'].includes(row.status)) throw new ApiError(409, '当前二维码无法确认，请刷新后重试');
      return this.status(row, true);
    });
  }
  private async consume(ctx: Context): Promise<Row> {
    this.requireOrigin(ctx);
    const token = randomBytes(32).toString('hex'), now = this.now();
    const result = await this.db.transaction(async db => {
      const row = await this.challenge(db, ctx, true, true);
      if (row.status === 'expired') throw new ApiError(410, '登录二维码已过期，请刷新');
      if (row.status !== 'confirmed') throw new ApiError(409, row.status === 'consumed' ? '登录二维码已经使用，请重新扫码' : '请先在微信中确认登录');
      const user = entryMerchant() ? await findIdentityUser(db, Number(row.scanned_user_id), this.auth.appId, undefined, true) : await db.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [row.scanned_user_id, this.auth.appId]);
      if (!user || typeof user.openid !== 'string' || !user.openid) throw new ApiError(401, '当前微信账号已失效，请重新登录');
      if (entryMerchant()) { requireAccountScope(user); if (Number(user.auth_version) !== Number(row.auth_version)) throw new ApiError(401, '账号归属已变更，请重新扫码'); }
      requireManager(user);
      await requireVerifiedPhone(db, { user, appid: this.auth.appId, openid: user.openid, ...(entryMerchant() ? { identityId: Number(user.identity_id) } : {}) });
      if (entryMerchant()) await db.execute('INSERT INTO ar_admin_session (id,user_id,appid,created_ms,expires_ms,merchant_id,identity_id,auth_version,origin,application_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [hash(token), user.id, this.auth.appId, now, now + SESSION_MS, userRole(user) === 'root' ? null : Number(user.merchant_id), Number(user.identity_id), Number(user.auth_version), this.origin(ctx), entryMerchant()!.id]);
      else await db.execute('INSERT INTO ar_admin_session (id,user_id,appid,created_ms,expires_ms) VALUES (?,?,?,?,?)', [hash(token), user.id, this.auth.appId, now, now + SESSION_MS]);
      await db.execute("UPDATE ar_admin_login_challenge SET status='consumed',consumed_ms=? WHERE id=?", [now, row.id]);
      const previous = this.cookie(ctx, SESSION_COOKIE);
      if (previous) await db.execute('UPDATE ar_admin_session SET revoked_ms=? WHERE id=? AND revoked_ms IS NULL', [now, hash(previous)]);
      const managementMerchant = userRole(user) === 'root' ? null : await this.managementMerchant(db, user);
      return { user: publicUser(user), expiresAt: iso(now + SESSION_MS), ...(entryMerchant() ? { entry: this.auth.publicEntry(), managementMerchant, merchant: managementMerchant ?? publicMerchant() } : {}) };
    });
    this.setCookie(ctx, SESSION_COOKIE, token, SESSION_MS);
    return result;
  }
  private async session(ctx: Context): Promise<{ principal: RentalPrincipal; row: Row }> {
    const token = this.cookie(ctx, SESSION_COOKIE);
    if (!token) throw new ApiError(401, '请扫码登录管理后台');
    const row = await this.db.one('SELECT * FROM ar_admin_session WHERE id=? AND appid=? AND revoked_ms IS NULL AND expires_ms>?', [hash(token), this.auth.appId, this.now()]);
    if (!row) throw new ApiError(401, '后台登录已失效，请重新扫码');
    const entry = entryMerchant();
    const user = entry ? await findIdentityUser(this.db, Number(row.user_id), this.auth.appId, row.identity_id === null ? undefined : Number(row.identity_id)) : await this.db.one('SELECT * FROM ar_user WHERE id=? AND appid=?', [row.user_id, this.auth.appId]);
    if (!user || typeof user.openid !== 'string' || !user.openid) throw new ApiError(401, '当前微信账号已失效，请重新登录');
    if (entry) {
      requireAccountScope(user);
      if (row.application_id != null && Number(row.application_id) !== entry.id || Number(row.auth_version ?? 0) !== Number(user.auth_version ?? 0) || row.origin && row.origin !== this.origin(ctx)
        || !row.origin && (Number((entry as any).legacyMerchantId ?? entry.id) !== 1 || Number(user.auth_version) !== 0)
        || userRole(user) !== 'root' && Number(row.merchant_id) !== Number(user.merchant_id)) throw new ApiError(401, '账号归属或后台来源已变化，请重新扫码');
    }
    requireManager(user);
    const principal: RentalPrincipal = { user, appid: this.auth.appId, openid: user.openid, ...(entry ? { merchantId: (currentMerchant() ?? entry).id, authVersion: Number(user.auth_version ?? 0), identityId: Number(user.identity_id) } : {}) };
    await requireVerifiedPhone(this.db, principal);
    return { principal, row };
  }
  readonly authenticate = async (ctx: Context): Promise<RentalPrincipal> => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method)) this.requireOrigin(ctx);
    return (await this.session(ctx)).principal;
  };
  register(router: ApiRouter): void {
    const route = (method: string, path: string, handler: (ctx: Context) => Promise<unknown>) => router.add(method, BASE + path, ctx => {
      ctx.res.setHeader('Cache-Control', 'no-store');
      ctx.res.setHeader('Referrer-Policy', 'no-referrer');
      return handler(ctx);
    });
    route('POST', '/challenges', ctx => this.create(ctx));
    route('GET', '/challenges/:id', async ctx => this.status(await this.challenge(this.db, ctx, true)));
    route('GET', '/challenges/:id/qrcode', async ctx => {
      if (!['release', 'trial', 'develop'].includes(this.envVersion)) throw new ApiError(503, '后台小程序版本配置无效');
      const image = await this.db.transaction(async db => {
        const row = await this.challenge(db, ctx, true, true);
        if (!['pending', 'scanned', 'confirmed'].includes(row.status)) throw new ApiError(410, '登录二维码已失效，请刷新');
        if (row.qrcode_image) return Buffer.from(row.qrcode_image);
        const generated = await this.client.unlimitedCode(row.id, this.envVersion as 'release' | 'trial' | 'develop');
        await db.execute('UPDATE ar_admin_login_challenge SET qrcode_image=? WHERE id=?', [generated, row.id]);
        return generated;
      });
      ctx.res.type(image[0] === 137 ? 'image/png' : 'image/jpeg').end(image);
    });
    route('POST', '/challenges/:id/scan', ctx => this.scan(ctx));
    route('POST', '/challenges/:id/confirm', ctx => this.confirm(ctx));
    route('POST', '/challenges/:id/consume', ctx => this.consume(ctx));
    route('GET', '/session', async ctx => {
      const { principal, row } = await this.session(ctx);
      const managementMerchant = userRole(principal.user) === 'root' ? null : await this.managementMerchant(this.db, principal.user);
      return { user: publicUser(principal.user), expiresAt: iso(row.expires_ms), ...(entryMerchant() ? { entry: this.auth.publicEntry(), managementMerchant, merchant: managementMerchant ?? publicMerchant() } : {}) };
    });
    route('POST', '/logout', async ctx => {
      this.requireOrigin(ctx);
      const token = this.cookie(ctx, SESSION_COOKIE);
      if (token) await this.db.execute('UPDATE ar_admin_session SET revoked_ms=? WHERE id=? AND revoked_ms IS NULL', [this.now(), hash(token)]);
      this.setCookie(ctx, SESSION_COOKIE, '', 0);
      return { success: true };
    });
  }
}
