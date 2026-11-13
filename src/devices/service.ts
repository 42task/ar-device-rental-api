import type { Row, Services } from '../core/contracts';
import { ApiError } from '../core/errors';
import { requireManager } from '../core/roles';

export function deviceUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^\S{1,255}$/u.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备 UUID 无效');
  }
  return value;
}

export function deviceType(value: unknown): string {
  if (value === undefined) return 'ios';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || [...value].length > 32 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ApiError(422, '设备类型须为 1 至 32 个字符，且不含首尾空白或控制字符');
  }
  return value;
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
    return { id: Number(row.id), uuid: String(row.uuid), name: String(row.name || row.uuid), type: String(row.device_type || 'ios') };
  }

  async create(user: Row, input: Row): Promise<Row> {
    requireManager(user);
    const uuid = deviceUuid(input.uuid);
    const device_type = deviceType(input.type ?? input.device_type);
    const name = deviceName(input.name, uuid);
    let result: { row: Row; created: boolean };
    try {
      result = await this.services.db.transaction(async db => {
        const existing = await db.one('SELECT * FROM ar_device WHERE uuid = ?', [uuid]);
        if (existing) return { row: existing, created: false };
        return { row: await db.insert('ar_device', { uuid, name, device_type }), created: true };
      });
    } catch (error: any) {
      // The binary UUID unique index resolves concurrent confirmations.
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
      const existing = await this.services.db.one('SELECT * FROM ar_device WHERE uuid = ?', [uuid]);
      if (!existing) throw error;
      result = { row: existing, created: false };
    }
    // No rental configuration is written here, so new devices remain disabled.
    return { device: DeviceService.display(result.row), created: result.created };
  }
}
