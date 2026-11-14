import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import { createApplication } from '../../src/application';
import { RentalAuth, bootstrapRoot } from '../../src/auth';
import { WeChatClient } from '../../src/payments/wechat';
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
import type { Row } from '../../src/core/contracts';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL merchant migration and HTTP isolation', () => {
  it('upgrades existing schema-7 data without changing prices, orders, old JWTs or web sessions', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use a dedicated loopback test MySQL instance.');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const admin = await mysql.createConnection(settings), database = 'ar_merchant_upgrade_' + randomBytes(8).toString('hex');
    let db: Database | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 8 }));
      for (const file of ['001-core.sql', 'user-schema.sql', '002-rentals.sql', '003-admin.sql', '004-phone.sql']) {
        for (const sql of (await readFile('database/' + file, 'utf8')).replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await db.execute(sql);
      }
      await db.execute('CREATE TABLE ar_schema_meta (name varchar(64) PRIMARY KEY,version int NOT NULL) ENGINE=InnoDB');
      await db.execute("INSERT INTO ar_schema_meta VALUES ('ar-device-rental-api',7)");
      const appId = 'wx03dbf50c15cac06f', now = Date.now();
      for (const [id, role] of [[21, 'user'], [22, 'manager'], [23, 'root']] as const) await db.insert('ar_user', { id, appid: appId, openid: 'legacy-' + id, role });
      const device = await db.insert('ar_device', { id: 7, uuid: 'legacy-device', device_type: 'ios', name: '原有设备' });
      await db.insert('ar_rental_config', { device_id: device.id, enabled: 1, use_fee_cents: 500, deposit_cents: 2000, version: 3, updated_ms: now, updated_by: 22 });
      const order = await db.insert('ar_rental_order', { id: 42, device_id: device.id, device_uuid: device.uuid, device_name: '原订单设备快照', user_id: 21,
        appid: appId, payer_openid: 'legacy-21', mch_id: '1234567890', use_fee_cents: 1000, deposit_cents: 2000, total_cents: 3000,
        price_version: 2, status: 'ENDED', payment_status: 'SUCCESS', out_trade_no: 'synthetic-legacy-order', idempotency_key: 'synthetic-legacy-request',
        expires_ms: now - 60000, created_ms: now - 120000, updated_ms: now, refund_amount_cents: 2000, refund_status: 'SUCCESS', settled_ms: now });
      await db.insert('ar_rental_event', { rental_id: order.id, event: 'REFUND_SUCCESS', details: { refundAmountCents: 2000 }, created_ms: now });
      await db.insert('ar_rental_job', { rental_id: order.id, kind: 'REFUND_SYNC', available_ms: now, finished: 1 });
      await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [22, appId, '+8613700137000', '86', now, '7'.repeat(64)]);
      const sessionToken = randomBytes(32).toString('hex');
      await db.execute('INSERT INTO ar_admin_session (id,user_id,appid,created_ms,expires_ms) VALUES (?,?,?,?,?)', [createHash('sha256').update(sessionToken).digest('hex'), 22, appId, now, now + 3600000]);
      const client = new WeChatClient({ appId, appSecret: 'synthetic-upgrade-only', payEnabled: false, allowEnvironmentFallback: false });
      client.codeSession = async () => ({ openid: 'legacy-22' });
      const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-upgrade-signing-key-at-least-32-bytes' });
      const oldLogin = await auth.login('synthetic-old-login');
      const before = await db.one('SELECT id,user_id,device_id,appid,payer_openid,mch_id,use_fee_cents,deposit_cents,total_cents,price_version,status,payment_status,out_trade_no,refund_amount_cents,refund_status FROM ar_rental_order WHERE id=42');
      await migrate(db); await migrate(db);
      expect(await db.one('SELECT id,user_id,device_id,appid,payer_openid,mch_id,use_fee_cents,deposit_cents,total_cents,price_version,status,payment_status,out_trade_no,refund_amount_cents,refund_status FROM ar_rental_order WHERE id=42')).toEqual(before);
      expect(await db.one('SELECT merchant_id,version,use_fee_cents FROM ar_rental_config WHERE device_id=7')).toEqual({ merchant_id: 1, version: 3, use_fee_cents: 500 });
      expect(await db.one('SELECT merchant_id FROM ar_user WHERE id=23')).toEqual({ merchant_id: null });
      const { app } = createApplication({ db, client, auth });
      const bearer = 'Bearer ' + oldLogin.token.accessToken;
      expect((await request(app).get('/api/v2/rental/devices/context?uuid=legacy-device').set('Authorization', bearer)).body).toMatchObject({ device: { id: 7, type: 'ios' }, state: 'AVAILABLE', pricing: { version: 3, useFeeCents: 500, depositCents: 2000 } });
      expect((await request(app).get('/api/v2/rental/admin/orders').set('Authorization', bearer)).body).toMatchObject({ total: 1, items: [{ id: 42, totalCents: 3000 }] });
      const session = await request(app).get('/api/v2/rental/admin/auth/session').set('Cookie', 'ar_admin_session=' + sessionToken);
      expect(session.status).toBe(200); expect(session.body.user).toMatchObject({ id: 22, role: 'manager' });
      expect((await request(app).post('/api/v2/rental/auth/refresh').send({ refreshToken: oldLogin.token.refreshToken })).status).toBe(200);
      expect((await db.one('SELECT COUNT(*) AS total FROM ar_rental_event'))!.total).toBe(1);
      expect((await db.one('SELECT COUNT(*) AS total FROM ar_rental_job'))!.total).toBe(1);
    } finally {
      await db?.close(); await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
    }
  }, 30_000);
  it('keeps default identities, isolates another merchant, and binds a transferred account without moving history', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use a dedicated loopback test MySQL instance.');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const admin = await mysql.createConnection(settings), database = 'ar_merchants_test_' + randomBytes(8).toString('hex');
    let db: Database | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 10 }));
      await migrate(db); await migrate(db);
      expect((await db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(SCHEMA_VERSION);
      const appId = 'wx03dbf50c15cac06f';
      const client = new WeChatClient({ appId, appSecret: 'synthetic-default-only', payEnabled: false, allowEnvironmentFallback: false });
      client.codeSession = async code => ({ openid: 'default-' + code });
      class SyntheticRegistry extends MerchantRegistry {
        override async clientForConfig(id: number, existing?: Row, merchant?: Row) {
          const value = await super.clientForConfig(id, existing, merchant);
          value.codeSession = async code => ({ openid: value.config.appId + '-' + code });
          return value;
        }
      }
      const registry = new SyntheticRegistry(db, client, new MerchantSecrets('a'.repeat(64)));
      const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-merchant-test-signing-key-at-least-32-bytes' });
      const { app } = createApplication({ db, client, auth, merchants: registry });
      const login = async (code: string, host?: string, bindToken?: string) => {
        let req = request(app).post('/api/v2/rental/auth/login');
        if (host) req = req.set('Host', host);
        return req.send({ code, ...(bindToken ? { bindToken } : {}) });
      };
      const rootLogin = await login('root'); expect(rootLogin.status).toBe(200);
      const rootId = rootLogin.body.data.user.id, rootToken = 'Bearer ' + rootLogin.body.data.token.accessToken;
      await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [rootId, appId, '+8613700137000', '86', Date.now(), '1'.repeat(64)]);
      await bootstrapRoot(db, rootId, appId, '+8613700137000');
      const first = await request(app).post('/api/v2/rental/devices').set('Authorization', rootToken).send({ uuid: 'existing-default-device' });
      expect(first.status).toBe(200);
      expect((await db.one('SELECT merchant_id FROM ar_device WHERE id=?', [first.body.device.id]))!.merchant_id).toBe(1);
      const creation = await request(app).post('/api/v2/rental/admin/merchants').set('Authorization', rootToken).send({ name: '合成测试商户', code: 'second', origin: 'https://d1.4mr.cn', appId: 'wx1111111111111111', mchId: '2000000001', status: 'active', payEnabled: false, credentials: { appSecret: 'synthetic-second-secret', apiV3Key: 'a'.repeat(32) } });
      expect(creation.status).toBe(200);
      const second = creation.body.merchant, secondId = second.id;
      expect(second).toMatchObject({ appId: 'wx1111111111111111', paymentReady: false, configuration: { hasAppSecret: true } });
      expect(JSON.stringify(second)).not.toContain('synthetic-second-secret');
      const storedConfig = await db.one('SELECT * FROM ar_merchant_wechat_config WHERE id=?', [second.configId]);
      expect(storedConfig!.secret_ciphertext).not.toContain('synthetic-second-secret');
      expect(await registry.credentials(storedConfig!)).toMatchObject({ appSecret: 'synthetic-second-secret' });
      const oldClient = await registry.clientForConfig(second.configId);
      expect(oldClient.config.apiV3Key).toBe('a'.repeat(32));
      const rotation = await request(app).patch(`/api/v2/rental/admin/merchants/${secondId}`).set('Authorization', rootToken).send({ credentials: { apiV3Key: 'b'.repeat(32) } });
      expect(rotation.status).toBe(200);
      for (let edit = 0; edit < 8; edit++) {
        const toggle = await request(app).patch(`/api/v2/rental/admin/merchants/${secondId}`).set('Authorization', rootToken).send({ payEnabled: edit % 2 === 0 });
        expect(toggle.status).toBe(200);
      }
      const rotated = await registry.clientForConfig(second.configId);
      expect(rotated.config.apiV3Key).toBe('b'.repeat(32));
      expect(rotated.config.apiV3Keys).toEqual(expect.arrayContaining(['a'.repeat(32), 'b'.repeat(32)]));
      expect(rotated.config.notifyUrl).toBe(`https://d1.4mr.cn/api/v2/rental/payment-notify/${second.configId}`);
      const replacementAccount = await request(app).patch(`/api/v2/rental/admin/merchants/${secondId}`).set('Authorization', rootToken).send({ mchId: '2000000002' });
      expect(replacementAccount.status).toBe(200);
      expect((await registry.clientForConfig(second.configId)).config.mchId).toBe('2000000001');
      expect((await registry.runtime(secondId)).client.config.mchId).toBe('2000000002');
      expect((await registry.runtime(secondId)).client.config.apiV3Key).toBe('');
      expect((await registry.runtime(secondId)).client.config.payEnabled).toBe(false);
      const draft = await request(app).post('/api/v2/rental/admin/merchants').set('Authorization', rootToken).send({ name: '未开放草稿', code: 'draft', origin: 'https://d2.4mr.cn', appId: 'wx2222222222222222', credentials: { appSecret: 'synthetic-draft-old-secret' } });
      expect(draft.status).toBe(200);
      const changedApp = await request(app).patch(`/api/v2/rental/admin/merchants/${draft.body.merchant.id}`).set('Authorization', rootToken).send({ appId: 'wx3333333333333333' });
      expect(changedApp.status).toBe(200);
      expect(changedApp.body.merchant.configuration.hasAppSecret).toBe(false);
      const list = await request(app).get('/api/v2/rental/admin/merchants').set('Authorization', rootToken);
      expect(list.body.items).toHaveLength(3);
      const registered = await request(app).post('/api/v2/rental/devices').set('Authorization', rootToken).set('X-Merchant-Id', String(secondId)).send({ uuid: 'second-device' });
      expect(registered.status).toBe(200);
      const secondDevice = registered.body.device.id;
      expect((await db.one('SELECT merchant_id FROM ar_device WHERE id=?', [secondDevice]))!.merchant_id).toBe(secondId);
      const a = await login('user-a'), b = await login('user-b', 'd1.4mr.cn');
      expect(a.status).toBe(200); expect(b.status).toBe(200);
      const aToken = 'Bearer ' + a.body.data.token.accessToken, bToken = 'Bearer ' + b.body.data.token.accessToken;
      expect(b.body.data.user.merchantId).toBe(secondId);
      const mismatch = await request(app).get('/api/v2/rental/devices/context?uuid=second-device').set('Authorization', aToken);
      expect(mismatch.status).toBe(409); expect(mismatch.body.code).toBe('MERCHANT_MISMATCH');
      expect((await request(app).get('/api/v2/rental/admin/overview').set('Authorization', aToken).set('X-Merchant-Id', String(secondId))).status).toBe(403);
      expect((await request(app).get('/api/v2/rental/merchant').set('Host', 'unregistered.example.com')).status).toBe(404);
      expect((await request(app).get('/api/v2/rental/merchant').set('Host', 'd.4mr.cn').set('X-Forwarded-Host', 'd1.4mr.cn')).body.merchant.id).toBe(1);
      const transfer = await request(app).post(`/api/v2/rental/admin/users/${b.body.data.user.id}/merchant`).set('Authorization', rootToken).send({ merchantId: 1, role: 'user', reason: '合成账号调拨' });
      expect(transfer.status).toBe(200);
      expect((await login('transferred-b', undefined, transfer.body.binding.token)).status).not.toBe(200);
      const confirmed = await request(app).post('/api/v2/rental/auth/merchant-binding/confirm').set('Host', 'd1.4mr.cn').set('Authorization', bToken).send({ bindToken: transfer.body.binding.token });
      expect(confirmed.status).toBe(200);
      const rebound = await login('transferred-b', undefined, transfer.body.binding.token);
      expect(rebound.status).toBe(200);
      expect(rebound.body.data.user).toMatchObject({ id: b.body.data.user.id, merchantId: 1 });
      expect((await request(app).get('/api/v2/rentals').set('Host', 'd1.4mr.cn').set('Authorization', bToken)).status).toBe(401);
      expect((await login('transferred-b', undefined, transfer.body.binding.token)).status).not.toBe(200);
      const historical = await db.insert('ar_rental_order', { device_id: secondDevice, device_uuid: 'second-device', device_name: '合成历史设备',
        user_id: b.body.data.user.id, merchant_id: secondId, payment_config_id: replacementAccount.body.merchant.configId,
        appid: second.appId, payer_openid: b.body.data.openid, mch_id: '2000000002', use_fee_cents: 5, deposit_cents: 25,
        total_cents: 30, price_version: 1, status: 'COMPENSATING', payment_status: 'SUCCESS', out_trade_no: 'synthetic-compensation-order',
        idempotency_key: 'synthetic-compensation-request', expires_ms: Date.now(), created_ms: Date.now(), updated_ms: Date.now(),
        refund_amount_cents: 30, refund_status: 'PROCESSING' });
      expect((await request(app).post(`/api/v2/rental/admin/devices/${secondDevice}/merchant`).set('Authorization', rootToken).send({ merchantId: 1, reason: '尚未退款完成' })).status).toBe(409);
      await db.execute("UPDATE ar_rental_order SET refund_status='SUCCESS',settled_ms=? WHERE id=?", [Date.now(), historical.id]);
      const moved = await request(app).post(`/api/v2/rental/admin/devices/${secondDevice}/merchant`).set('Authorization', rootToken).send({ merchantId: 1, reason: '合成设备调拨' });
      expect(moved.status).toBe(200); expect(moved.body).toMatchObject({ device: { merchantId: 1 }, requiresNewQr: true });
      expect(await db.one('SELECT merchant_id,user_id FROM ar_rental_order WHERE id=?', [historical.id])).toMatchObject({ merchant_id: secondId, user_id: b.body.data.user.id });
      await migrate(db);
      expect((await db.one('SELECT id FROM ar_device WHERE uuid=?', ['existing-default-device']))!.id).toBe(first.body.device.id);
      expect((await db.one('SELECT merchant_id FROM ar_user WHERE id=?', [rootId]))!.merchant_id).toBeNull();
      expect((await request(app).get('/health')).body).toMatchObject({ status: 'healthy', payments: 'disabled' });
    } finally {
      await db?.close();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  }, 30_000);
});
