import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';

export function rentalCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new ApiError(422, '金额必须为非负整数分');
  return value;
}
/** The caller supplies its transaction-bound database when reserving/changing a
 * device, so venue locking remains inside the existing device -> user -> venue
 * transaction and cannot drift into an independent query connection.
 */
export async function venueForDevice(db: Database, device: Row, lock = false): Promise<Row> {
  const venueId = Number(device.venue_id), merchantId = Number(device.merchant_id);
  if (!Number.isSafeInteger(venueId) || venueId < 1 || !Number.isSafeInteger(merchantId) || merchantId < 1) throw new ApiError(503, '设备场地归属未配置');
  const venue = await db.one('SELECT * FROM ar_venue WHERE id=? AND merchant_id=?' + (lock ? ' FOR UPDATE' : ''), [venueId, merchantId]);
  if (!venue) throw new ApiError(503, '设备场地配置不可用');
  return venue;
}
/** Device configuration controls availability/revision; all money comes from
 * the venue. Old ar_rental_config money columns are deliberately never read.
 */
export function quoteForDevice(config: Row | null, venue: Row): Row {
  return { enabled: !!Number(config?.enabled || 0) && venue.status === 'active', deviceEnabled: !!Number(config?.enabled || 0),
    useFeeCents: Number(venue.use_fee_cents), depositCents: Number(venue.deposit_cents), totalCents: Number(venue.use_fee_cents) + Number(venue.deposit_cents),
    version: Number(config?.version || 0), venueId: Number(venue.id), venueName: venue.name, venuePriceVersion: Number(venue.version) };
}
