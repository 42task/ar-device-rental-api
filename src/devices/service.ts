import type { Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { requireManager } from '../core/roles';
import { DEFAULT_DEVICE_TYPE, resolveDeviceType } from './types';
import { currentMerchant } from '../merchants/context';

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
    return { id: Number(row.id), uuid: String(row.uuid), name: String(row.name || row.uuid), type: resolveDeviceType(String(row.device_type || DEFAULT_DEVICE_TYPE)) };
  }

  async create(user: Row, input: Row): Promise<Row> {
    requireManager(user);
    const merchant = currentMerchant();
    const checkOwnership = (row: Row): void => {
      if (merchant && Number(row.merchant_id) !== merchant.id) throw new ApiError(409, '设备属于其他商户，请使用对应小程序', 'MERCHANT_MISMATCH');
    };
    const uuid = deviceUuid(input.uuid);
    const device_type = deviceType(input.type ?? input.device_type);
    const name = deviceName(input.name, uuid);
    let result: { row: Row; created: boolean };
    try {
      result = await this.services.db.transaction(async db => {
        const currentUser = merchant
          ? await db.one('SELECT role,merchant_id,auth_version FROM ar_user WHERE id=? FOR UPDATE', [user.id])
          : await db.one('SELECT role FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [user.id, user.appid ?? '']);
        if (!currentUser) throw new ApiError(403, '设备管理权限已变更，请重新登录');
        requireManager(currentUser);
        if (merchant && (Number(currentUser.auth_version) !== Number(user.auth_version)
          || currentUser.role !== 'root' && Number(currentUser.merchant_id) !== merchant.id)) throw new ApiError(403, '设备管理权限已变更，请重新登录');
        const existing = await db.one('SELECT * FROM ar_device WHERE uuid = ?', [uuid]);
        if (existing) { checkOwnership(existing); return { row: existing, created: false }; }
        return { row: await db.insert('ar_device', { uuid, name, device_type, ...(merchant ? { merchant_id: merchant.id } : {}) }), created: true };
      });
    } catch (error: any) {
      // The binary UUID unique index resolves concurrent confirmations.
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
      const existing = await this.services.db.one('SELECT * FROM ar_device WHERE uuid = ?', [uuid]);
      if (!existing) throw error;
      checkOwnership(existing);
      result = { row: existing, created: false };
    }
    // No rental configuration is written here, so new devices remain disabled.
    return { device: DeviceService.display(result.row), created: result.created };
  }
}
