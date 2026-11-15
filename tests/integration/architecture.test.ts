import { generateKeyPairSync, randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import request from '../http-client';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import { createApplication } from '../../src/application';
import { RentalAuth, bootstrapRoot } from '../../src/auth';
import { WeChatClient } from '../../src/payments/wechat';
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
import type { Row } from '../../src/core/contracts';

function credentials() {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), serialNo: 'A1B2',
    apiV3Key: 'a'.repeat(32), platformKeyId: 'PUB_KEY_ID_SYNTHETIC', platformPublicKey: platform.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('independent application identity and recoverable financial configuration', () => {
  it('keeps login, metadata and historical reads reachable while rejecting malformed activation and recovering the same account', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated localhost AR test instance.');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings), database = 'ar_architecture_' + randomBytes(10).toString('hex');
    let db: Database | undefined;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 8 }));
      await migrate(db); await migrate(db);
      expect((await db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(SCHEMA_VERSION);
      const journal = await db.query('SELECT version,checksum,applied_ms FROM ar_schema_migration ORDER BY version');
      expect(journal.map(row => row.version)).toEqual([11, 12, 13]);
      expect(await db.one("SHOW COLUMNS FROM ar_rental_config WHERE Field='use_fee_cents'")).toBeNull();
      const appId = 'wx03dbf50c15cac06f';
      const client = new WeChatClient({ appId, appSecret: 'synthetic-application-secret', payEnabled: false, allowEnvironmentFallback: false,
        fetch: async () => { throw Error('No real WeChat access in architecture tests.'); } });
      client.codeSession = async code => ({ openid: 'synthetic-' + code });
      const registry = new MerchantRegistry(db, client, new MerchantSecrets('a'.repeat(64)));
      registry.applications.createLoginClient = (row: Row, appSecret: string) => {
        const login = new WeChatClient({ appId: row.app_id, appSecret, payEnabled: false, allowEnvironmentFallback: false,
          fetch: async () => { throw Error('No real WeChat access in architecture tests.'); } });
        login.codeSession = client.codeSession;
        return login;
      };
      const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-architecture-signing-key-at-least-32-bytes', rootPhone: '' });
      const { app } = createApplication({ db, client, auth, merchants: registry });
      const login = async (code: string) => {
        const result = await request(app).post('/api/v2/rental/auth/login').send({ code });
        expect(result.status).toBe(200); return result.body.data;
      };
      const root = await login('root');
      await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES(?,?,?,?,?,?)', [root.user.id, appId, '+8613700137000', '86', Date.now(), 'f'.repeat(64)]);
      await bootstrapRoot(db, root.user.id, appId, '+8613700137000');
      const rootToken = 'Bearer ' + root.token.accessToken;
      const entrySettings = await request(app).patch('/api/v2/rental/admin/merchants/1').set('Authorization', rootToken).send({ entryName: 'Synthetic platform entry', entryStatus: 'paused' });
      expect(entrySettings.status).toBe(200);
      expect(entrySettings.body.merchant).toMatchObject({ status: 'active', entry: { name: 'Synthetic platform entry', status: 'paused' } });
      expect((await login('root')).user.id).toBe(root.user.id);
      expect((await request(app).post('/api/v2/rental/auth/login').send({ code: 'blocked-new-customer' })).status).toBe(403);
      expect((await request(app).patch('/api/v2/rental/admin/merchants/1').set('Authorization', rootToken).send({ name: 'Synthetic business name', entryStatus: 'active' })).body.merchant.entry.name).toBe('Synthetic platform entry');
      const unused = await request(app).post('/api/v2/rental/admin/merchants').set('Authorization', rootToken).send({ code: 'unused_entry', name: 'Synthetic unused independent merchant', miniappOwnerId: null, appId: 'wx2222222222222222', origin: 'https://unused.example.com' });
      expect(unused.status).toBe(200);
      expect((await registry.resolveHost('unused.example.com')).appId).toBe('wx2222222222222222');
      expect((await request(app).patch(`/api/v2/rental/admin/merchants/${unused.body.merchant.id}`).set('Authorization', rootToken).send({ miniappOwnerId: 1 })).status).toBe(200);
      await expect(registry.resolveHost('unused.example.com')).rejects.toMatchObject({ status: 404 });
      expect(await db.one('SELECT id FROM ar_application WHERE legacy_merchant_id=?', [unused.body.merchant.id])).toBeNull();
      expect((await request(app).post('/api/v2/rental/admin/merchants').set('Authorization', rootToken).send({ code: 'reused_entry', name: 'Synthetic replacement entry', miniappOwnerId: null, appId: 'wx2222222222222222', origin: 'https://unused.example.com' })).status).toBe(200);
      const material = credentials();
      const merchant = await request(app).post('/api/v2/rental/admin/merchants').set('Authorization', rootToken).send({
        code: 'synthetic_child', name: 'Synthetic child merchant', mchId: '2000000001', status: 'active', payEnabled: true, credentials: material });
      expect(merchant.status).toBe(200);
      const merchantId = merchant.body.merchant.id, configId = merchant.body.merchant.configId;
      expect(merchant.body.merchant).toMatchObject({ miniappOwnerId: 1, origin: 'https://d.4mr.cn', appId, paymentReady: true, configuration: { hasAppSecret: true } });
      const venue = await request(app).post('/api/v2/rental/admin/venues').set('Authorization', rootToken).set('X-Merchant-Id', String(merchantId)).send({ name: 'Synthetic venue', useFeeCents: 2000, depositCents: 8000 });
      expect(venue.status).toBe(200);
      const device = await request(app).post('/api/v2/rental/devices').set('Authorization', rootToken).set('X-Merchant-Id', String(merchantId)).send({ uuid: 'synthetic-device', venueId: venue.body.venue.id });
      expect(device.status).toBe(200);
      expect((await request(app).patch(`/api/v2/rental/devices/${device.body.device.id}/config`).set('Authorization', rootToken).set('X-Merchant-Id', String(merchantId)).send({ enabled: true, version: 0 })).status).toBe(200);
      const customer = await login('customer'), bearer = 'Bearer ' + customer.token.accessToken;
      expect(customer.user.merchantId).toBeNull();
      const reservation = await request(app).post('/api/v2/rentals').set('Authorization', bearer).send({ deviceId: device.body.device.id, priceVersion: 1, venuePriceVersion: 1, idempotencyKey: 'synthetic-architecture-reservation' });
      expect(reservation.status).toBe(201);
      const stored = (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [reservation.body.rental.id]))!;
      expect(stored).toMatchObject({ merchant_id: merchantId, payment_config_id: configId, mch_id: '2000000001', total_cents: 10000 });
      const invalid = await request(app).patch(`/api/v2/rental/admin/merchants/${merchantId}`).set('Authorization', rootToken).send({ credentials: { privateKey: 'malformed-synthetic-key' } });
      expect(invalid.status).toBe(422);
      expect((await registry.row(merchantId)).active_config_id).toBe(configId);
      expect((await registry.paymentForOrder(stored)).isPaymentReady()).toBe(true);
      await db.execute("UPDATE ar_merchant_wechat_config SET secret_ciphertext='synthetic-corrupt' WHERE id=?", [configId]);
      expect((await request(app).get(`/api/v2/rentals/${stored.id}`).set('Authorization', bearer)).status).toBe(200);
      expect((await request(app).get('/api/v2/rental/admin/merchants').set('Authorization', rootToken)).status).toBe(200);
      expect((await registry.runtime(merchantId)).client.isPaymentReady()).toBe(false);
      await db.execute("UPDATE ar_merchant_wechat_config SET source='managed',secret_ciphertext='synthetic-corrupt' WHERE id=1");
      expect((await login('another-customer')).user.merchantId).toBeNull();
      const repairedLogin = await request(app).patch('/api/v2/rental/admin/merchants/1').set('Authorization', rootToken).send({ credentials: { appSecret: 'synthetic-new-login-secret' } });
      expect(repairedLogin.status).toBe(200);
      expect((await registry.resolveHost('d.4mr.cn')).client.config.appSecret).toBe('synthetic-new-login-secret');
      const recovered = await request(app).patch(`/api/v2/rental/admin/merchants/${merchantId}`).set('Authorization', rootToken).send({ replaceCredentials: true, credentials: material });
      expect(recovered.status).toBe(200); expect(recovered.body.merchant.paymentReady).toBe(true);
      const restored = await registry.paymentForOrder(stored);
      expect(restored.config.mchId).toBe(stored.mch_id); expect(restored.isPaymentReady()).toBe(true);
      await migrate(db);
      expect(await db.query('SELECT version,checksum,applied_ms FROM ar_schema_migration ORDER BY version')).toEqual(journal);
      expect((await db.one('SELECT total_cents,mch_id,payment_config_id FROM ar_rental_order WHERE id=?', [stored.id]))!).toMatchObject({ total_cents: 10000, mch_id: '2000000001', payment_config_id: configId });
      await db.execute('UPDATE ar_schema_migration SET checksum=? WHERE version=13', ['0'.repeat(64)]);
      await expect(migrate(db)).rejects.toThrow('was modified');
    } finally { await db?.close(); await control.query(`DROP DATABASE IF EXISTS ${database}`); await control.end(); }
  }, 30_000);
});
