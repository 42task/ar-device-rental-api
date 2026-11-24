import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import { deviceName, deviceRemarkName, deviceType, registeredDeviceSn, registeredDeviceUuid } from './service';
import { deviceIdentifierKey } from './identifiers';

const editableFields = new Set(['uuid', 'sn', 'name', 'type', 'remarkName']);

/** The current row is locked by the caller. Omitted fields retain their stored values. */
export function updatedDeviceMetadata(device: Row, input: Row) {
  if (Object.keys(input).some(field => !editableFields.has(field))) throw new ApiError(422, '设备编辑字段无效');
  const requestedUuid = input.uuid === undefined || input.uuid === device.uuid ? device.uuid ?? null : input.uuid === null ? null : registeredDeviceUuid(input.uuid);
  const uuid = requestedUuid !== null && device.uuid != null && deviceIdentifierKey(requestedUuid, 'uuid') === deviceIdentifierKey(device.uuid, 'uuid')
    ? device.uuid : requestedUuid;
  const sn = input.sn === undefined || input.sn === device.sn ? device.sn ?? null : input.sn === null ? null : registeredDeviceSn(input.sn);
  if (uuid === null && sn === null) throw new ApiError(422, '设备 UUID 和 SN 至少保留一项');
  const name = input.name === undefined ? device.name : deviceName(input.name, '');
  const type = input.type === undefined ? device.device_type : deviceType(input.type);
  const remarkName = input.remarkName === undefined ? device.remark_name : deviceRemarkName(input.remarkName);
  return { uuid, sn, name, type, remarkName };
}
