import QRCode from 'qrcode';
import type { Row } from '../core/contracts';
import { ApiError } from '../core/errors';
import { DEFAULT_ORIGIN, merchantOrigin } from '../merchants/registry';
import { deviceSn, deviceUuid } from './service';
import { DEVICE_TYPES } from './types';

export interface DeviceQr { url: string; qr: { size: number; modules: string } }
type DeviceQrKind = 'uuid' | 'sn';

export function deviceQrKind(device: Row): DeviceQrKind {
  return device.uuid == null ? 'sn' : 'uuid';
}

/** The ordinary-link contract is shared with miniprogram/utils/qr.js. */
export function deviceQr(value: unknown, type?: unknown, origin = DEFAULT_ORIGIN, kind: DeviceQrKind = 'uuid'): DeviceQr {
  const identifier = kind === 'uuid' ? deviceUuid(value) : deviceSn(value);
  let encodedIdentifier: string;
  try { encodedIdentifier = encodeURIComponent(identifier); }
  catch { throw new ApiError(422, '设备标识无法编码为二维码，请核对设备标识'); }
  let encodedType = '';
  if (typeof type === 'string' && type && type === type.trim() && [...type].length <= 32 && !/[\x00-\x1f\x7f]/.test(type)) {
    const normalized = type.toLowerCase();
    const code = Object.entries(DEVICE_TYPES).find(([key, model]) => key === normalized || model.type.toLowerCase() === normalized)?.[0] ?? type;
    // A historical type is only a display hint; unusable values must not prevent
    // a valid identifier from opening its authoritative database record.
    try { encodedType = '&t=' + encodeURIComponent(code); } catch { /* Omit invalid historical hints. */ }
  }
  const parameter = kind === 'uuid' ? 'i' : 's';
  const url = `${merchantOrigin(origin).origin}/d?${parameter}=${encodedIdentifier}${encodedType}`;
  try {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: 'Q' });
    return { url, qr: { size: modules.size, modules: Array.from(modules.data, value => value ? '1' : '0').join('') } };
  } catch {
    throw new ApiError(422, '设备标识过长，无法生成可打印二维码');
  }
}
