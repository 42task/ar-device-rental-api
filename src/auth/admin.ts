import type { Database } from '../core/database';
import { ApiError } from '../core/errors';

export async function bootstrapRoot(db: Database, userId: number, appId: string): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId < 1 || !/^wx[0-9a-f]{16}$/i.test(appId)) throw new ApiError(422, '用户编号或 AppID 无效');
  await db.transaction(async tx => {
    const guard = await tx.one('SELECT id FROM ar_admin_guard WHERE id=1 FOR UPDATE');
    if (!guard) throw new ApiError(503, '请先初始化数据库');
    const root = await tx.one("SELECT id FROM ar_user WHERE role='root' LIMIT 1");
    if (root) throw new ApiError(409, '系统已有 root，请由现有 root 管理权限');
    const user = await tx.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [userId, appId]);
    if (!user) throw new ApiError(404, '当前小程序用户不存在，请先登录小程序');
    await tx.execute("UPDATE ar_user SET role='root',updated_at=CURRENT_TIMESTAMP(3) WHERE id=?", [userId]);
    await tx.insert('ar_role_audit', { actor_user_id: null, target_user_id: userId, previous_role: user.role, next_role: 'root', source: 'console-bootstrap', reason: 'Explicit initial root bootstrap from server console' });
  });
}
