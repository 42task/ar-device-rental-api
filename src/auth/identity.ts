import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { currentMerchant, entryMerchant } from '../merchants/context';
import { userRole } from '../core/roles';

export function identityUser(row: Row): Row {
  return { ...row, source_appid: row.appid, appid: row.identity_appid, openid: row.identity_openid, unionid: row.identity_unionid ?? null };
}

export async function findIdentityUser(db: Database, userId: number, appId: string, identityId?: number, lock = false): Promise<Row | null> {
  const row = await db.one(`SELECT u.*,i.id AS identity_id,i.appid AS identity_appid,i.openid AS identity_openid,
    i.unionid AS identity_unionid,i.status AS identity_status FROM ar_user u
    INNER JOIN ar_user_wechat_identity i ON i.user_id=u.id
    WHERE u.id=? AND i.appid=?${identityId === undefined ? " AND i.status='active'" : ' AND i.id=?'}${lock ? ' FOR UPDATE' : ''}`,
  identityId === undefined ? [userId, appId] : [userId, appId, identityId]);
  return row ? identityUser(row) : null;
}

/** Domain selection is an input to scope, never a grant of membership. */
export function requireAccountScope(user: Row): void {
  const entry = entryMerchant(), current = currentMerchant();
  if (!entry) return;
  if (user.identity_status !== undefined && user.identity_status !== 'active') throw new ApiError(401, '当前微信身份已失效，请重新登录');
  if (userRole(user) === 'root') return;
  if (Number(user.merchant_id) !== entry.id || current && current.id !== entry.id) throw new ApiError(403, '当前账号不属于此商户');
}
