import { describe, expect, it } from 'vitest';
import { deviceType, DeviceService } from '../src/devices/service';
import { DEVICE_TYPES } from '../src/devices/types';

describe('device QR type mapping', () => {
  it('maps known names and QR codes case-insensitively to canonical string values', () => {
    expect(DEVICE_TYPES).toEqual({
      rs: { type: 'Rokid Studio', label: 'Rokid Studio' },
      rs2: { type: 'Rokid Studio2', label: 'Rokid Studio2' },
      rs3: { type: 'Rokid Studio3', label: 'Rokid Studio3' },
    });
    expect(deviceType(undefined)).toBe('Rokid Studio2');
    for (const [value, expected] of [['rs', 'Rokid Studio'], ['RS2', 'Rokid Studio2'], ['rs3', 'Rokid Studio3'], ['rokid studio', 'Rokid Studio'], ['ROKID STUDIO2', 'Rokid Studio2'], ['Rokid Studio3', 'Rokid Studio3']] as const) {
      expect(deviceType(value)).toBe(expected);
      expect(DeviceService.display({ id: 1, uuid: 'synthetic-device', device_type: value }).type).toBe(expected);
    }
  });

  it('preserves legacy and custom device type strings', () => {
    for (const value of ['rokid', 'ios', 'Custom Glasses', '__proto__', 'constructor']) {
      expect(deviceType(value)).toBe(value);
      expect(DeviceService.display({ id: 1, uuid: 'synthetic-device', device_type: value }).type).toBe(value);
    }
  });

  it.each(['', ' rs2', 'rs2 ', 'rs2\n', 'rs2\u0000', 'a'.repeat(33), null, 2])('rejects invalid type %j before mapping', value => {
    expect(() => deviceType(value)).toThrow();
  });
});
