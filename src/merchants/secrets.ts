import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiError } from '../core/errors';

/** The wrapping key is deployment-owned, never stored beside encrypted credentials. */
export class MerchantSecrets {
  constructor(private readonly suppliedKey?: string) {}
  private key(): Buffer {
    try {
      const inline = (this.suppliedKey ?? process.env.MERCHANT_CONFIG_KEY ?? '').trim();
      const value = inline || (process.env.MERCHANT_CONFIG_KEY_PATH ? readFileSync(process.env.MERCHANT_CONFIG_KEY_PATH, 'utf8').trim() : '');
      const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
      if (key.length !== 32) throw Error();
      return key;
    } catch { throw new ApiError(503, '商户配置加密密钥未就绪，请配置服务端 MERCHANT_CONFIG_KEY'); }
  }
  encrypt(value: Record<string, string>, account: string): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(account));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
  }
  decrypt(value: string, account: string): Record<string, string> {
    const key = this.key();
    try {
      const data = JSON.parse(value);
      if (data.v !== 1) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.nonce, 'base64'));
      decipher.setAAD(Buffer.from(account));
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString());
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(v => typeof v !== 'string')) throw Error();
      return parsed;
    } catch { throw new ApiError(503, '商户配置无法解密，请核对服务端密钥'); }
  }
}
