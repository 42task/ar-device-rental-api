import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import type { ApiRouter } from '../core/router';
import type { WeChatClient } from '../payments/wechat';
import { maskedPhone, normalizePhoneInput } from './phone';
import { initializeRootFromVerifiedPhone } from './admin';
import { assignableRoles, requireRoot, requireUserAdmin, userRole } from '../core/roles';
import { currentMerchant, entryMerchant, publicEntry as serializeEntry } from '../merchants/context';
import { findIdentityUser, legacyAccountAdapter, loadAccountPermissions, requireAccountScope, requireMerchantManagementScope } from './identity';

export { bootstrapRoot } from './admin';
export interface RentalPrincipal { user: Row; appid: string; openid: string; merchantId?: number; authVersion?: number; identityId?: number }
export interface RentalAuthOptions { jwtSecret?: string; jwtSecretPath?: string; issuer?: string; audience?: string; appId?: string; rootPhone?: string; now?: () => number }
export const publicUser = (user: Row): Row => ({ id: Number(user.id), role: userRole(user), nickname: user.nickname ?? null, avatar: user.avatar ?? null, tel: user.verified_phone ? maskedPhone(user.verified_phone, user.phone_country_code) : user.tel ?? null, ...(user.verified_phone ? { phoneVerified: true } : {}), ...('merchant_id' in user ? { merchantId: user.merchant_id === null ? null : Number(user.merchant_id) } : {}) });
// Complete verified numbers are available only in the authorized user directory.
const directoryUser = (user: Row): Row => ({ ...publicUser(user), phoneNumber: user.verified_phone ?? null, phoneVerified: Boolean(user.verified_phone) });
export function publicMerchant(): Row | undefined {
  const merchant = currentMerchant();
  return merchant ? { id: merchant.id, code: merchant.code, name: merchant.name, status: merchant.status, origin: merchant.origin, appId: merchant.appId, configId: merchant.configId } : undefined;
}
const validIdentity = (value: unknown): value is string => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,128}$/u.test(value);

export class RentalAuth {
  webAuthenticate?: (ctx: Context) => Promise<RentalPrincipal>;
  private readonly defaultAppId: string;
  get appId(): string { return entryMerchant()?.appId ?? this.defaultAppId; }
  private get client(): WeChatClient { return entryMerchant()?.client ?? this.defaultClient; }
  private readonly issuer: string;
  private readonly audience: string;
  private readonly now: () => number;
  private readonly jwtSecret?: string;
  private readonly rootPhone?: string;
  private readonly rootPhoneInvalid: boolean = false;
  constructor(private readonly db: Database, private readonly defaultClient: WeChatClient, options: RentalAuthOptions = {}) {
    this.defaultAppId = options.appId ?? defaultClient.config.appId ?? '';
    this.issuer = options.issuer ?? process.env.JWT_ISSUER ?? 'ar-device-rental-api';
    this.audience = options.audience ?? process.env.JWT_AUDIENCE ?? 'ar-device-rental-mini-program';
    this.now = options.now ?? Date.now;
    try {
      const rootPhone = options.rootPhone ?? process.env.ROOT_PHONE ?? '';
      if (rootPhone.trim()) this.rootPhone = normalizePhoneInput(rootPhone);
    } catch { this.rootPhoneInvalid = true; }
    try {
      const path = options.jwtSecretPath ?? process.env.JWT_SECRET_PATH;
      this.jwtSecret = options.jwtSecret?.trim() || process.env.JWT_SECRET?.trim() || (path?.trim() ? readFileSync(path, 'utf8').trim() : undefined);
    } catch { /* Configuration errors are reported on auth use, without file details. */ }
  }
  private configured(): void {
    if (!/^wx[0-9a-f]{16}$/i.test(this.appId) || this.appId !== this.client.config.appId) throw new ApiError(503, '小程序 AppID 配置无效');
    if (!this.jwtSecret || Buffer.byteLength(this.jwtSecret) < 32) throw new ApiError(503, '登录签名密钥未配置或长度不足');
    if (this.rootPhoneInvalid) throw new ApiError(503, 'ROOT_PHONE 手机号配置无效，请检查环境变量');
  }
  private issue(user: Row): Row {
    const now = Math.floor(this.now() / 1000), accessSeconds = 7200;
    const make = (purpose: 'access' | 'refresh', seconds: number) => jwt.sign({ uid: Number(user.id), appid: this.appId, ...(entryMerchant() ? { iid: Number(user.identity_id), auth_version: Number(user.auth_version ?? 0) } : {}), purpose, iat: now, nbf: now, exp: now + seconds }, this.jwtSecret!, { algorithm: 'HS256', issuer: this.issuer, audience: this.audience, jwtid: randomBytes(16).toString('hex') });
    return { accessToken: make('access', accessSeconds), refreshToken: make('refresh', 2592000), expires: new Date((now + accessSeconds) * 1000).toISOString() };
  }
  private async response(user: Row, assigned = false): Promise<Row> {
    const entry = entryMerchant();
    const managementMerchant = entry && userRole(user) !== 'root' && user.merchant_id != null ? await this.managementMerchant(user.merchant_id) : null;
    const merchant = managementMerchant ?? (assigned && user.binding_merchant ? user.binding_merchant : publicMerchant());
    return { token: this.issue(user), user: publicUser(user), openid: user.openid, unionid: user.unionid ?? null, appId: this.appId,
      ...(entry ? { entry: this.publicEntry(), managementMerchant, merchant } : {}) };
  }
  publicEntry(): Row | null {
    const entry = entryMerchant();
    return entry ? serializeEntry(entry) : null;
  }
  async managementMerchant(id: number): Promise<Row> {
    const row = await this.db.one('SELECT * FROM ar_merchant WHERE id=?', [id]);
    if (!row || row.app_id !== this.appId) throw new ApiError(403, '所属商户未关联当前小程序');
    return { id: Number(row.id), code: row.code, name: row.name, status: row.status, origin: row.origin, appId: row.app_id,
      ...(row.active_config_id ? { configId: Number(row.active_config_id) } : {}) };
  }
  private get legacyEntryMerchantId(): number | undefined { return entryMerchant()?.legacyMerchantId; }
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
    const entry = entryMerchant();
    if (entry && (claims.iid !== undefined && (!Number.isSafeInteger(claims.iid) || claims.iid < 1)
      || claims.auth_version !== undefined && (!Number.isSafeInteger(claims.auth_version) || claims.auth_version < 0))) throw new ApiError(401, '登录凭据无效，请重新登录');
    let user = entry ? await findIdentityUser(this.db, claims.uid, this.appId, claims.iid) : await this.db.one('SELECT * FROM ar_user WHERE id=? AND appid=?', [claims.uid, this.appId]);
    if (!user && this.legacyEntryMerchantId === 1 && claims.iid === undefined && claims.auth_version === undefined) {
      user = await this.db.transaction(async db => {
        const legacy = await db.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [claims.uid, this.appId]);
        if (!legacy || Number(legacy.auth_version ?? 0) !== 0 || userRole(legacy) !== 'root' && Number(legacy.merchant_id) !== 1 || !validIdentity(legacy.openid)) return null;
        const linked = await db.one('SELECT * FROM ar_user_wechat_identity WHERE appid=? AND openid=? FOR UPDATE', [this.appId, legacy.openid]);
        if (linked && (Number(linked.user_id) !== Number(legacy.id) || linked.status !== 'active')) return null;
        if (!linked) await db.insert('ar_user_wechat_identity', { user_id: legacy.id, appid: this.appId, openid: legacy.openid, unionid: legacy.unionid ?? null, status: 'active' });
        return findIdentityUser(db, Number(legacy.id), this.appId);
      });
    }
    if (!user || !validIdentity(user.openid)) throw new ApiError(401, '当前微信账号已失效，请重新登录');
    if (entry) {
      const version = Number(user.auth_version ?? 0);
      const legacy = claims.iid === undefined && claims.auth_version === undefined && this.legacyEntryMerchantId === 1 && version === 0 && user.source_appid === this.appId;
      if (!legacy && (!Number.isSafeInteger(claims.iid) || claims.iid < 1 || !Number.isSafeInteger(claims.auth_version) || claims.auth_version !== version)) throw new ApiError(401, '账号归属或登录凭据已变更，请重新登录');
      requireAccountScope(user);
    }
    user = await loadAccountPermissions(this.db, user);
    const current = this.rootPhone && (!entry || this.legacyEntryMerchantId === 1) ? await initializeRootFromVerifiedPhone(this.db, user, this.appId, this.rootPhone) : user;
    return { ...current, role: userRole(current) };
  }
  async login(code: unknown, bindToken?: unknown): Promise<Row> {
    this.configured();
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 1024) throw new ApiError(400, '微信登录 code 无效');
    const identity = await this.client.codeSession(code);
    if (!validIdentity(identity.openid) || identity.unionid !== undefined && identity.unionid !== null && !validIdentity(identity.unionid)) throw new ApiError(401, '微信登录身份无效');
    if (entryMerchant()) return this.merchantLogin(identity, bindToken);
    if (bindToken !== undefined) throw new ApiError(422, '当前登录入口不支持商户绑定');
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
    user = await loadAccountPermissions(this.db, user);
    if (this.rootPhone) user = await initializeRootFromVerifiedPhone(this.db, user, this.appId, this.rootPhone);
    return this.response(user);
  }
  private async merchantLogin(identity: Row, bindToken?: unknown): Promise<Row> {
    const entry = entryMerchant()!;
    if (bindToken !== undefined && (typeof bindToken !== 'string' || !/^[a-f0-9]{64}$/.test(bindToken))) throw new ApiError(422, '商户绑定凭据无效');
    let user: Row | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        user = await this.db.transaction(async tx => {
          if (typeof bindToken === 'string') return this.completeMerchantBinding(tx, bindToken, identity);
          const linked = await tx.one('SELECT * FROM ar_user_wechat_identity WHERE appid=? AND openid=? FOR UPDATE', [entry.appId, identity.openid]);
          let account: Row | null;
          if (linked) {
            if (linked.status !== 'active') throw new ApiError(401, '此微信身份已停用，请联系最高管理员核实商户归属');
            if (identity.unionid && linked.unionid && identity.unionid !== linked.unionid) throw new ApiError(401, '微信账号身份不一致');
            account = await tx.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [linked.user_id]);
            if (!account) throw new ApiError(401, '当前微信账号已失效，请重新登录');
            if (identity.unionid && !linked.unionid) await tx.execute('UPDATE ar_user_wechat_identity SET unionid=? WHERE id=?', [identity.unionid, linked.id]);
          } else {
            // Existing default-merchant installations keep stable account/order IDs.
            account = await tx.one('SELECT * FROM ar_user WHERE appid=? AND openid=? FOR UPDATE', [entry.appId, identity.openid]);
            if (account && identity.unionid && account.unionid && account.unionid !== identity.unionid) throw new ApiError(401, '微信账号身份不一致');
            if (!account) {
              if (entry.status !== 'active') throw new ApiError(403, '当前小程序入口暂未开放服务');
              account = await tx.insert('ar_user', { appid: entry.appId, openid: identity.openid, unionid: identity.unionid ?? null, merchant_id: null, auth_version: 0, role: 'user' });
            }
            requireAccountScope(account);
            await tx.insert('ar_user_wechat_identity', { user_id: account.id, appid: entry.appId, openid: identity.openid, unionid: identity.unionid ?? null, status: 'active' });
          }
          const resolved = await findIdentityUser(tx, Number(account.id), entry.appId);
          if (!resolved) throw new ApiError(401, '当前微信身份无法登录');
          requireAccountScope(resolved);
          return resolved;
        });
        break;
      } catch (error: any) {
        if (!['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK'].includes(error?.code) || attempt === 2) throw error;
      }
    }
    if (!user) throw new ApiError(503, '微信登录暂时不可用');
    if (this.rootPhone && this.legacyEntryMerchantId === 1) user = await initializeRootFromVerifiedPhone(this.db, user, entry.appId, this.rootPhone);
    return this.response(user, typeof bindToken === 'string');
  }
  private async assertUserTransferable(db: Database, userId: number): Promise<void> {
    const unfinished = await db.one(`SELECT id FROM ar_rental_order WHERE user_id=? AND
      (status IN ('PENDING_PAYMENT','ACTIVE') OR
       ((status='COMPENSATING' OR refund_amount_cents>0) AND (refund_status IS NULL OR refund_status<>'SUCCESS'))) LIMIT 1`, [userId]);
    if (unfinished) throw new ApiError(409, '该账号仍有未完成租赁或退款，请先完成业务后再调整商户');
  }
  private async invalidateAuthorizations(db: Database, userId: number, now: number): Promise<void> {
    await db.execute('UPDATE ar_user_merchant_binding SET expires_ms=? WHERE user_id=? AND consumed_ms IS NULL', [now, userId]);
    await db.execute('UPDATE ar_admin_session SET revoked_ms=? WHERE user_id=? AND revoked_ms IS NULL', [now, userId]);
    await db.execute("UPDATE ar_admin_login_challenge SET status='cancelled' WHERE scanned_user_id=? AND status IN ('pending','scanned','confirmed')", [userId]);
  }
  private async membership(db: Database, userId: number, merchantId: number, role: string, now: number): Promise<void> {
    const existing = await db.one('SELECT * FROM ar_merchant_membership WHERE user_id=? FOR UPDATE', [userId]);
    if (['manager', 'adminer'].includes(role)) {
      if (existing) await db.execute("UPDATE ar_merchant_membership SET merchant_id=?,role=?,status='active',authorization_version=authorization_version+1,updated_ms=? WHERE user_id=?", [merchantId, role, now, userId]);
      else await db.insert('ar_merchant_membership', { user_id: userId, merchant_id: merchantId, role, status: 'active', authorization_version: 1, updated_ms: now });
    } else if (existing) await db.execute("UPDATE ar_merchant_membership SET status='revoked',authorization_version=authorization_version+1,updated_ms=? WHERE user_id=?", [now, userId]);
  }
  private validInvitation(request: Row | null, now: number): request is Row {
    return !!request && Number(request.expires_ms) > now && request.consumed_ms == null
      && Number.isSafeInteger(request.source_auth_version) && request.source_auth_version >= 0 && /^wx[0-9a-f]{16}$/i.test(request.source_appid || '');
  }
  private async completeMerchantBinding(db: Database, token: string, identity: Row): Promise<Row> {
    const entry = entryMerchant()!, now = this.now();
    if (!await db.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
    const request = await db.one('SELECT * FROM ar_user_merchant_binding WHERE id=? FOR UPDATE', [createHash('sha256').update(token).digest('hex')]);
    if (!this.validInvitation(request, now)) throw new ApiError(409, '商户绑定凭据已失效，请联系最高管理员重新分配');
    if (!Number(request.source_confirmed_ms)) throw new ApiError(403, '请先使用原账号在原商户小程序确认分配');
    const actor = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [request.created_by]);
    if (!actor) throw new ApiError(403, '分配授权已失效');
    requireRoot(actor);
    const rawUser = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [request.user_id]);
    const user = rawUser ? await loadAccountPermissions(db, rawUser) : null;
    if (!user || userRole(user) === 'root' || (user.merchant_id ?? null) !== (request.source_merchant_id ?? null)
      || Number(user.auth_version) !== request.source_auth_version) throw new ApiError(409, '账号归属或授权已变化，请联系最高管理员重新分配');
    if (!['user', 'manager', 'adminer'].includes(request.target_role)) throw new ApiError(409, '商户绑定授权无效');
    const merchant = await db.one('SELECT * FROM ar_merchant WHERE id=? FOR UPDATE', [request.target_merchant_id]);
    if (!merchant) throw new ApiError(409, '目标商户配置已变化，请重新登录');
    if (merchant.app_id !== entry.appId) throw new ApiError(403, '请在目标商户的小程序完成绑定');
    if (merchant.status !== 'active') throw new ApiError(403, '目标商户暂未开放服务');
    const linked = await db.one('SELECT * FROM ar_user_wechat_identity WHERE appid=? AND openid=? FOR UPDATE', [entry.appId, identity.openid]);
    const legacy = await db.one('SELECT id FROM ar_user WHERE appid=? AND openid=? FOR UPDATE', [entry.appId, identity.openid]);
    if (linked && Number(linked.user_id) !== Number(user.id) || legacy && Number(legacy.id) !== Number(user.id)) throw new ApiError(409, '目标微信身份已绑定其他账号，不能自动合并');
    if (request.source_appid === entry.appId && (!linked || Number(linked.user_id) !== Number(user.id))) throw new ApiError(403, '请由原微信账号本人完成员工授权');
    await this.assertUserTransferable(db, Number(user.id));
    await db.execute("UPDATE ar_user_wechat_identity SET status='disabled' WHERE user_id=?", [user.id]);
    if (linked) await db.execute("UPDATE ar_user_wechat_identity SET status='active',unionid=? WHERE id=?", [identity.unionid ?? linked.unionid ?? null, linked.id]);
    else await db.insert('ar_user_wechat_identity', { user_id: user.id, appid: entry.appId, openid: identity.openid, unionid: identity.unionid ?? null, status: 'active' });
    await this.membership(db, Number(user.id), Number(merchant.id), request.target_role, now);
    await db.execute('UPDATE ar_user SET merchant_id=?,role=?,auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [['manager', 'adminer'].includes(request.target_role) ? merchant.id : null, request.target_role, user.id]);
    await this.invalidateAuthorizations(db, Number(user.id), now);
    await db.execute('UPDATE ar_user_merchant_binding SET consumed_ms=? WHERE id=?', [now, request.id]);
    await db.execute('UPDATE ar_user_merchant_binding SET expires_ms=? WHERE user_id=? AND id<>? AND consumed_ms IS NULL', [now, user.id, request.id]);
    const reason = String(request.reason || '最高管理员分配商户').slice(0, 255);
    await db.insert('ar_role_audit', { actor_user_id: actor.id, target_user_id: user.id, previous_role: user.role, next_role: request.target_role, source: 'merchant-transfer', reason, merchant_id: merchant.id });
    await db.insert('ar_merchant_audit', { actor_user_id: actor.id, merchant_id: merchant.id, previous_merchant_id: request.source_merchant_id, target_id: user.id, action: 'USER_TRANSFERRED', reason, created_ms: now });
    const resolved = await findIdentityUser(db, Number(user.id), entry.appId);
    if (!resolved) throw new ApiError(409, '商户绑定未完成，请重试');
    requireAccountScope(resolved);
    return { ...resolved, binding_merchant: { id: Number(merchant.id), code: merchant.code, name: merchant.name, status: merchant.status, origin: merchant.origin, appId: merchant.app_id, configId: Number(merchant.active_config_id) } };
  }
  private async assignMerchant(ctx: Context): Promise<Row> {
    if (!entryMerchant()) throw new ApiError(503, '请通过商户管理入口操作');
    const principal = await this.authenticate(ctx); requireRoot(principal.user);
    const userId = Number(ctx.params.id), merchantId = Number(ctx.body.merchantId), role = ctx.body.role;
    const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason.trim().slice(0, 255) : '';
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(merchantId) || merchantId < 1 || !['user', 'manager', 'adminer'].includes(role) || !reason) throw new ApiError(422, '请选择账号、目标商户和身份，并填写分配原因');
    const token = randomBytes(32).toString('hex'), now = this.now(), expires = now + 30 * 60_000;
    return this.db.transaction(async db => {
      if (!await db.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
      const actor = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
      if (!actor) throw new ApiError(403, '最高管理员身份已失效');
      requireRoot(actor);
      const rawUser = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [userId]);
      const user = rawUser ? await loadAccountPermissions(db, rawUser) : null;
      if (!user) throw new ApiError(404, '用户不存在');
      if (userRole(user) === 'root' || Number(user.id) === Number(actor.id)) throw new ApiError(403, '不能分配最高管理员或当前账号');
      const merchant = await db.one('SELECT * FROM ar_merchant WHERE id=? FOR UPDATE', [merchantId]);
      if (!merchant || merchant.status !== 'active') throw new ApiError(422, '目标商户不存在或尚未开放服务');
      if (Number(user.merchant_id) === merchantId) throw new ApiError(409, '该账号已属于目标商户，请直接管理身份');
      const sourceIdentity = await db.one("SELECT * FROM ar_user_wechat_identity WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1", [userId]);
      if (!sourceIdentity) throw new ApiError(409, '请该用户先使用原微信身份登录');
      await this.assertUserTransferable(db, userId);
      await db.execute('UPDATE ar_user_merchant_binding SET expires_ms=? WHERE user_id=? AND consumed_ms IS NULL', [now, userId]);
      await db.insert('ar_user_merchant_binding', { id: createHash('sha256').update(token).digest('hex'), user_id: userId, source_merchant_id: user.merchant_id, source_appid: sourceIdentity.appid, source_auth_version: Number(user.auth_version ?? 0), target_merchant_id: merchantId, target_role: role, created_by: actor.id, reason, created_ms: now, expires_ms: expires, consumed_ms: null });
      return { user: publicUser(user), binding: { token, merchantId, appId: merchant.app_id, origin: merchant.origin, expiresAt: new Date(expires).toISOString() } };
    });
  }
  private async confirmMerchantBinding(ctx: Context): Promise<Row> {
    const entry = entryMerchant();
    if (!entry) throw new ApiError(503, '请通过原商户小程序确认分配');
    const principal = await this.authenticateBearer(ctx), token = ctx.body.bindToken;
    if (userRole(principal.user) === 'root') throw new ApiError(403, '请由被分配账号本人在原商户小程序确认');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(422, '商户绑定凭据无效');
    return this.db.transaction(async db => {
      if (!await db.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
      const request = await db.one('SELECT * FROM ar_user_merchant_binding WHERE id=? FOR UPDATE', [createHash('sha256').update(token).digest('hex')]);
      const now = this.now();
      if (!this.validInvitation(request, now)) throw new ApiError(409, '商户绑定凭据已失效，请联系最高管理员重新分配');
      if (Number(request.user_id) !== Number(principal.user.id)) throw new ApiError(403, '请由被分配账号本人在原商户小程序确认');
      const user = await findIdentityUser(db, Number(principal.user.id), entry.appId, principal.identityId, true);
      if (!user || Number(user.auth_version ?? 0) !== principal.authVersion) throw new ApiError(401, '原账号归属已变更，请重新登录');
      requireAccountScope(user);
      if (userRole(user) === 'root' || (user.merchant_id ?? null) !== (request.source_merchant_id ?? null)
        || Number(user.auth_version) !== request.source_auth_version) throw new ApiError(403, '原账号已无法确认该分配');
      if (request.source_appid !== entry.appId) throw new ApiError(403, '请在原账号的小程序确认分配');
      await this.assertUserTransferable(db, Number(user.id));
      const target = await db.one('SELECT * FROM ar_merchant WHERE id=?', [request.target_merchant_id]);
      if (!target || target.status !== 'active') throw new ApiError(409, '目标商户暂未开放服务');
      if (!Number(request.source_confirmed_ms)) await db.execute('UPDATE ar_user_merchant_binding SET source_confirmed_ms=? WHERE id=?', [now, request.id]);
      return { binding: { merchantId: Number(target.id), appId: target.app_id, origin: target.origin, expiresAt: new Date(Number(request.expires_ms)).toISOString() } };
    });
  }
  async refresh(value: unknown): Promise<Row> { return this.response(await this.verify(value, 'refresh')); }
  readonly authenticateBearer = async (ctx: Context): Promise<RentalPrincipal> => {
    const header = ctx.req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) { ctx.res.setHeader('WWW-Authenticate', 'Bearer'); throw new ApiError(401, '请先登录'); }
    const user = await this.verify(match[1], 'access');
    return { user, appid: this.appId, openid: user.openid, ...(entryMerchant() ? { merchantId: (currentMerchant() ?? entryMerchant())!.id, authVersion: Number(user.auth_version ?? 0), identityId: Number(user.identity_id) } : {}) };
  };
  readonly authenticate = async (ctx: Context): Promise<RentalPrincipal> => {
    if (ctx.req.headers.authorization === undefined && this.webAuthenticate) return this.webAuthenticate(ctx);
    return this.authenticateBearer(ctx);
  };
  private async employeeUsers(ctx: Context, principal: RentalPrincipal): Promise<Row> {
    const scope = ctx.query.scope ?? 'employees';
    if (!['employees', 'platform'].includes(scope)) throw new ApiError(422, '用户查询范围无效');
    const merchant = currentMerchant();
    if (!merchant) throw new ApiError(503, '请先选择管理商户');
    const page = Math.max(1, Math.min(1000000, Math.floor(Number(ctx.query.page)) || 1)), pageSize = 20;
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.trim().slice(0, 100) : '';
    return this.db.transaction(async db => {
      const raw = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
      if (!raw) throw new ApiError(403, '账号已失效');
      const actor = await loadAccountPermissions(db, raw);
      requireUserAdmin(actor); requireMerchantManagementScope(actor);
      if (Number(actor.auth_version ?? 0) !== principal.authVersion) throw new ApiError(401, '账号授权已变更，请重新登录');
      if (scope === 'platform') requireRoot(actor);
      const phoneApp = merchant.appId;
      const from = ` FROM ar_user u LEFT JOIN ar_user_phone p ON p.user_id=u.id AND p.appid=? AND p.verified_ms>0
        ${scope === 'employees' ? "INNER JOIN ar_merchant_membership m ON m.user_id=u.id AND m.status='active'" : ''}
        WHERE u.role<>'root' AND u.id<>? AND ${scope === 'employees' ? 'm.merchant_id=?' : "NOT EXISTS(SELECT 1 FROM ar_merchant_membership x WHERE x.user_id=u.id AND x.status='active') AND EXISTS(SELECT 1 FROM ar_user_wechat_identity i WHERE i.user_id=u.id AND i.appid=? AND i.status='active')"}`;
      const parameters: unknown[] = [phoneApp, actor.id, scope === 'employees' ? merchant.id : merchant.appId];
      const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
      const filter = search ? ' AND (u.nickname LIKE ? OR p.phone_e164 LIKE ? OR CAST(u.id AS CHAR)=?)' : '';
      if (search) parameters.push(pattern, pattern, search);
      const count = await db.one('SELECT COUNT(*) AS total' + from + filter, parameters);
      const rows = await db.query(`SELECT u.*,p.phone_e164 AS verified_phone,p.country_code AS phone_country_code${scope === 'employees' ? ',m.role AS member_role,m.merchant_id AS member_merchant_id' : ''}${from}${filter} ORDER BY u.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, parameters);
      return { scope, items: rows.map(row => {
        const user = { ...row, role: scope === 'employees' ? row.member_role : 'user', merchant_id: scope === 'employees' ? Number(row.member_merchant_id) : null };
        return { ...directoryUser(user), allowedRoles: assignableRoles(actor, user) };
      }), page, pageSize, total: Number(count?.total || 0) };
    });
  }
  private async employeeSetRole(ctx: Context, principal: RentalPrincipal): Promise<Row> {
    const targetId = Number(ctx.params.id), nextRole = ctx.body.role, merchant = currentMerchant();
    if (!merchant) throw new ApiError(503, '请先选择管理商户');
    if (!Number.isSafeInteger(targetId) || targetId < 1 || !['manager', 'user', 'adminer'].includes(nextRole)) throw new ApiError(422, '用户编号或角色无效');
    return this.db.transaction(async db => {
      if (!await db.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
      const actorRaw = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]);
      if (!actorRaw) throw new ApiError(403, '用户管理权限已变更');
      const actor = await loadAccountPermissions(db, actorRaw);
      requireUserAdmin(actor); requireMerchantManagementScope(actor);
      if (Number(actor.auth_version ?? 0) !== principal.authVersion) throw new ApiError(401, '账号授权已变更，请重新登录');
      const raw = await db.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [targetId]);
      if (!raw) throw new ApiError(404, '用户不存在');
      const target = await loadAccountPermissions(db, raw);
      if (target.merchant_id != null && Number(target.merchant_id) !== merchant.id) throw new ApiError(409, '该员工属于其他商户，请先签发商户分配并由本人确认');
      if (actor.role !== 'root' && target.merchant_id == null) throw new ApiError(403, '只能管理本商户已有员工');
      if (!assignableRoles(actor, target).includes(nextRole)) throw new ApiError(403, '不能修改自身、同级或更高身份，也不能授予超出权限的身份');
      if (nextRole !== 'user' && target.merchant_id == null && !await db.one("SELECT id FROM ar_user_wechat_identity WHERE user_id=? AND appid=? AND status='active'", [targetId, merchant.appId])) throw new ApiError(409, '请通过目标小程序的商户分配确认身份');
      if (target.role === nextRole && nextRole !== 'user') return { ...publicUser(target), allowedRoles: assignableRoles(actor, target) };
      const now = this.now();
      await this.membership(db, targetId, merchant.id, nextRole, now);
      await db.execute('UPDATE ar_user SET role=?,merchant_id=?,auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [nextRole, nextRole === 'user' ? null : merchant.id, targetId]);
      await this.invalidateAuthorizations(db, targetId, now);
      await db.insert('ar_role_audit', { actor_user_id: actor.id, target_user_id: targetId, previous_role: target.role, next_role: nextRole, source: 'api', reason: typeof ctx.body.reason === 'string' ? ctx.body.reason.trim().slice(0, 255) || '管理员更新员工角色' : '管理员更新员工角色', merchant_id: merchant.id });
      const updated = { ...target, role: nextRole, merchant_id: nextRole === 'user' ? null : merchant.id };
      return { ...publicUser(updated), allowedRoles: assignableRoles(actor, updated) };
    });
  }
  private async users(ctx: Context): Promise<Row> {
    const principal = await this.authenticate(ctx);
    if (!legacyAccountAdapter(principal.user)) return this.employeeUsers(ctx, principal);
    requireUserAdmin(principal.user);
    requireMerchantManagementScope(principal.user);
    const page = Math.max(1, Math.min(1000000, Math.floor(Number(ctx.query.page)) || 1)), pageSize = 20;
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.trim().slice(0, 100) : '';
    const searchSql = search ? ' AND (u.nickname LIKE ? OR u.tel LIKE ? OR p.phone_e164 LIKE ? OR CAST(u.id AS CHAR)=?)' : '';
    const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
    const merchant = currentMerchant();
    const prefix = merchant ? [merchant.appId, merchant.id, principal.user.id] : [this.appId, principal.user.id];
    const values = search ? [...prefix, pattern, pattern, pattern, search] : prefix;
    const from = merchant ? ' FROM ar_user u LEFT JOIN ar_user_phone p ON p.user_id=u.id AND p.appid=? AND p.verified_ms>0 WHERE u.merchant_id=? AND u.id<>?'
      : ' FROM ar_user u LEFT JOIN ar_user_phone p ON p.user_id=u.id AND p.appid=u.appid AND p.verified_ms>0 WHERE u.appid=? AND u.id<>?';
    const count = await this.db.one('SELECT COUNT(*) AS total' + from + searchSql, values);
    const items = await this.db.query(`SELECT u.*,p.phone_e164 AS verified_phone,p.country_code AS phone_country_code${from}${searchSql} ORDER BY u.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values);
    return { items: items.map(user => ({ ...directoryUser(user), allowedRoles: assignableRoles(principal.user, user) })), page, pageSize, total: Number(count?.total || 0) };
  }
  private async setRole(ctx: Context): Promise<Row> {
    const principal = await this.authenticate(ctx);
    if (!legacyAccountAdapter(principal.user)) return this.employeeSetRole(ctx, principal);
    requireUserAdmin(principal.user);
    requireMerchantManagementScope(principal.user);
    const targetId = Number(ctx.params.id), nextRole = ctx.body.role;
    if (!Number.isSafeInteger(targetId) || targetId < 1 || !['manager', 'user', 'adminer'].includes(nextRole)) throw new ApiError(422, '用户编号或角色无效');
    const result = await this.db.transaction(async tx => {
      if (!await tx.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
      const merchant = currentMerchant();
      const actor = merchant ? await tx.one('SELECT * FROM ar_user WHERE id=? FOR UPDATE', [principal.user.id]) : await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [principal.user.id, this.appId]);
      if (!actor) throw new ApiError(403, '用户管理权限已变更，请重新登录');
      requireUserAdmin(actor);
      if (merchant) {
        requireMerchantManagementScope(actor);
        if (Number(actor.auth_version ?? 0) !== principal.authVersion) throw new ApiError(401, '账号归属已变更，请重新登录');
      }
      const target = merchant ? await tx.one('SELECT * FROM ar_user WHERE id=? AND merchant_id=? FOR UPDATE', [targetId, merchant.id]) : await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [targetId, this.appId]);
      if (!target) throw new ApiError(404, '用户不存在');
      if (!assignableRoles(actor, target).includes(nextRole)) throw new ApiError(403, '不能修改自身、同级或更高身份，也不能授予超出权限的身份');
      if (target.role === nextRole) return { user: target, actor };
      await tx.execute('UPDATE ar_user SET role=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [nextRole, targetId]);
      await tx.insert('ar_role_audit', { actor_user_id: principal.user.id, target_user_id: targetId, previous_role: target.role, next_role: nextRole, source: 'api', reason: typeof ctx.body.reason === 'string' ? ctx.body.reason.trim().slice(0, 255) || '管理员更新角色' : '管理员更新角色', ...(merchant ? { merchant_id: merchant.id } : {}) });
      return { user: { ...target, role: nextRole }, actor };
    });
    return { ...publicUser(result.user), allowedRoles: assignableRoles(result.actor, result.user) };
  }
  registerAuth(router: ApiRouter): void {
    const route = (method: string, path: string, handler: (ctx: Context) => Promise<Row>) => router.add(method, path, ctx => { ctx.res.setHeader('Cache-Control', 'no-store'); return handler(ctx); });
    route('POST', '/v2/rental/auth/login', async ctx => ({ success: true, data: await this.login(ctx.body.code, ctx.body.bindToken) }));
    route('POST', '/v2/rental/auth/refresh', async ctx => ({ success: true, data: await this.refresh(ctx.body.refreshToken) }));
    route('POST', '/v2/rental/auth/merchant-binding/confirm', ctx => this.confirmMerchantBinding(ctx));
    route('GET', '/v2/rental/admin/users', ctx => this.users(ctx));
    route('PUT', '/v2/rental/admin/users/:id/role', ctx => this.setRole(ctx));
    route('POST', '/v2/rental/admin/users/:id/merchant', ctx => this.assignMerchant(ctx));
  }
}
