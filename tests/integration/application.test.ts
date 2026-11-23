import { generateKeyPairSync, randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import request from '../http-client';
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/application';
import { Database } from '../../src/core/database';
import { migrate } from '../../src/core/migrations';
import { RentalAuth, bootstrapRoot } from '../../src/auth';
import { WeChatClient } from '../../src/payments/wechat';
import { seedVenue } from './venue-fixtures';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('fresh database and complete non-payment HTTP integration', () => {
  it('migrates twice, logs in, explicitly bootstraps root and manages a device without the old backend', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const database = 'ar_http_test_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const admin = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 8 }));
      await migrate(db);
      await migrate(db);
      const appId = 'wx03dbf50c15cac06f';
      // The simulated refund resolves its original account through the registry.
      const keys = generateKeyPairSync('rsa', {
        modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const client = new WeChatClient({
        appId, appSecret: 'synthetic-test-only', mchId: 'synthetic-merchant', serialNo: 'synthetic-serial',
        privateKey: keys.privateKey, platformKeys: { synthetic: keys.publicKey }, payEnabled: false, allowEnvironmentFallback: false,
        fetch: async input => {
          const url = new URL(String(input));
          expect(url.origin).toBe('https://api.weixin.qq.com');
          const code = url.searchParams.get('js_code');
          return new Response(JSON.stringify({ openid: 'test-openid-' + code }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      });
      const auth = new RentalAuth(db, client, { jwtSecret: 'integration-test-signing-key-at-least-32-bytes' });
      const { app } = createApplication({ db, client, auth });
      const login = async (code: string) => {
        const response = await request(app).post('/api/v2/rental/auth/login').send({ code });
        expect(response.status).toBe(200);
        return response.body.data;
      };
      const owner = await login('owner');
      expect(owner.user.role).toBe('user');
      const rootPhone = '+8613700137000';
      await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [owner.user.id, appId, rootPhone, '86', Date.now(), 'f'.repeat(64)]);
      await bootstrapRoot(db, owner.user.id, appId, rootPhone);
      await expect(bootstrapRoot(db, owner.user.id, appId, rootPhone)).rejects.toMatchObject({ status: 409 });
      const manager = await login('manager');
      const ordinary = await login('ordinary');
      const ownerToken = 'Bearer ' + owner.token.accessToken, ordinaryToken = 'Bearer ' + ordinary.token.accessToken;
      const promoted = await request(app).put(`/api/v2/rental/admin/users/${manager.user.id}/role`).set('Authorization', ownerToken).send({ role: 'manager' });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toMatchObject({ id: manager.user.id, role: 'manager' });
      expect((await request(app).get('/api/v2/rental/admin/overview').set('Authorization', 'Bearer ' + manager.token.accessToken)).status).toBe(401);
      const managerToken = 'Bearer ' + (await login('manager')).token.accessToken;
      const directory = (scope: string) => request(app).get('/api/v2/rental/admin/users').query({ scope }).set('Authorization', ownerToken);
      for (const scope of ['employees', 'platform']) {
        const unverified = await directory(scope);
        expect(unverified.status).toBe(200);
        expect(unverified.body).toMatchObject({ scope, total: 0, items: [] });
      }
      for (const [account, phone, code] of [[manager, '+8613800138000', 'a'], [ordinary, '+8613900139000', 'b']] as const) {
        await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [account.user.id, appId, phone, '86', Date.now(), code.repeat(64)]);
      }
      const users = await directory('employees');
      expect(users.status).toBe(200);
      expect(users.body).toMatchObject({ total: 1, items: [{ id: manager.user.id, role: 'manager', phoneVerified: true }] });
      const platform = await directory('platform');
      expect(platform.status).toBe(200);
      expect(platform.body).toMatchObject({ total: 1, items: [{ id: ordinary.user.id, role: 'user', merchantId: null, phoneVerified: true }] });
      expect(JSON.stringify(users.body)).not.toContain('test-openid');
      const uuid = 'http-device-test';
      const venue = await seedVenue(db);
      const missing = await request(app).get('/api/v2/rental/devices/context').query({ uuid }).set('Authorization', ordinaryToken);
      expect(missing.body).toMatchObject({ state: 'UNREGISTERED', actions: { canCreate: false } });
      expect((await request(app).post('/api/v2/rental/devices').set('Authorization', ordinaryToken).send({ uuid })).status).toBe(403);
      const registered = await request(app).post('/api/v2/rental/devices').set('Authorization', managerToken).send({ uuid, type: 'rokid', venueId: venue.id });
      expect(registered.status).toBe(200);
      const deviceId = registered.body.device.id;
      expect(registered.body.device).toMatchObject({ uuid, type: 'rokid' });
      const configured = await request(app).patch(`/api/v2/rental/devices/${deviceId}/config`).set('Authorization', managerToken).send({ enabled: true, venueId: venue.id, version: 0 });
      expect(configured.status).toBe(200);
      const context = await request(app).get('/api/v2/rental/devices/context').query({ uuid }).set('Authorization', ordinaryToken);
      expect(context.body).toMatchObject({ state: 'AVAILABLE', paymentReady: false, pricing: { useFeeCents: 100, depositCents: 5000, totalCents: 5100 }, actions: { canRent: false } });
      const disabledPayment = await request(app).post('/api/v2/rentals').set('Authorization', ordinaryToken).send({ deviceId, priceVersion: 1, venuePriceVersion: venue.version, idempotencyKey: 'payment-disabled-test' });
      expect(disabledPayment.status).toBe(503);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_rental_order'))!.total)).toBe(0);
      expect((await request(app).get('/api/v2/rental/admin/overview').set('Authorization', managerToken)).body).toMatchObject({ devices: { total: 1, available: 1, disabled: 0 }, orders: { total: 0, active: 0, refunding: 0 }, paymentsEnabled: false });
      expect((await request(app).get('/api/v2/rental/admin/orders').set('Authorization', ordinaryToken)).status).toBe(403);
      const seedOrder = { device_id: deviceId, device_uuid: uuid, device_name: 'Integration device', user_id: ordinary.user.id, appid: appId, payer_openid: 'private-payer-identity', mch_id: 'synthetic-merchant', use_fee_cents: 100, deposit_cents: 5000, total_cents: 5100, price_version: 1, status: 'CANCELLED', payment_status: 'CLOSED', out_trade_no: 'synthetic-management-order', idempotency_key: 'synthetic-management-request', expires_ms: Date.now(), created_ms: Date.now(), updated_ms: Date.now() };
      const seeded = await db.insert('ar_rental_order', seedOrder);
      await db.insert('ar_rental_order', { ...seedOrder, appid: 'wx0000000000000000', out_trade_no: 'synthetic-other-app-order', idempotency_key: 'synthetic-other-app-request' });
      const managedOrders = await request(app).get('/api/v2/rental/admin/orders').query({ search: uuid, status: 'CANCELLED' }).set('Authorization', managerToken);
      expect(managedOrders.status).toBe(200);
      expect(managedOrders.body).toMatchObject({ total: 1, page: 1, pageSize: 20, items: [{ id: Number(seeded.id), status: 'CANCELLED' }] });
      expect(JSON.stringify(managedOrders.body)).not.toContain('private-payer-identity');
      expect((await request(app).get('/api/v2/rental/admin/orders').query({ search: '%' }).set('Authorization', managerToken)).body.total).toBe(0);
      expect((await request(app).get('/api/v2/rental/admin/orders').query({ status: 'INVALID' }).set('Authorization', managerToken)).status).toBe(422);
      expect((await request(app).get('/api/v2/rental/admin/overview').set('Authorization', managerToken)).body.orders.total).toBe(1);
      await db.execute("UPDATE ar_rental_order SET status='ACTIVE',payment_status='SUCCESS',started_ms=? WHERE id=?", [Date.now(), seeded.id]);
      await db.insert('ar_rental_slot', { device_id: deviceId, rental_id: seeded.id, state: 'RENTED' });
      const refund = vi.spyOn(client, 'payment').mockImplementation(async (_method, _path, body) => ({
        out_trade_no: body!.out_trade_no, out_refund_no: body!.out_refund_no, amount: body!.amount, status: 'PROCESSING',
      }));
      const endRental = () => request(app).post(`/api/v2/rentals/${seeded.id}/end`).set('Authorization', managerToken);
      for (const reason of [undefined, '   ']) {
        const rejected = await endRental().send({ refundMode: 'full', reason, idempotencyKey: 'synthetic-full-refund' });
        expect(rejected.status).toBe(422);
      }
      expect((await db.one('SELECT status FROM ar_rental_order WHERE id=?', [seeded.id]))!.status).toBe('ACTIVE');
      expect(refund).not.toHaveBeenCalled();
      const ended = await endRental().send({ refundMode: 'deposit', idempotencyKey: 'synthetic-deposit-refund' });
      expect(ended.status).toBe(200);
      expect(ended.body.rental).toMatchObject({ refundMode: 'deposit', refundAmountCents: 5000, refundStatus: 'PROCESSING' });
      expect((await db.one('SELECT end_reason FROM ar_rental_order WHERE id=?', [seeded.id]))!.end_reason).toBeNull();
      expect((await db.one('SELECT state FROM ar_rental_slot WHERE rental_id=?', [seeded.id]))!.state).toBe('SETTLING');
      expect(refund).toHaveBeenCalledTimes(1);
      expect(refund.mock.calls[0][2]).not.toHaveProperty('reason');
      expect((await request(app).post('/api/v2/rental/auth/refresh').send({ refreshToken: ordinary.token.accessToken })).status).toBe(401);
      expect((await request(app).post('/api/v2/rental/auth/refresh').send({ refreshToken: ordinary.token.refreshToken })).status).toBe(200);
      expect((await request(app).get('/api/v2/rentals').set('Authorization', 'Bearer ' + ordinary.token.refreshToken)).status).toBe(401);
      expect((await request(app).put(`/api/v2/rental/admin/users/${manager.user.id}/role`).set('Authorization', ownerToken).send({ role: 'user' })).status).toBe(200);
      expect((await request(app).post('/api/v2/rental/devices').set('Authorization', managerToken).send({ uuid: 'forbidden-device' })).status).toBe(401);
      const demotedToken = 'Bearer ' + (await login('manager')).token.accessToken;
      expect((await request(app).post('/api/v2/rental/devices').set('Authorization', demotedToken).send({ uuid: 'forbidden-device' })).status).toBe(403);
      await migrate(db);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_device'))!.total)).toBe(1);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_user'))!.total)).toBe(3);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_role_audit'))!.total)).toBe(3);
      expect((await request(app).get('/health')).body).toMatchObject({ status: 'healthy', schema: 'ready', payments: 'disabled' });
    } finally {
      await db?.close();
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });
});
