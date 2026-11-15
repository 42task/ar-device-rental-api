/** QR codes map to canonical model names stored in the string device_type field. */
export const DEVICE_TYPES = Object.freeze({
  rs: Object.freeze({ type: 'Rokid Studio', label: 'Rokid Studio' }),
  rs2: Object.freeze({ type: 'Rokid Studio2', label: 'Rokid Studio2' }),
  rs3: Object.freeze({ type: 'Rokid Studio3', label: 'Rokid Studio3' }),
});

export const DEFAULT_DEVICE_TYPE = DEVICE_TYPES.rs2.type;

export function resolveDeviceType(value: string): string {
  const normalized = value.toLowerCase();
  const named = Object.values(DEVICE_TYPES).find(model => model.type.toLowerCase() === normalized);
  if (named) return named.type;
  return Object.hasOwn(DEVICE_TYPES, normalized) ? DEVICE_TYPES[normalized as keyof typeof DEVICE_TYPES].type : value;
}
