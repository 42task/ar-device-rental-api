import { ApiError } from './errors';

export const MAX_LOGO_BYTES = 256 * 1024;
export const MAX_HERO_BYTES = 512 * 1024;
export type ImageAsset = { data: Buffer; mime: string };

function parseImageDataUrl(value: unknown, maxBytes: number, label: string): ImageAsset {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 40) throw new ApiError(422, `${label}图片不能超过 ${maxBytes / 1024} KB`);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new ApiError(422, `${label}须为 PNG、JPEG 或 WebP 图片`);
  const data = Buffer.from(match[2], 'base64'), mime = match[1];
  if (!data.length || data.length > maxBytes || data.toString('base64') !== match[2]) throw new ApiError(422, `${label}图片无效或超过 ${maxBytes / 1024} KB`);
  const valid = mime === 'image/png'
    ? data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(8) === 13 && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0
    : mime === 'image/jpeg'
      ? data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data[data.length - 2] === 255 && data[data.length - 1] === 217
      : data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) === data.length - 8 && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16));
  if (!valid) throw new ApiError(422, `${label}图片内容与格式不符`);
  return { data, mime };
}
export const parseLogoDataUrl = (value: unknown): ImageAsset => parseImageDataUrl(value, MAX_LOGO_BYTES, 'Logo ');
export const parseHeroDataUrl = (value: unknown): ImageAsset => parseImageDataUrl(value, MAX_HERO_BYTES, '主图');

function validateImageUrl(value: unknown, label: string): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new ApiError(422, `${label}链接须为有效 HTTPS 图片地址`);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw Error();
    return url.href;
  } catch { throw new ApiError(422, `${label}链接须为有效 HTTPS 图片地址`); }
}
export const validateLogoUrl = (value: unknown): string => validateImageUrl(value, 'Logo ');
export const validateHeroUrl = (value: unknown): string => validateImageUrl(value, '主图');
