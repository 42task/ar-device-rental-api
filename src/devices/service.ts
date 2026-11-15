import type { Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { requireManager } from '../core/roles';
import { DEFAULT_DEVICE_TYPE, resolveDeviceType } from './types';
import { currentMerchant } from '../merchants/context';
import { loadAccountPermissions, requireMerchantManagementScope } from '../auth/identity';

export { DEFAULT_DEVICE_TYPE } from './types';

export function deviceUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^\S{1,255}$/u.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备 UUID 无效');
  }
  return value;
}

export function deviceType(value: unknown): string {
  if (value === undefined) return DEFAULT_DEVICE_TYPE;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || [...value].length > 32 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备类型须为 1 至 32 个字符，且不含首尾空白或控制字符');
  }
  return resolveDeviceType(value);
}

function deviceName(value: unknown, uuid: string): string {
  if (value === undefined) return uuid;
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备名称须为 1 至 255 个字符，且不含控制字符');
  }
  return value.trim();
}

/** Devices belong to this application and are registered only after explicit confirmation. */
export class DeviceService {
  constructor(private readonly services: Services) {}

  static display(row: Row): Row {
    const merchantId = Number(row.merchant_id);
    const venueId = Number(row.venue_id);
    return { id: Number(row.id), uuid: String(row.uuid), name: String(row.name || row.uuid), type: resolveDeviceType(String(row.device_type || DEFAULT_DEVICE_TYPE)),
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
    const uuid = deviceUuid(input.uuid);
    const device_type = deviceType(input.type ?? input.device_type);
    const name = deviceName(input.name, uuid);
    const venueId = Number(input.venueId);
    if (!Number.isSafeInteger(venueId) || venueId < 1) throw new ApiError(422, '请选择设备所属场地');
    let result: { row: Row; created: boolean };
    try {
      result = await this.services.db.transaction(async db => {
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
        const existing = await db.one('SELECT * FROM ar_device WHERE uuid = ?', [uuid]);
        if (existing) {
          checkOwnership(existing);
          if (Number(existing.venue_id) !== venueId) throw new ApiError(409, '设备已绑定其他场地，请通过设备设置调整');
          return { row: { ...existing, venue_name: venue.name }, created: false };
        }
        return { row: { ...await db.insert('ar_device', { uuid, name, device_type, merchant_id: ownerId, venue_id: venueId }), venue_name: venue.name }, created: true };
      });
    } catch (error: any) {
      // The binary UUID unique index resolves concurrent confirmations.
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
      const existing = await this.services.db.one('SELECT * FROM ar_device WHERE uuid = ?', [uuid]);
      if (!existing) throw error;
      checkOwnership(existing);
      if (Number(existing.venue_id) !== venueId) throw new ApiError(409, '设备已绑定其他场地，请通过设备设置调整');
      const venue = await this.services.db.one('SELECT name FROM ar_venue WHERE id=? AND merchant_id=?', [venueId, ownerId]);
      result = { row: { ...existing, venue_name: venue?.name }, created: false };
    }
    // No rental configuration is written here, so new devices remain disabled.
    return { device: DeviceService.display(result.row), created: result.created };
  }
}
