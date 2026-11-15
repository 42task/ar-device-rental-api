import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deviceQr } from '../src/devices/qr';

// The API release repository is independent of the mini-program. Its complete
// URL/matrix contract remains testable without an adjacent frontend checkout.
const parserPath = new URL('../../miniprogram/utils/qr.js', import.meta.url);
const miniprogramQr = existsSync(parserPath) ? createRequire(import.meta.url)(fileURLToPath(parserPath)) : null;
const modelCases = [
  ['Rokid Studio', 'rs'], ['rokid studio2', 'rs2'], ['ROKID STUDIO3', 'rs3'],
  ['RS', 'rs'], ['RS2', 'rs2'], ['rs3', 'rs3'], ['AR glasses', 'AR glasses'],
] as const;
const unusableHints = [undefined, null, '', ' rs2', 'rs2 ', 'bad\nmodel', 'a'.repeat(33), '\ud800'];

describe('printable device QR contract', () => {
  it.each(modelCases)('encodes model %s in the ordinary-link contract', (type, code) => {
    const result = deviceQr('camera%2F+中文/01?&=', type);
    expect(result.url).toBe('https://d.4mr.cn/d?i=camera%252F%2B%E4%B8%AD%E6%96%87%2F01%3F%26%3D&t=' + encodeURIComponent(code));
  });

  it.each(unusableHints)('omits an unusable historical hint %j', type => {
    const result = deviceQr('12345', type);
    expect(result.url).toBe('https://d.4mr.cn/d?i=12345');
  });

  it.skipIf(!miniprogramQr)('opens every generated model and historical hint with the adjacent mini-program parser', () => {
    for (const [type, code] of modelCases) {
      const result = deviceQr('camera%2F+中文/01?&=', type);
      expect(miniprogramQr.parse(result.url)).toEqual({ uuid: 'camera%2F+中文/01?&=', type: code });
      expect(miniprogramQr.entry({ q: encodeURIComponent(result.url) })).toEqual({ uuid: 'camera%2F+中文/01?&=', type: code });
    }
    for (const type of unusableHints) expect(miniprogramQr.parse(deviceQr('12345', type).url)).toEqual({ uuid: '12345' });
  });

  it('uses a trusted independent entry while rejecting malformed origins', () => {
    expect(deviceQr('12345', 'rs2', 'https://independent.example').url).toBe('https://independent.example/d?i=12345&t=rs2');
    for (const origin of ['http://d.4mr.cn', 'https://d.4mr.cn/path', 'https://d.4mr.cn/?x=1', 'https://user@d.4mr.cn', 'https://d.4mr.cn:8443']) {
      expect(() => deviceQr('12345', 'rs2', origin)).toThrow();
    }
  });

  it.each(['', 'with space', 'control\u0000', '\ud800', 'a'.repeat(256), '😀'.repeat(255)])('reports invalid or over-capacity UUIDs %j without changing identity', uuid => {
    expect(() => deviceQr(uuid, 'rs2')).toThrow(expect.objectContaining({ status: 422 }));
  });

  it('serializes a row-major QR matrix with finder patterns, timing and Q error correction', () => {
    const { qr } = deviceQr('12345', 'rs2');
    expect(qr.size).toBeGreaterThanOrEqual(21); expect(qr.size).toBeLessThanOrEqual(177);
    expect((qr.size - 17) % 4).toBe(0);
    expect(qr.modules).toMatch(/^[01]+$/); expect(qr.modules).toHaveLength(qr.size * qr.size);
    const bit = (row: number, column: number) => Number(qr.modules[row * qr.size + column]);
    for (const [top, left] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]]) {
      for (let row = 0; row < 7; row++) for (let column = 0; column < 7; column++) {
        const black = row === 0 || row === 6 || column === 0 || column === 6 || row >= 2 && row <= 4 && column >= 2 && column <= 4;
        expect(bit(top + row, left + column)).toBe(Number(black));
      }
    }
    for (let position = 8; position < qr.size - 8; position++) {
      expect(bit(6, position)).toBe(Number(position % 2 === 0));
      expect(bit(position, 6)).toBe(Number(position % 2 === 0));
    }
    const formatPositions = [0, 1, 2, 3, 4, 5, 7, 8, ...Array.from({ length: 7 }, (_, index) => qr.size - 7 + index)];
    const format = formatPositions.reduce((value, row, index) => value | bit(row, 8) << index, 0);
    expect(((format ^ 0x5412) >>> 13) & 3).toBe(3); // QR format bits 11 identify level Q.
  });
});
