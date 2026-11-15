import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { currentMerchant, entryMerchant } from '../merchants/context';
import { userRole } from '../core/roles';

/** Explicit pre-merchant test/upgrade adapter, unavailable to production schemas. */
export function legacyAccountAdapter(user: Row): boolean {
  return !entryMerchant() && !('merchant_id' in user);
}

export async function loadAccountPermissions(db: Database, user: Row, userId = Number(user.id)): Promise<Row> {
  if (legacyAccountAdapter(user)) return { ...user, role: userRole(user) };
  if (!Number.isSafeInteger(userId) || userId < 1) throw new ApiError(503, '账号权限标识无效');
  if (user.role === 'root') return { ...user, id: userId, role: 'root', merchant_id: null, membership: null };
  const membership = await db.one('SELECT * FROM ar_merchant_membership WHERE user_id=?', [userId]);
  const active = membership?.status === 'active' && ['manager', 'adminer'].includes(membership.role);
  return { ...user, id: userId, role: active ? membership.role : 'user', merchant_id: active ? Number(membership.merchant_id) : null,
    membership: active ? membership : null, authorization_version: Number(membership?.authorization_version ?? 0) };
}

export function identityUser(row: Row): Row {
  return { ...row, source_appid: row.appid, appid: row.identity_appid, openid: row.identity_openid, unionid: row.identity_unionid ?? null };
}

export async function findIdentityUser(db: Database, userId: number, appId: string, identityId?: number, lock = false): Promise<Row | null> {
  const row = await db.one(`SELECT u.*,i.id AS identity_id,i.appid AS identity_appid,i.openid AS identity_openid,
    i.unionid AS identity_unionid,i.status AS identity_status FROM ar_user u
    INNER JOIN ar_user_wechat_identity i ON i.user_id=u.id
    WHERE u.id=? AND i.appid=?${identityId === undefined ? " AND i.status='active'" : ' AND i.id=?'}${lock ? ' FOR UPDATE' : ''}`,
  identityId === undefined ? [userId, appId] : [userId, appId, identityId]);
  return row ? loadAccountPermissions(db, identityUser(row), userId) : null;
}

/** A shared AppID authenticates one customer across its business merchants. */
export function requireAccountScope(user: Row): void {
  const entry = entryMerchant(), current = currentMerchant();
  if (!entry) return;
  if (user.identity_status !== undefined && user.identity_status !== 'active') throw new ApiError(401, '当前微信身份已失效，请重新登录');
  if (userRole(user) === 'root') return;
  if (current && current.appId !== entry.appId) throw new ApiError(403, '当前小程序无法访问此商户');
}

/** Consumer access never grants the account's staff role in another merchant. */
export function requireMerchantManagementScope(user: Row): void {
  requireAccountScope(user);
  const merchant = currentMerchant();
  if (!merchant && !legacyAccountAdapter(user)) throw new ApiError(503, '缺少商户管理范围');
  if (merchant && userRole(user) !== 'root' && Number(user.merchant_id) !== merchant.id) throw new ApiError(403, '当前账号无权管理此商户');
}
