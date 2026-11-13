import type { RentalAuth } from '../auth';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { requireManager } from '../core/roles';
import type { ApiRouter } from '../core/router';
import type { RentalService } from '../rentals/service';

const statuses = new Set(['PENDING_PAYMENT', 'ACTIVE', 'ENDED', 'CANCELLED', 'COMPENSATING']);

/** Read-only management queries; financial transitions stay in RentalService. */
export function registerManagement(router: ApiRouter, db: Database, auth: RentalAuth, rentals: RentalService): void {
  const principal = async (ctx: Context) => {
    const identity = await auth.authenticate(ctx);
    requireManager(identity.user);
    return identity;
  };
  router.add('GET', '/v2/rental/admin/overview', async ctx => {
    const identity = await principal(ctx);
    const [deviceCounts, orderCounts] = await Promise.all([
      db.one(`SELECT COUNT(*) AS total,
        COALESCE(SUM(s.device_id IS NULL AND COALESCE(c.enabled,0)=1),0) AS available,
        COALESCE(SUM(s.device_id IS NULL AND COALESCE(c.enabled,0)=0),0) AS disabled,
        COALESCE(SUM(s.state='RESERVED'),0) AS reserved,
        COALESCE(SUM(s.state='RENTED'),0) AS rented,
        COALESCE(SUM(s.state='SETTLING'),0) AS settling
        FROM ar_device d LEFT JOIN ar_rental_config c ON c.device_id=d.id LEFT JOIN ar_rental_slot s ON s.device_id=d.id`),
      db.one(`SELECT COUNT(*) AS total, COALESCE(SUM(status='ACTIVE'),0) AS active,
        COALESCE(SUM(refund_amount_cents>0 AND refund_status IS NOT NULL AND refund_status<>'SUCCESS'),0) AS refunding
        FROM ar_rental_order WHERE appid=?`, [identity.appid]),
    ]);
    const numbers = (row: Row | null, keys: string[]) => Object.fromEntries(keys.map(key => [key, Number(row?.[key] || 0)]));
    return { devices: numbers(deviceCounts, ['total', 'available', 'reserved', 'rented', 'settling', 'disabled']), orders: numbers(orderCounts, ['total', 'active', 'refunding']), paymentsEnabled: rentals.paymentReady() };
  });
  router.add('GET', '/v2/rental/admin/orders', async ctx => {
    const identity = await principal(ctx);
    const requested = Number(ctx.query.page);
    const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 1000000) : 1;
    const pageSize = 20;
    const status = ctx.query.status;
    if (status !== undefined && status !== '' && (typeof status !== 'string' || !statuses.has(status))) throw new ApiError(422, '订单状态无效');
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.trim().slice(0, 100) : '';
    const where = ['appid=?'];
    const values: unknown[] = [identity.appid];
    if (status) { where.push('status=?'); values.push(status); }
    if (search) {
      where.push('(device_uuid LIKE ? OR device_name LIKE ? OR CAST(id AS CHAR)=?)');
      const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
      values.push(pattern, pattern, search);
    }
    const filter = where.join(' AND ');
    const count = await db.one('SELECT COUNT(*) AS total FROM ar_rental_order WHERE ' + filter, values);
    const items = await db.query(`SELECT * FROM ar_rental_order WHERE ${filter} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values);
    return { items: items.map(row => rentals.view(row, identity)), page, pageSize, total: Number(count?.total || 0) };
  });
}
