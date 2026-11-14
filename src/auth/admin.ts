import type { Database } from '../core/database';
import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import { maskedPhone, normalizePhoneInput } from './phone';

export async function bootstrapRoot(db: Database, userId: number, appId: string, expectedVerifiedPhone?: string): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId < 1 || !/^wx[0-9a-f]{16}$/i.test(appId)) throw new ApiError(422, '用户编号或 AppID 无效');
  if (!expectedVerifiedPhone) throw new ApiError(422, 'root 初始化必须核实微信已验证手机号');
  const phone = normalizePhoneInput(expectedVerifiedPhone);
  await db.transaction(async tx => {
    const guard = await tx.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE');
    if (!guard) throw new ApiError(503, '请先初始化数据库');
    const root = await tx.one("SELECT id FROM ar_user WHERE role='root' LIMIT 1");
    if (root) throw new ApiError(409, '系统已有 root，请由现有 root 管理权限');
    const user = await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [userId, appId]);
    if (!user) throw new ApiError(404, '当前小程序用户不存在，请先登录小程序');
    if (!await tx.one('SELECT user_id FROM ar_user_phone WHERE user_id=? AND appid=? AND phone_e164=? AND verified_ms>0 FOR UPDATE', [userId, appId, phone])) throw new ApiError(409, '已验证手机号绑定发生变化，请重新核实');
    await tx.execute("UPDATE ar_user SET role='root',updated_at=CURRENT_TIMESTAMP(3) WHERE id=?", [userId]);
    await tx.insert('ar_role_audit', { actor_user_id: null, target_user_id: userId, previous_role: user.role, next_role: 'root', source: 'console-bootstrap', reason: 'Explicit initial root bootstrap from server console' });
  });
}

/** Full phone numbers remain internal; operators receive only a masked match. */
export async function findUserByVerifiedPhone(db: Database, phone: string, appId: string): Promise<{ userId: number; maskedNumber: string; role: string }> {
  if (!/^wx[0-9a-f]{16}$/i.test(appId)) throw new ApiError(422, 'AppID 无效');
  const normalized = normalizePhoneInput(phone);
  const row = await db.one('SELECT p.user_id,p.phone_e164,p.country_code,u.role FROM ar_user_phone p INNER JOIN ar_user u ON u.id=p.user_id AND u.appid=p.appid WHERE p.appid=? AND p.phone_e164=? AND p.verified_ms>0', [appId, normalized]);
  if (!row) throw new ApiError(404, '未找到当前小程序中已授权验证该手机号的账号，请先在小程序完成手机号授权');
  return { userId: Number(row.user_id), maskedNumber: maskedPhone(row.phone_e164, row.country_code), role: row.role };
}

export async function bootstrapRootByPhone(db: Database, phone: string, appId: string): Promise<{ maskedNumber: string; role: 'root' }> {
  const normalized = normalizePhoneInput(phone);
  const match = await findUserByVerifiedPhone(db, normalized, appId);
  // bootstrapRoot takes guard -> user locks, then rechecks the immutable verified binding.
  await bootstrapRoot(db, match.userId, appId, normalized);
  return { maskedNumber: match.maskedNumber, role: 'root' };
}

/** ROOT_PHONE authorizes only a server-verified binding, and only the first root. */
export async function initializeRootFromVerifiedPhone(db: Database, user: Row, appId: string, configuredPhone: string): Promise<Row> {
  if (user.role === 'root' || !configuredPhone) return user;
  if (!await db.one('SELECT user_id FROM ar_user_phone WHERE user_id=? AND appid=? AND phone_e164=? AND verified_ms>0', [user.id, appId, configuredPhone])) return user;
  const existingRoot = await db.one("SELECT id FROM ar_user WHERE role='root' LIMIT 1");
  if (existingRoot) return Number(existingRoot.id) === Number(user.id) ? { ...user, role: 'root' } : user;
  // This runs after login/binding transactions, preserving guard -> user lock order.
  return db.transaction(async tx => {
    if (!await tx.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE')) throw new ApiError(503, '请先初始化数据库');
    const root = await tx.one("SELECT id FROM ar_user WHERE role='root' LIMIT 1");
    if (root) return Number(root.id) === Number(user.id) ? { ...user, role: 'root' } : user;
    const current = await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [user.id, appId]);
    if (!current) throw new ApiError(401, '当前微信账号已失效，请重新登录');
    if (!await tx.one('SELECT user_id FROM ar_user_phone WHERE user_id=? AND appid=? AND phone_e164=? AND verified_ms>0 FOR UPDATE', [current.id, appId, configuredPhone])) return current;
    await tx.execute("UPDATE ar_user SET role='root',updated_at=CURRENT_TIMESTAMP(3) WHERE id=?", [current.id]);
    await tx.insert('ar_role_audit', { actor_user_id: null, target_user_id: current.id, previous_role: current.role, next_role: 'root', source: 'env-root-bootstrap', reason: 'Initial root bootstrap from verified phone matched against ROOT_PHONE' });
    return { ...current, role: 'root' };
  });
}
