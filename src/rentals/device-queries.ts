import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { quoteForDevice } from './quotes';

export interface DevicePageQuery { merchantId?: number; search: string; page: number; pageSize: number }
export interface DeviceSummaryRows { device: Row; venue: Row; pricing: Row; state: string }
/** A management read model: one count plus one joined page, regardless of the
 * number of devices. Authorization belongs to the caller, mutations never do.
 */
export async function readDevicePage(db: Database, query: DevicePageQuery): Promise<{ items: DeviceSummaryRows[]; total: number }> {
  const { merchantId, search, page, pageSize } = query;
  if (merchantId !== undefined && (!Number.isSafeInteger(merchantId) || merchantId < 1)) throw new ApiError(503, '设备商户范围无效');
  const scoped = merchantId !== undefined;
  const predicates = [...(scoped ? ['d.merchant_id=?'] : []), ...(search ? ["(d.uuid LIKE ? ESCAPE '=' OR d.name LIKE ? ESCAPE '=')"] : [])];
  const pattern = '%' + search.replace(/[=%_]/g, '=$&') + '%';
  const where = predicates.length ? ' WHERE ' + predicates.join(' AND ') : '';
  const values = [...(scoped ? [merchantId] : []), ...(search ? [pattern, pattern] : [])];
  const [count, rows] = await Promise.all([
    db.one('SELECT COUNT(*) AS total FROM ar_device d' + where, values),
    db.query(`SELECT d.*,v.id AS venue_record_id,v.merchant_id AS venue_merchant_id,v.name AS venue_name,
      v.address AS venue_address,v.description AS venue_description,v.status AS venue_status,
      v.use_fee_cents AS venue_use_fee_cents,v.deposit_cents AS venue_deposit_cents,v.version AS venue_version,
      c.device_id AS config_device_id,c.enabled AS config_enabled,c.version AS config_version,
      ${scoped ? 'c.merchant_id' : 'NULL'} AS config_merchant_id,
      s.device_id AS slot_device_id,s.rental_id AS slot_rental_id,s.state AS slot_state,
      ${scoped ? 's.merchant_id' : 'NULL'} AS slot_merchant_id,o.id AS rental_exists,
      ${scoped ? 'o.merchant_id' : 'NULL'} AS rental_merchant_id
      FROM ar_device d
      LEFT JOIN ar_venue v ON v.id=d.venue_id AND v.merchant_id=d.merchant_id
      LEFT JOIN ar_rental_config c ON c.device_id=d.id
      LEFT JOIN ar_rental_slot s ON s.device_id=d.id
      LEFT JOIN ar_rental_order o ON o.id=s.rental_id${where}
      ORDER BY d.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values),
  ]);
  const items = rows.map(row => {
    if (row.venue_record_id == null) throw new ApiError(503, '设备场地配置不可用');
    if (scoped && row.config_device_id != null && Number(row.config_merchant_id) !== merchantId) throw new ApiError(503, '设备租赁配置暂时不可用');
    if (row.slot_device_id != null && (row.rental_exists == null || scoped && (Number(row.slot_merchant_id) !== merchantId || Number(row.rental_merchant_id) !== merchantId))) throw new ApiError(503, '设备租赁状态暂时无法确认');
    const venue = { id: row.venue_record_id, merchant_id: row.venue_merchant_id, name: row.venue_name, address: row.venue_address,
      description: row.venue_description, status: row.venue_status, use_fee_cents: row.venue_use_fee_cents, deposit_cents: row.venue_deposit_cents, version: row.venue_version };
    const pricing = quoteForDevice(row.config_device_id == null ? null : { enabled: row.config_enabled, version: row.config_version }, venue);
    return { device: row, venue, pricing, state: row.slot_device_id == null ? pricing.enabled ? 'AVAILABLE' : 'DISABLED' : String(row.slot_state) };
  });
  return { items, total: Number(count?.total || 0) };
}
