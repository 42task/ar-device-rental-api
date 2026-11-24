import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';

export type DeviceIdentifierKind = 'uuid' | 'sn';
const canonicalUuid = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function isDeviceUuid(value: string): boolean {
  return value.length === 36 && canonicalUuid.test(value);
}

export function deviceIdentifierKey(value: string, kind: DeviceIdentifierKind): string {
  return kind === 'uuid' && isDeviceUuid(value) ? value.toLowerCase() : value;
}

export function retiredDeviceIdentifier(db: Database, kind: DeviceIdentifierKind, key: string, lock = false): Promise<Row | null> {
  return db.one('SELECT device_id,original_identifier FROM ar_device_retired_identifier WHERE kind=? AND identifier=?' + (lock ? ' FOR UPDATE' : ''), [kind, key]);
}

export async function assertDeviceIdentifierAvailable(db: Database, kind: DeviceIdentifierKind, value: string, deviceId = 0): Promise<void> {
  const key = deviceIdentifierKey(value, kind);
  // Lock the current index before checking retired claims, so an edit cannot
  // release a key between this check and either registration or reassignment.
  const current = await db.one(`SELECT id FROM ar_device WHERE current_${kind}=? FOR UPDATE`, [key]);
  if (current && Number(current.id) !== deviceId) throw new ApiError(409, 'UUID 或 SN 已被登记');
  const retired = await retiredDeviceIdentifier(db, kind, key, true);
  if (retired && Number(retired.device_id) !== deviceId) throw new ApiError(409, '该标识曾用于其他设备，不能重新分配');

}

export async function updateDeviceIdentifierClaims(db: Database, device: Row, updated: { uuid: string | null; sn: string | null }): Promise<void> {
  for (const kind of ['uuid', 'sn'] as const) {
    const previous = device[kind] as string | null;
    const next = updated[kind];
    const oldKey = previous == null ? null : deviceIdentifierKey(previous, kind);
    if (oldKey === (next === null ? null : deviceIdentifierKey(next, kind))) continue;
    if (next !== null) await assertDeviceIdentifierAvailable(db, kind, next, Number(device.id));
    if (previous == null || oldKey === null) continue;
    if (!await retiredDeviceIdentifier(db, kind, oldKey, true)) {
      await db.execute('INSERT INTO ar_device_retired_identifier (kind,identifier,original_identifier,device_id) VALUES (?,?,?,?)', [kind, oldKey, previous, device.id]);
    }
  }
}
