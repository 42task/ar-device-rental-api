import type { RentalAuth } from '../auth';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { requireManager } from '../core/roles';
import type { ApiRouter } from '../core/router';
import { requireRentalHistoryScope } from './rental-history-scope';

const eventFields: ReadonlyMap<string, readonly string[]> = new Map([
  ['RESERVED', ['venueId', 'venuePriceVersion', 'useFeeCents', 'depositCents']],
  ['PAYMENT_CONFIRMED', []],
  ['LATE_PAYMENT_REFUND', []],
  ['PAYMENT_CLOSED', []],
  ['LOCAL_ORDER_CANCELLED', []],
  ['RENTAL_ENDED', ['refundMode', 'refundAmountCents', 'reason']],
  ['REFUND_SUCCESS', ['refundAmountCents']],
  ['REFUND_EXCEPTION', ['status']],
]);

function eventDetails(event: string, details: unknown): Record<string, number | string> {
  let value = details;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, number | string> = {};
  for (const field of eventFields.get(event) ?? []) {
    const fieldValue = source[field];
    if (typeof fieldValue === 'number' || typeof fieldValue === 'string') result[field] = fieldValue;
  }
  return result;
}

export function registerRentalEvents(router: ApiRouter, db: Database, auth: RentalAuth): void {
  router.add('GET', '/v2/rental/admin/rental-events', async ctx => {
    const merchant = await requireRentalHistoryScope(ctx, auth, requireManager);
    const requestedPage = Number(ctx.query.page);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1000000) : 1;
    const pageSize = 20;
    const { event, rentalId } = ctx.query;
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.trim().slice(0, 100) : '';
    const where = ['o.merchant_id=?', 'o.appid=?'];
    const values: unknown[] = [merchant.id, merchant.appId];

    if (event !== undefined && event !== '') {
      if (typeof event !== 'string' || !eventFields.has(event)) throw new ApiError(422, '租赁事件类型无效');
      where.push('e.event=?');
      values.push(event);
    }
    if (rentalId !== undefined && rentalId !== '') {
      if (typeof rentalId !== 'string' || !/^[1-9][0-9]*$/.test(rentalId) || !Number.isSafeInteger(Number(rentalId))) throw new ApiError(422, '订单编号无效');
      where.push('o.id=?');
      values.push(Number(rentalId));
    }
    if (search) {
      const pattern = '%' + search.replace(/[!%_]/g, '!$&') + '%';
      where.push("(o.device_uuid LIKE ? ESCAPE '!' OR o.device_sn LIKE ? ESCAPE '!' OR o.device_name LIKE ? ESCAPE '!' OR CAST(o.id AS CHAR)=?)");
      values.push(pattern, pattern, pattern, search);
    }

    const from = `FROM ar_rental_event e INNER JOIN ar_rental_order o ON o.id=e.rental_id AND o.merchant_id=e.merchant_id WHERE ${where.join(' AND ')}`;
    const count = await db.one(`SELECT COUNT(*) AS total ${from}`, values);
    const rows = await db.query(`SELECT e.id,e.rental_id,e.actor_user_id,e.event,e.details,e.created_ms,o.device_name,o.device_uuid,o.device_sn
      ${from} ORDER BY e.created_ms DESC,e.id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    const items = rows.map(row => ({
      id: Number(row.id), rentalId: Number(row.rental_id), deviceName: row.device_name, uuid: row.device_uuid ?? null, sn: row.device_sn ?? null,
      event: row.event, createdAt: new Date(Number(row.created_ms)).toISOString(),
      actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id), details: eventDetails(row.event, row.details),
    }));
    return { items, page, pageSize, total: Number(count?.total ?? 0) };
  });
}
