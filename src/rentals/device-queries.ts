import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { deviceIdentifierKey, isDeviceUuid, retiredDeviceIdentifier, type DeviceIdentifierKind } from '../devices/identifiers';
import { quoteForDevice } from './quotes';

export interface DevicePageQuery { merchantId?: number; venueId?: number; allMerchants?: boolean; search: string; page: number; pageSize: number }
export interface DeviceSummaryRows { device: Row; venue: Row; pricing: Row; state: string; canDelete: boolean }

const unsettledRentalStatus = `(status IN ('PENDING_PAYMENT','ACTIVE')
  OR ((status='COMPENSATING' OR refund_amount_cents>0) AND (refund_status IS NULL OR refund_status<>'SUCCESS')))`;

export async function hasUnsettledDeviceOrders(db: Database, deviceId: number): Promise<boolean> {
  return !!await db.one(`SELECT id FROM ar_rental_order WHERE device_id=? AND ${unsettledRentalStatus} LIMIT 1`, [deviceId]);
}

export const legacyUuidConflictColumn = `(d.uuid IS NULL AND (EXISTS (
  SELECT 1 FROM ar_device uuid_owner
  WHERE uuid_owner.current_uuid IN (d.sn,LOWER(d.sn)) AND uuid_owner.uuid=d.sn
) OR EXISTS (
  SELECT 1 FROM ar_device_retired_identifier retired
  WHERE retired.kind='uuid' AND retired.identifier IN (d.sn,LOWER(d.sn)) AND retired.original_identifier=d.sn
))) AS legacy_uuid_conflict`;

export async function findDeviceRegistration(db: Database, identifier: string, kind: DeviceIdentifierKind): Promise<{ registration: Row | null; retired: boolean }> {
  const key = deviceIdentifierKey(identifier, kind);
  const byUuid = kind === 'uuid' ? await db.one('SELECT * FROM ar_device WHERE current_uuid=?', [key]) : null;
  if (byUuid?.uuid === identifier) return { registration: byUuid, retired: false };
  const retiredUuid = kind === 'uuid' ? await retiredDeviceIdentifier(db, 'uuid', key) : null;
  if (retiredUuid?.original_identifier === identifier && Number(retiredUuid.device_id) !== Number(byUuid?.id)) {
    return { registration: null, retired: true };
  }
  // An exact historical SN alias keeps its original target when a UUID
  // becomes newly equivalent after case normalization.
  const bySn = await db.one(`SELECT d.*,${legacyUuidConflictColumn} FROM ar_device d WHERE d.current_sn=?`, [identifier]);
  if (bySn) return { registration: bySn, retired: false };
  const retiredSn = await retiredDeviceIdentifier(db, 'sn', identifier);
  if (retiredSn || (retiredUuid && !byUuid)) return { registration: null, retired: true };
  return { registration: byUuid, retired: false };
}
/** A management read model: one count plus one joined page, regardless of the
 * number of devices. Authorization belongs to the caller, mutations never do.
 */
export async function readDevicePage(db: Database, query: DevicePageQuery): Promise<{ items: DeviceSummaryRows[]; total: number }> {
  const { merchantId, venueId, allMerchants = false, search, page, pageSize } = query;
  if (merchantId !== undefined && (!Number.isSafeInteger(merchantId) || merchantId < 1)) throw new ApiError(503, '设备商户范围无效');
  if (venueId !== undefined && (!Number.isSafeInteger(venueId) || venueId < 1)) throw new ApiError(503, '设备景点范围无效');
  const scoped = merchantId !== undefined;
  if (allMerchants && (scoped || venueId !== undefined)) throw new ApiError(503, '设备查询范围冲突');
  const ownership = scoped || allMerchants;
  const predicates = ['d.deleted_ms IS NULL', ...(scoped ? ['d.merchant_id=?'] : []), ...(venueId !== undefined ? ['d.venue_id=?'] : [])];
  const uuidKey = isDeviceUuid(search) ? deviceIdentifierKey(search, 'uuid') : null;
  if (search) {
    const exactUuidMatch = uuidKey === null ? '' : ' OR d.current_uuid=?';
    predicates.push(`(d.uuid LIKE ? ESCAPE '=' OR d.sn LIKE ? ESCAPE '=' OR d.name LIKE ? ESCAPE '=' OR d.remark_name LIKE ? ESCAPE '='${exactUuidMatch})`);
  }
  const pattern = '%' + search.replace(/[=%_]/g, '=$&') + '%';
  const where = ' WHERE ' + predicates.join(' AND ');
  const values = [...(scoped ? [merchantId] : []), ...(venueId !== undefined ? [venueId] : []), ...(search ? [pattern, pattern, pattern, pattern] : []), ...(uuidKey === null ? [] : [uuidKey])];
  const [count, rows] = await Promise.all([
    db.one('SELECT COUNT(*) AS total FROM ar_device d' + where, values),
    db.query(`SELECT d.*,${legacyUuidConflictColumn},${allMerchants ? 'm.id AS merchant_record_id,m.name AS merchant_name,' : ''}v.id AS venue_record_id,v.merchant_id AS venue_merchant_id,v.name AS venue_name,
      v.address AS venue_address,v.description AS venue_description,v.status AS venue_status,
      v.use_fee_cents AS venue_use_fee_cents,v.deposit_cents AS venue_deposit_cents,v.version AS venue_version,
      c.device_id AS config_device_id,c.enabled AS config_enabled,c.version AS config_version,
      ${ownership ? 'c.merchant_id' : 'NULL'} AS config_merchant_id,
      s.device_id AS slot_device_id,s.rental_id AS slot_rental_id,s.state AS slot_state,
      ${ownership ? 's.merchant_id' : 'NULL'} AS slot_merchant_id,o.id AS rental_exists,
      ${ownership ? 'o.merchant_id' : 'NULL'} AS rental_merchant_id${allMerchants ? ',o.device_id AS rental_device_id' : ''},
      (s.device_id IS NULL AND NOT EXISTS (SELECT 1 FROM ar_rental_order WHERE device_id=d.id AND ${unsettledRentalStatus})) AS can_delete
      FROM ar_device d
      ${allMerchants ? 'LEFT JOIN ar_merchant m ON m.id=d.merchant_id' : ''}
      LEFT JOIN ar_venue v ON v.id=d.venue_id AND v.merchant_id=d.merchant_id
      LEFT JOIN ar_rental_config c ON c.device_id=d.id
      LEFT JOIN ar_rental_slot s ON s.device_id=d.id
      LEFT JOIN ar_rental_order o ON o.id=s.rental_id${where}
      ORDER BY d.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values),
  ]);
  const items = rows.map(row => {
    const ownerId = scoped ? merchantId : Number(row.merchant_id);
    if (allMerchants && (!Number.isSafeInteger(ownerId) || ownerId < 1 || row.merchant_record_id == null)) throw new ApiError(503, '设备商户归属不可用');
    if (row.venue_record_id == null) throw new ApiError(503, '设备场地配置不可用');
    if (ownership && Number(row.venue_merchant_id) !== ownerId) throw new ApiError(503, '设备场地归属不可用');
    if (ownership && row.config_device_id != null && Number(row.config_merchant_id) !== ownerId) throw new ApiError(503, '设备租赁配置暂时不可用');
    if (row.slot_device_id != null && (row.rental_exists == null || ownership && (Number(row.slot_merchant_id) !== ownerId || Number(row.rental_merchant_id) !== ownerId)
      || allMerchants && Number(row.rental_device_id) !== Number(row.id))) throw new ApiError(503, '设备租赁状态暂时无法确认');
    const venue = { id: row.venue_record_id, merchant_id: row.venue_merchant_id, name: row.venue_name, address: row.venue_address,
      description: row.venue_description, status: row.venue_status, use_fee_cents: row.venue_use_fee_cents, deposit_cents: row.venue_deposit_cents, version: row.venue_version };
    const pricing = quoteForDevice(row.config_device_id == null ? null : { enabled: row.config_enabled, version: row.config_version }, venue);
    return { device: row, venue, pricing, state: row.slot_device_id == null ? pricing.enabled ? 'AVAILABLE' : 'DISABLED' : String(row.slot_state), canDelete: Number(row.can_delete) === 1 };
  });
  return { items, total: Number(count?.total || 0) };
}
