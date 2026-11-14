import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerchantSecrets } from '../src/merchants/secrets';
import { merchantOrigin } from '../src/merchants/registry';
afterEach(() => vi.unstubAllEnvs());

describe('merchant credential isolation', () => {
  it('binds authenticated ciphertext to its merchant and rejects tampering or the wrong key', () => {
    const secrets = new MerchantSecrets('a'.repeat(64));
    const ciphertext = secrets.encrypt({ appSecret: 'synthetic-secret' }, '2');
    expect(ciphertext).not.toContain('synthetic-secret');
    expect(secrets.decrypt(ciphertext, '2')).toEqual({ appSecret: 'synthetic-secret' });
    expect(() => secrets.decrypt(ciphertext, '1')).toThrow('无法解密');
    expect(() => new MerchantSecrets('b'.repeat(64)).decrypt(ciphertext, '2')).toThrow('无法解密');
    const modified = JSON.parse(ciphertext); modified.data = 'invalid';
    expect(() => secrets.decrypt(JSON.stringify(modified), '2')).toThrow('无法解密');
  });
  it('rejects invalid wrapping keys and untrusted origins', () => {
    expect(() => new MerchantSecrets('invalid').encrypt({}, '2')).toThrow('加密密钥');
    expect(merchantOrigin('https://d1.4mr.cn')).toEqual({ origin: 'https://d1.4mr.cn', hostname: 'd1.4mr.cn' });
    for (const value of ['http://d1.4mr.cn', 'https://d1.4mr.cn/', 'https://user@d1.4mr.cn', 'https://d1.4mr.cn/path', 'https://d1.4mr.cn:8443']) expect(() => merchantOrigin(value)).toThrow();
  });
  it('uses the mounted key when Compose supplies an empty inline environment variable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-key-test-'));
    try {
      const path = join(directory, 'key'); writeFileSync(path, 'a'.repeat(64), { mode: 0o600 });
      vi.stubEnv('MERCHANT_CONFIG_KEY', ''); vi.stubEnv('MERCHANT_CONFIG_KEY_PATH', path);
      const secrets = new MerchantSecrets();
      const encrypted = secrets.encrypt({ appSecret: 'synthetic-only' }, '2');
      expect(secrets.decrypt(encrypted, '2')).toEqual({ appSecret: 'synthetic-only' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
