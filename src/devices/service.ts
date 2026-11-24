import type { Row, Services } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { requireManager } from '../core/roles';
import { DEFAULT_DEVICE_TYPE, resolveDeviceType } from './types';
import { currentMerchant } from '../merchants/context';
import { loadAccountPermissions, requireMerchantManagementScope } from '../auth/identity';
import { assertDeviceIdentifierAvailable, deviceIdentifierKey, isDeviceUuid } from './identifiers';

export { DEFAULT_DEVICE_TYPE } from './types';

function deviceIdentifier(value: unknown, message: string): string {
  if (typeof value !== 'string' || !/^\S{1,255}$/u.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, message);
  }
  return value;
}

export function deviceUuid(value: unknown): string {
  if (typeof value !== 'string' || !isDeviceUuid(value)) throw new ApiError(422, '设备 UUID 格式无效');
  return value;
}

export function deviceSn(value: unknown): string {
  return deviceIdentifier(value, '设备 SN 无效');
}

export function registeredDeviceSn(value: unknown): string {
  if (!isNewDeviceSn(value)) throw new ApiError(422, '设备 SN 必须是 16 位数字');
  return value;
}

export function isNewDeviceSn(value: unknown): value is string {
  return typeof value === 'string' && value.length === 16 && /^[0-9]{16}$/.test(value);
}

export function deviceType(value: unknown): string {
  if (value === undefined) return DEFAULT_DEVICE_TYPE;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || [...value].length > 32 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备类型须为 1 至 32 个字符，且不含首尾空白或控制字符');
  }
  return resolveDeviceType(value);
}

export function deviceName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备名称须为 1 至 255 个字符，且不含控制字符');
  }
  return value.trim();
}

export function deviceRemarkName(value: unknown): string {
  if (typeof value !== 'string' || [...value.trim()].length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备备注名称最多 255 个字符，且不含控制字符');
  }
  return value.trim();
}

/** Devices belong to this application and are registered only after explicit confirmation. */
export class DeviceService {
  constructor(private readonly services: Services) {}

  static display(row: Row, management = false): Row {
    const merchantId = Number(row.merchant_id);
    const venueId = Number(row.venue_id);
    const uuid = row.uuid == null ? null : String(row.uuid);
    const sn = row.sn == null ? null : String(row.sn);
    return { id: Number(row.id), uuid, sn, name: String(row.name || uuid || sn || ''), type: resolveDeviceType(String(row.device_type || DEFAULT_DEVICE_TYPE)),
      ...(management ? { remarkName: String(row.remark_name ?? '') } : {}),
      ...(Number.isSafeInteger(merchantId) && merchantId > 0 ? { merchantId } : {}), ...(row.merchant_name ? { merchantName: String(row.merchant_name) } : {}),
      ...(Number.isSafeInteger(venueId) && venueId > 0 ? { venueId } : {}), ...(row.venue_name ? { venueName: String(row.venue_name) } : {}) };
  }

  async create(user: Row, input: Row): Promise<Row> {
    requireManager(user);
    requireMerchantManagementScope(user);
    const merchant = currentMerchant();
    const ownerId = merchant?.id ?? 1;
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new ApiError(422, '设备必须绑定有效商户');
    const checkOwnership = (row: Row): void => {
      if (merchant && Number(row.merchant_id) !== merchant.id) throw new ApiError(409, '设备属于其他商户，请使用对应小程序', 'MERCHANT_MISMATCH');
    };
    const uuid = input.uuid == null ? null : deviceUuid(input.uuid);
    const sn = input.sn == null ? null : deviceSn(input.sn);
    const identifier = uuid ?? sn;
    if (identifier === null) throw new ApiError(422, '请提供设备 UUID 或 SN');
    const findRegistration = async (db: Database): Promise<Row | null> => {
      const byUuid = uuid === null ? null : await db.one('SELECT * FROM ar_device WHERE current_uuid=? FOR UPDATE', [deviceIdentifierKey(uuid, 'uuid')]);
      const bySn = sn === null ? null : await db.one('SELECT * FROM ar_device WHERE current_sn=? FOR UPDATE', [sn]);
      const existing = byUuid ?? bySn;
      if (uuid !== null && sn !== null && existing && (!byUuid || !bySn || Number(byUuid.id) !== Number(bySn.id))) {
        throw new ApiError(409, 'UUID 或 SN 已被登记');
      }
      return existing;
    };
    const device_type = deviceType(input.type ?? input.device_type);
    const name = deviceName(input.name, identifier);
    const remark_name = input.remarkName === undefined ? undefined : deviceRemarkName(input.remarkName);
    const venueId = Number(input.venueId);
    if (!Number.isSafeInteger(venueId) || venueId < 1) throw new ApiError(422, '请选择设备所属场地');
    for (let attempt = 0; ; attempt++) {
      try {
        const result: { row: Row; created: boolean } = await this.services.db.transaction(async db => {
          // Deletion keeps registered identifiers claimed. Lock the record before the actor
          // and venue so ownership remains authoritative during re-registration.
          const existing = await findRegistration(db);
          const account = merchant
            ? await db.one('SELECT id,role,merchant_id,auth_version FROM ar_user WHERE id=? FOR UPDATE', [user.id])
            : await db.one('SELECT id,role FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [user.id, user.appid ?? '']);
          const currentUser = account ? await loadAccountPermissions(db, account) : null;
          if (!currentUser) throw new ApiError(403, '设备管理权限已变更，请重新登录');
          requireManager(currentUser);
          if (merchant && (Number(currentUser.auth_version) !== Number(user.auth_version)
            || currentUser.role !== 'root' && Number(currentUser.merchant_id) !== merchant.id)) throw new ApiError(403, '设备管理权限已变更，请重新登录');
          const venue = await db.one('SELECT * FROM ar_venue WHERE id=? AND merchant_id=? FOR UPDATE', [venueId, ownerId]);
          if (!venue || venue.status !== 'active') throw new ApiError(422, '请选择本商户已启用的场地');
          if (existing && (existing.deleted_ms == null || currentUser.role !== 'root')) checkOwnership(existing);
          if (existing && existing.deleted_ms == null) {
            if (Number(existing.venue_id) !== venueId) throw new ApiError(409, '设备已绑定其他场地，请通过设备设置调整');
            return { row: { ...existing, venue_name: venue.name }, created: false };
          }
          if (existing) await db.execute('UPDATE ar_device SET superseded=1 WHERE id=?', [existing.id]);
          else {
            if (uuid !== null) await assertDeviceIdentifierAvailable(db, 'uuid', uuid);
            if (sn !== null) {
              registeredDeviceSn(sn);
              await assertDeviceIdentifierAvailable(db, 'sn', sn);
            }
          }
          const row = await db.insert('ar_device', { uuid: existing ? existing.uuid : uuid, sn: existing ? existing.sn : sn,
            name, remark_name, device_type, merchant_id: ownerId, venue_id: venueId });
          if (existing) await db.execute('UPDATE ar_device_retired_identifier SET device_id=? WHERE device_id=?', [row.id, existing.id]);
          return { row: { ...row, venue_name: venue.name }, created: true };
        });
        // No rental configuration is written here, so new devices remain disabled.
        return { device: DeviceService.display(result.row, true), created: result.created };
      } catch (error: any) {
        if (!['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK'].includes(error?.code)) throw error;
        if (attempt === 2) throw new ApiError(409, '设备登记状态已变化，请刷新后重试');
      }
    }
  }
}
