import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Row } from '../src/core/contracts';
import { MerchantRegistry } from '../src/merchants/registry';
import { MerchantSecrets } from '../src/merchants/secrets';
import { WeChatClient } from '../src/payments/wechat';

const appA = 'wx1111111111111111', appB = 'wx2222222222222222';
const mchA = '1900000001', mchB = '1900000002';
const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformPublicKey = platform.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const firstKey = first.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const secondKey = second.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const materialA = { privateKey: firstKey, serialNo: 'A12345', apiV3Key: 'a'.repeat(32), platformKeyId: 'PUB_KEY_ID_1000000001', platformPublicKey };

function fixture(defaultApp = appA, defaultMch = mchB, pinnedMch: string | null = mchA) {
  const secrets = new MerchantSecrets('1'.repeat(64));
  const owner = { id: 1, code: 'default', name: 'Synthetic merchant', status: 'active', origin: 'https://synthetic.example.test', app_id: appA, active_config_id: 1 };
  const legacy: Row = { id: 1, merchant_id: 1, version: 1, source: 'legacy', app_id: appA, mch_id: pinnedMch, pay_enabled: null };
  const configs: Row[] = [legacy], pins: unknown[][] = [];
  const db = {
    async one(sql: string, values: unknown[] = []) {
      if (sql.includes('FROM ar_application a INNER JOIN ar_application_merchant')) return { id: 1, legacy_merchant_id: 1, app_id: appA, origin: owner.origin };
      if (sql.includes('FROM ar_merchant_wechat_config WHERE id=?')) return configs.find(row => row.id === Number(values[0]) && (values[1] === undefined || row.merchant_id === Number(values[1]))) ?? null;
      if (sql.includes('FROM ar_merchant WHERE id=?')) return Number(values[0]) === 1 ? owner : null;
      throw Error('Unexpected synthetic lookup');
    },
    async query(sql: string, values: unknown[]) {
      if (!sql.includes('FROM ar_merchant_wechat_config WHERE merchant_id=? AND app_id=?')) throw Error('Unexpected synthetic query');
      return configs.filter(row => row.merchant_id === values[0] && row.app_id === values[1]).sort((a, b) => b.version - a.version);
    },
    async execute(sql: string, values: unknown[]) {
      if (!sql.startsWith('UPDATE ar_merchant_wechat_config SET mch_id=')) throw Error('Unexpected synthetic mutation');
      pins.push(values);
      const row = configs.find(row => row.id === values[1]);
      if (row?.mch_id == null) row!.mch_id = values[0];
      return { affectedRows: 1, insertId: 0 };
    },
  };
  const defaultClient = new WeChatClient({ allowEnvironmentFallback: false, appId: defaultApp, mchId: defaultMch, serialNo: 'B12345', privateKey: secondKey,
    apiV3Key: 'b'.repeat(32), platformKeyId: materialA.platformKeyId, platformKeys: { [materialA.platformKeyId]: platformPublicKey }, payEnabled: true });
  const registry = new MerchantRegistry(db as any, defaultClient, secrets);
  const addManaged = (id: number, material: Row, mchId = mchA, appId = appA) => {
    configs.push({ id, merchant_id: 1, version: id, source: 'managed', app_id: appId, mch_id: mchId, pay_enabled: 1,
      secret_ciphertext: secrets.encrypt(material, '1') });
  };
  return { registry, defaultClient, legacy, configs, pins, addManaged };
}

describe('legacy payment account isolation', () => {
  it.each([[appA, mchB], [appB, mchA], [appB, mchB]])('refuses mismatched default credentials (%s/%s) for active and historical accounts', async (defaultApp, defaultMch) => {
    const f = fixture(defaultApp, defaultMch);
    expect(f.defaultClient.isPaymentReady()).toBe(true);
    const current = await f.registry.runtime(1);
    expect(current.client.isPaymentReady()).toBe(false);
    expect(current.client.config.mchId).toBeUndefined();
    await expect(f.registry.credentials(f.legacy)).rejects.toMatchObject({ status: 503 });
    await expect(f.registry.clientForConfig(1)).rejects.toMatchObject({ status: 503 });
    expect(f.pins).toEqual([]);
  });

  it('keeps original-account managed settlement credentials usable while mismatched defaults and bad versions are excluded', async () => {
    const f = fixture(appB, mchB);
    f.addManaged(2, materialA);
    f.addManaged(3, { ...materialA, privateKey: 'synthetic-invalid-private-key' });
    f.addManaged(4, { ...materialA, privateKey: secondKey, apiV3Key: 'b'.repeat(32) }, mchB);
    const order = { merchant_id: 1, payment_config_id: 1, appid: appA, mch_id: mchA };
    const client = await f.registry.paymentForOrder(order);
    expect(client.config).toMatchObject({ appId: appA, mchId: mchA, serialNo: materialA.serialNo });
    expect(createPublicKey(client.config.privateKey!).equals(first.publicKey)).toBe(true);
    expect(client.config.apiV3Keys).toContain('a'.repeat(32));
    expect(client.config.apiV3Keys).not.toContain('b'.repeat(32));
    expect((await f.registry.runtime(1)).client.isPaymentReady()).toBe(false);
  });

  it('preserves first-use pinning only when the legacy AppID matches the configured default', async () => {
    const f = fixture(appA, mchA, null);
    expect((await f.registry.runtime(1)).client).toBe(f.defaultClient);
    expect((await f.registry.clientForConfig(1))).toBe(f.defaultClient);
    expect(f.legacy.mch_id).toBe(mchA);
    expect(f.pins).toEqual([[mchA, 1]]);
    const mismatched = fixture(appB, mchB, null);
    await expect(mismatched.registry.clientForConfig(1)).rejects.toMatchObject({ status: 503 });
    expect(mismatched.legacy.mch_id).toBeNull(); expect(mismatched.pins).toEqual([]);
  });

  it('does not expose environment-owned credentials to a forged non-default legacy owner', async () => {
    const f = fixture(appA, mchA);
    await expect(f.registry.credentials({ ...f.legacy, merchant_id: 2 })).rejects.toMatchObject({ status: 503 });
  });
});
