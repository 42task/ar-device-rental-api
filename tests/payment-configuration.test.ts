import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validatePaymentConfiguration } from '../src/payments/configuration';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = (key: KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = (key: KeyObject) => key.export({ format: 'pem', type: 'spki' }).toString();
const credentials = { privateKey: privatePem(merchant.privateKey), serialNo: 'abcdef0123456789', apiV3Key: 'a'.repeat(32), platformKeyId: 'PUB_KEY_ID_1000000001', platformPublicKey: publicPem(platform.publicKey) };
const candidate = (changes: Record<string, unknown> = {}) => ({ appId: 'wx03dbf50c15cac06f', mchId: '1900000001', credentials: { ...credentials, ...changes } });

// Generate a synthetic X509 certificate entirely in memory: no persisted test
// key/certificate, external executable, network request or real account data.
const der = (tag: number, data: Buffer): Buffer => {
  let length = Buffer.from([data.length]);
  if (data.length >= 128) {
    let hex = data.length.toString(16); if (hex.length % 2) hex = '0' + hex;
    const bytes = Buffer.from(hex, 'hex'); length = Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, data]);
};
const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
function certificate(serial: string): string {
  const algorithm = sequence(der(0x06, Buffer.from('2a864886f70d01010b', 'hex')), der(0x05, Buffer.alloc(0)));
  const name = sequence(der(0x31, sequence(der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('Synthetic WeChat Platform')))));
  let number = Buffer.from(serial.length % 2 ? '0' + serial : serial, 'hex');
  if (number[0] & 0x80) number = Buffer.concat([Buffer.from([0]), number]);
  const tbs = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, number), algorithm, name,
    sequence(der(0x18, Buffer.from('20200101000000Z')), der(0x18, Buffer.from('20990101000000Z'))), name,
    platform.publicKey.export({ format: 'der', type: 'spki' }));
  const value = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign('RSA-SHA256', tbs, platform.privateKey)]))).toString('base64');
  return '-----BEGIN CERTIFICATE-----\n' + value.match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n';
}

describe('payment configuration candidates', () => {
  it('validates a complete candidate without changing the original secrets or confusing merchant and platform keys', () => {
    const input = candidate(), original = structuredClone(input);
    const result = validatePaymentConfiguration(input);
    expect(result.complete).toBe(true);
    expect(result.credentials.serialNo).toBe('ABCDEF0123456789');
    expect(JSON.parse(result.credentials.platformKeysJson)).toEqual({ [credentials.platformKeyId]: credentials.platformPublicKey });
    expect(input).toEqual(original);
  });

  it('allows incomplete drafts but rejects malformed supplied credentials even when payments are disabled', () => {
    expect(validatePaymentConfiguration({ appId: candidate().appId, mchId: '', credentials: { apiV3Key: 'a'.repeat(32) } }, { requireComplete: false }).complete).toBe(false);
    expect(() => validatePaymentConfiguration({ appId: candidate().appId, mchId: '', credentials: {} })).toThrow(expect.objectContaining({ status: 422 }));
    for (const change of [{ privateKey: 'broken-private-key-must-not-leak' }, { apiV3Key: 'short-key-must-not-leak' }, { platformPublicKey: 'broken-public-key-must-not-leak' }]) {
      try { validatePaymentConfiguration(candidate(change), { requireComplete: false }); throw Error('Expected rejection'); }
      catch (error: any) {
        expect(error.status).toBe(422);
        for (const secret of Object.values(change)) expect(error.message).not.toContain(secret);
      }
    }
  });

  it('rejects wrong key types, short RSA keys, serials, APIv3 values and mismatched key mappings', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const invalid = [
      { privateKey: privatePem(ec.privateKey) }, { privateKey: privatePem(weak.privateKey) }, { privateKey: publicPem(merchant.publicKey) },
      { platformPublicKey: privatePem(platform.privateKey) }, { platformPublicKey: publicPem(ec.publicKey) },
      { platformPublicKey: publicPem(merchant.publicKey) }, { serialNo: 'not-a-certificate-serial' }, { serialNo: 'A'.repeat(129) },
      { apiV3Key: 'a'.repeat(31) }, { apiV3Key: 'a'.repeat(33) }, { apiV3Key: '中'.repeat(32) }, { apiV3Key: '!'.repeat(32) }, { apiV3Key: 32 },
      { platformKeyId: 'PUB_KEY_ID_bad\nheader' }, { platformKeysJson: '[]' }, { platformKeysJson: 'invalid-json' },
      { platformKeysJson: JSON.stringify({ [credentials.platformKeyId]: publicPem(merchant.publicKey) }) },
      { platformKeysJson: JSON.stringify({ [credentials.platformKeyId]: 123 }) },
    ];
    for (const change of invalid) expect(() => validatePaymentConfiguration(candidate(change), { requireComplete: false })).toThrow(expect.objectContaining({ status: 422 }));
  });

  it('parses platform certificates, checks their declared serial and normalizes verification key IDs', () => {
    const value = certificate('ABCD1234');
    const result = validatePaymentConfiguration(candidate({ platformKeyId: 'abcd1234', platformPublicKey: value }));
    expect(result.complete).toBe(true);
    expect(result.credentials.platformKeyId).toBe('ABCD1234');
    expect(JSON.parse(result.credentials.platformKeysJson).ABCD1234).toContain('-----BEGIN CERTIFICATE-----');
    expect(() => validatePaymentConfiguration(candidate({ platformKeyId: 'ABC000', platformPublicKey: value }))).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => validatePaymentConfiguration(candidate({ platformKeyId: 'PUB_KEY_ID_1000000001', platformPublicKey: value }))).toThrow(expect.objectContaining({ status: 422 }));
    const mapped = validatePaymentConfiguration(candidate({ platformKeyId: '', platformPublicKey: '', platformKeysJson: JSON.stringify({ abcd1234: value }) }));
    expect(JSON.parse(mapped.credentials.platformKeysJson).ABCD1234).toContain('-----BEGIN CERTIFICATE-----');
    const draft = validatePaymentConfiguration(candidate({ platformKeyId: '', platformPublicKey: value }), { requireComplete: false });
    expect(draft.complete).toBe(false);
    expect(() => validatePaymentConfiguration({ ...candidate(), credentials: { ...draft.credentials, platformKeyId: 'ABC000' } })).toThrow(expect.objectContaining({ status: 422 }));
  });

  it('rejects conflicting representations of the same verification key and distinguishes missing mappings from completeness', () => {
    const third = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => validatePaymentConfiguration(candidate({ platformKeysJson: JSON.stringify({ [credentials.platformKeyId]: publicPem(third.publicKey) }) }))).toThrow(expect.objectContaining({ status: 422 }));
    const missing = candidate({ platformKeyId: 'PUB_KEY_ID_missing', platformPublicKey: '', platformKeysJson: JSON.stringify({ PUB_KEY_ID_existing: publicPem(platform.publicKey) }) });
    expect(validatePaymentConfiguration(missing, { requireComplete: false }).complete).toBe(false);
    expect(() => validatePaymentConfiguration(missing)).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => validatePaymentConfiguration({ ...candidate(), appId: 'another-app' })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => validatePaymentConfiguration({ ...candidate(), mchId: 'another-merchant' })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => validatePaymentConfiguration({ ...candidate(), credentials: null })).toThrow(expect.objectContaining({ status: 422 }));
  });
});
