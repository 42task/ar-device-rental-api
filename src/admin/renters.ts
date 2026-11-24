import type { RentalAuth } from '../auth';
import type { Database } from '../core/database';
import type { ApiRouter } from '../core/router';
import { ApiError } from '../core/errors';
import { deviceSn, deviceUuid } from '../devices/service';
import { requireRentalHistoryScope } from './rental-history-scope';

export function registerRenters(router: ApiRouter, db: Database, auth: RentalAuth): void {
  router.add('GET', '/v2/rental/admin/renters', async ctx => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    const merchant = await requireRentalHistoryScope(ctx, auth);
    const requested = Number(ctx.query.page);
    const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 1000000) : 1;
    const pageSize = 20;
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.trim().slice(0, 100) : '';
    const where = ['o.merchant_id=?', 'o.appid COLLATE utf8mb4_bin=?', 'o.started_ms IS NOT NULL', "o.status IN ('ACTIVE','ENDED')"];
    const parameters: unknown[] = [merchant.appId, merchant.id, merchant.appId];
    const hasUuid = ctx.query.deviceUuid !== undefined && ctx.query.deviceUuid !== '';
    const hasSn = ctx.query.deviceSn !== undefined && ctx.query.deviceSn !== '';
    if (hasUuid && hasSn) throw new ApiError(422, '请仅提供 UUID 或 SN');
    if (hasUuid) {
      where.push('o.device_uuid COLLATE utf8mb4_bin=?');
      parameters.push(deviceUuid(ctx.query.deviceUuid));
    }
    if (hasSn) {
      where.push('o.device_sn COLLATE utf8mb4_bin=?');
      parameters.push(deviceSn(ctx.query.deviceSn));
    }
    if (search) {
      where.push("(u.nickname LIKE ? ESCAPE '!' OR CAST(u.id AS CHAR)=?)");
      parameters.push('%' + search.replace(/[!%_]/g, '!$&') + '%', search);
    }
    // The order's original merchant owns its history. The current phone must
    // still belong to an active identity in the same app as the order.
    const from = `FROM ar_rental_order o
      INNER JOIN ar_user u ON u.id=o.user_id
      LEFT JOIN ar_user_phone p ON p.user_id=u.id AND p.appid=? AND p.verified_ms>0
        AND EXISTS (SELECT 1 FROM ar_user_wechat_identity i
          WHERE i.user_id=p.user_id AND i.appid=p.appid AND i.status='active'
            AND (p.identity_id IS NULL OR p.identity_id=i.id))
      WHERE ${where.join(' AND ')}`;
    return db.transaction(async tx => {
      const count = await tx.one(`SELECT COUNT(DISTINCT u.id) AS total ${from}`, parameters);
      const rows = await tx.query(`SELECT u.id,u.nickname,u.avatar,p.phone_e164,COUNT(*) AS rental_count,
        MIN(o.started_ms) AS first_rental_ms,MAX(o.started_ms) AS last_rental_ms ${from}
        GROUP BY u.id,u.nickname,u.avatar,p.phone_e164 ORDER BY last_rental_ms DESC,u.id DESC
        LIMIT ? OFFSET ?`, [...parameters, pageSize, (page - 1) * pageSize]);
      return {
        items: rows.map(row => ({
          id: Number(row.id),
          nickname: row.nickname ?? null,
          avatarUrl: row.avatar ?? null,
          phone: row.phone_e164 ?? null,
          rentalCount: Number(row.rental_count),
          firstRentalAt: new Date(Number(row.first_rental_ms)).toISOString(),
          lastRentalAt: new Date(Number(row.last_rental_ms)).toISOString(),
        })),
        page, pageSize, total: Number(count?.total ?? 0),
      };
    });
  });
}
