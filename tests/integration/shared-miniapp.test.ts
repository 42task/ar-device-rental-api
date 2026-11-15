import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import request from '../http-client';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/application';
import { RentalAuth, bootstrapRoot } from '../../src/auth';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import type { Row } from '../../src/core/contracts';
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
import { seedVenue } from './venue-fixtures';
import { WeChatClient } from '../../src/payments/wechat';

const appId = 'wx03dbf50c15cac06f', otherAppId = 'wx1111111111111111';
const host = 'd.4mr.cn', origin = 'https://' + host;

async function withFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated loopback AR rental test MySQL instance.');
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings), database = 'ar_shared_miniapp_' + randomBytes(10).toString('hex');
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
    db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
    await migrate(db);
    await run(await setup(db));
  } finally {
    await db?.close();
    if (created) await control.query(`DROP DATABASE ${database}`);
    await control.end();
  }
}

async function setup(db: Database) {
  const client = new WeChatClient({ appId, appSecret: 'synthetic-shared-miniapp-secret', mchId: '1000000001', payEnabled: false, allowEnvironmentFallback: false,
    fetch: async () => { throw Error('Shared-miniapp integration must not contact WeChat.'); } });
  client.codeSession = async code => ({ openid: appId + ':' + code });
  client.phoneNumber = async () => ({ phoneE164: '+8613800138000', countryCode: '86' });
  client.unlimitedCode = async () => Buffer.from('synthetic-shared-miniapp-qr');
  const registry = new MerchantRegistry(db, client, new MerchantSecrets('e'.repeat(64)));
  registry.applications.createLoginClient = (row, appSecret) => {
    const loginClient = new WeChatClient({ appId: row.app_id, appSecret, payEnabled: false, allowEnvironmentFallback: false,
      fetch: async () => { throw Error('Shared-miniapp integration must not contact WeChat.'); } });
    loginClient.codeSession = async code => ({ openid: row.app_id + ':' + code });
    loginClient.phoneNumber = client.phoneNumber;
    loginClient.unlimitedCode = client.unlimitedCode;
    return loginClient;
  };
  const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-shared-miniapp-http-signing-key-32-bytes' });
  const { app } = createApplication({ db, client, auth, merchants: registry });
  const http = (method: 'get' | 'post' | 'patch' | 'put', path: string, bearer?: string, merchantId?: number, hostname = host) => {
    const req = request(app)[method](path).set('Host', hostname);
    if (bearer) req.set('Authorization', bearer);
    if (merchantId !== undefined) req.set('X-Merchant-Id', String(merchantId));
    return req;
  };
  const login = (code: string, hostname = host) => http('post', '/api/v2/rental/auth/login', undefined, undefined, hostname).send({ code });
  const root = await login('root'); expect(root.status).toBe(200);
  const rootId = root.body.data.user.id, rootToken = 'Bearer ' + root.body.data.token.accessToken;
  await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [rootId, appId, '+8613700137000', '86', Date.now(), '1'.repeat(64)]);
  await bootstrapRoot(db, rootId, appId, '+8613700137000');
  const shared = (code = 'shared') => http('post', '/api/v2/rental/admin/merchants', rootToken).send({ code, name: 'Synthetic ' + code, miniappOwnerId: 1, status: 'active', mchId: '2000000001', payEnabled: false });
  return { db, app, client, registry, http, login, rootId, rootToken, shared };
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL shared-miniapp entry and merchant management', () => {
  it('upgrades an existing schema-8 entry, permits shared merchants and retains independent-entry uniqueness', async () => withFixture(async f => {
    const venue = await seedVenue(f.db);
    await f.db.insert('ar_device', { uuid: 'pre-shared-schema-eight', name: 'Synthetic existing device', device_type: 'ios', merchant_id: 1, venue_id: venue.id });
    // Remove later authoritative tables and their ledger before recreating the
    // pre-shared constraints. Merely lowering meta leaves an impossible upgrade.
    for (const table of ['ar_application_merchant', 'ar_application', 'ar_merchant_membership', 'ar_schema_migration']) await f.db.execute(`DROP TABLE ${table}`);
    if (!await f.db.one("SHOW COLUMNS FROM ar_rental_config WHERE Field='use_fee_cents'")) {
      await f.db.execute('ALTER TABLE ar_rental_config ADD COLUMN use_fee_cents int unsigned NOT NULL DEFAULT 0, ADD COLUMN deposit_cents int unsigned NOT NULL DEFAULT 0');
      await f.db.execute('DROP TABLE ar_legacy_device_pricing_archive');
    }
    await f.db.execute('ALTER TABLE ar_device DROP FOREIGN KEY fk_ar_device_merchant');
    await f.db.execute('ALTER TABLE ar_merchant DROP FOREIGN KEY fk_ar_merchant_miniapp_owner');
    await f.db.execute('ALTER TABLE ar_merchant DROP INDEX uq_ar_merchant_entry_hostname, DROP INDEX uq_ar_merchant_entry_app_id, DROP COLUMN entry_hostname, DROP COLUMN entry_app_id, DROP COLUMN miniapp_owner_id, ADD UNIQUE KEY origin(origin), ADD UNIQUE KEY hostname(hostname), ADD UNIQUE KEY app_id(app_id)');
    await f.db.execute('UPDATE ar_schema_meta SET version=8');
    expect(await f.db.one("SHOW COLUMNS FROM ar_merchant WHERE Field='miniapp_owner_id'")).toBeNull();
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(8);
    await migrate(f.db); await migrate(f.db);
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(SCHEMA_VERSION);
    expect(await f.db.one("SELECT merchant_id FROM ar_device WHERE uuid='pre-shared-schema-eight'")).toEqual({ merchant_id: 1 });

    const child = await f.shared(); expect(child.status).toBe(200);
    const merchant = child.body.merchant;
    expect(merchant).toMatchObject({ miniappOwnerId: 1, appId, origin, mchId: '2000000001', configuration: { hasAppSecret: true } });
    expect((await f.registry.resolveHost(host)).id).toBe(1);
    expect((await f.registry.runtime(merchant.id)).configId).toBe(merchant.configId);
    expect((await f.shared('shared-two')).status).toBe(200);
    expect((await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'duplicate-app', name: 'Duplicate AppID entry', miniappOwnerId: null, appId, origin: 'https://duplicate.example.test', status: 'active', payEnabled: false })).status).toBe(409);
    expect((await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'duplicate-host', name: 'Duplicate host entry', miniappOwnerId: null, appId: otherAppId, origin, status: 'active', payEnabled: false })).status).toBe(409);
    expect((await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'nested-child', name: 'Nested shared entry', miniappOwnerId: merchant.id, status: 'active', payEnabled: false })).status).toBe(422);

    const independent = await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'independent', name: 'Independent entry', miniappOwnerId: null, origin: 'https://independent.example.test', appId: otherAppId, status: 'active', payEnabled: false, credentials: { appSecret: 'synthetic-independent-secret' } });
    expect(independent.status).toBe(200);
    const dependent = await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'independent-child', name: 'Independent shared merchant', miniappOwnerId: independent.body.merchant.id, status: 'active', payEnabled: false });
    expect(dependent.status).toBe(200);
    expect((await f.http('patch', `/api/v2/rental/admin/merchants/${independent.body.merchant.id}`, f.rootToken).send({ miniappOwnerId: 1 })).status).toBe(409);
    expect((await f.http('patch', '/api/v2/rental/admin/merchants/1', f.rootToken).send({ miniappOwnerId: independent.body.merchant.id })).status).toBe(409);
    expect((await f.db.one('SELECT miniapp_owner_id FROM ar_merchant WHERE id=?', [independent.body.merchant.id]))!.miniapp_owner_id).toBeNull();
    await expect(f.db.execute('INSERT INTO ar_device(uuid,name,device_type,merchant_id,venue_id) VALUES(?,?,?,?,?)', ['owner-null', 'Synthetic invalid owner', 'ios', null, venue.id])).rejects.toMatchObject({ code: 'ER_BAD_NULL_ERROR' });
    await expect(f.db.execute('INSERT INTO ar_device(uuid,name,device_type,merchant_id,venue_id) VALUES(?,?,?,?,?)', ['owner-missing', 'Synthetic missing owner', 'ios', 2147483647, venue.id])).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  }), 30_000);

  it('authenticates shared-entry staff once and scopes device registration and administration to their merchant', async () => withFixture(async f => {
    const creation = await f.shared(); expect(creation.status).toBe(200);
    const childId = creation.body.merchant.id;
    const venue = await seedVenue(f.db, childId);
    const staff = await f.db.insert('ar_user', { appid: appId, openid: appId + ':staff', merchant_id: childId, role: 'adminer', auth_version: 1 });
    await f.db.insert('ar_merchant_membership', { user_id: staff.id, merchant_id: childId, role: 'adminer', status: 'active', authorization_version: 1, updated_ms: Date.now() });
    const login = await f.login('staff'); expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ id: staff.id, merchantId: childId, role: 'adminer' });
    const staffToken = 'Bearer ' + login.body.data.token.accessToken;
    const customer = await f.login('customer'); expect(customer.status).toBe(200);
    const customerToken = 'Bearer ' + customer.body.data.token.accessToken;
    expect((await f.http('get', '/api/v2/rental/admin/overview', staffToken)).status).toBe(403);
    expect((await f.http('get', '/api/v2/rental/admin/overview', staffToken, 1)).status).toBe(403);
    expect((await f.http('get', '/api/v2/rental/admin/overview', staffToken, childId)).status).toBe(200);
    expect((await f.http('get', '/api/v2/rental/merchant', customerToken, childId)).status).toBe(403);
    expect((await f.http('post', '/api/v2/rental/devices', customerToken).send({ uuid: 'ordinary-forbidden', merchantId: childId })).status).toBe(403);
    const device = await f.http('post', '/api/v2/rental/devices', staffToken, childId).send({ uuid: 'shared-staff-device', type: 'rokid', merchantId: 1, venueId: venue.id });
    expect(device.status).toBe(200);
    expect(device.body.device).toMatchObject({ uuid: 'shared-staff-device', merchantId: childId });
    expect(await f.db.one('SELECT merchant_id FROM ar_device WHERE id=?', [device.body.device.id])).toEqual({ merchant_id: childId });
    expect((await f.http('post', '/api/v2/rental/devices', staffToken, 1).send({ uuid: 'spoofed-staff-scope' })).status).toBe(403);
    const rootDevice = await f.http('post', '/api/v2/rental/devices', f.rootToken, childId).send({ uuid: 'shared-root-device', merchantId: 2147483647, venueId: venue.id });
    expect(rootDevice.status).toBe(200); expect(rootDevice.body.device.merchantId).toBe(childId);
    const list = await f.http('get', '/api/v2/rental/admin/devices', staffToken, childId);
    expect(list.status).toBe(200); expect(list.body.items.map((row: Row) => row.device.id).sort()).toEqual([device.body.device.id, rootDevice.body.device.id].sort());
    const context = await f.http('get', '/api/v2/rental/devices/context', customerToken).query({ uuid: 'shared-staff-device' });
    expect(context.status).toBe(200); expect(context.body.device.merchantId).toBe(childId);
    expect((await f.db.one('SELECT merchant_id FROM ar_user WHERE id=?', [customer.body.data.user.id]))!.merchant_id).toBeNull();

    const identity = await f.db.one('SELECT id FROM ar_user_wechat_identity WHERE user_id=? AND appid=?', [staff.id, appId]);
    await f.db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash,identity_id) VALUES(?,?,?,?,?,?,?)', [staff.id, appId, '+8613800138000', '86', Date.now(), '2'.repeat(64), identity!.id]);
    const challenge = await f.http('post', '/api/v2/rental/admin/auth/challenges').set('Origin', origin).send({});
    expect(challenge.status).toBe(200);
    const browserCookie = (challenge.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('ar_admin_browser='))!.split(';')[0];
    expect((await f.http('post', `/api/v2/rental/admin/auth/challenges/${challenge.body.id}/scan`, staffToken).send({})).status).toBe(200);
    expect((await f.http('post', `/api/v2/rental/admin/auth/challenges/${challenge.body.id}/confirm`, staffToken).send({ approved: true })).status).toBe(200);
    const consumed = await f.http('post', `/api/v2/rental/admin/auth/challenges/${challenge.body.id}/consume`).set('Origin', origin).set('Cookie', browserCookie).send({});
    expect(consumed.status).toBe(200); expect(consumed.body.merchant.id).toBe(childId);
    const sessionCookie = (consumed.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('ar_admin_session='))!.split(';')[0];
    const restored = await f.http('get', '/api/v2/rental/admin/auth/session').set('Cookie', sessionCookie);
    expect(restored.status).toBe(200); expect(restored.body.merchant.id).toBe(childId);
    expect((await f.http('get', '/api/v2/rental/admin/overview', undefined, childId).set('Cookie', sessionCookie)).status).toBe(200);
    expect((await f.http('get', '/api/v2/rental/admin/overview', undefined, 1).set('Cookie', sessionCookie)).status).toBe(403);
  }), 30_000);

  it('preserves independent AppID login and management isolation alongside the shared entry', async () => withFixture(async f => {
    const child = await f.shared(); expect(child.status).toBe(200);
    const independent = await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'independent', name: 'Synthetic independent merchant', miniappOwnerId: null, origin: 'https://independent.example.test', appId: otherAppId, status: 'active', mchId: '3000000001', payEnabled: false, credentials: { appSecret: 'synthetic-independent-secret' } });
    expect(independent.status).toBe(200);
    const separateId = independent.body.merchant.id;
    const venue = await seedVenue(f.db, separateId);
    const customer = await f.login('same-customer'), separateCustomer = await f.login('same-customer', 'independent.example.test');
    expect(customer.status).toBe(200); expect(separateCustomer.status).toBe(200);
    expect(customer.body.data.user.id).not.toBe(separateCustomer.body.data.user.id);
    expect(separateCustomer.body.data).toMatchObject({ appId: otherAppId, user: { merchantId: null }, managementMerchant: null });
    const token = 'Bearer ' + customer.body.data.token.accessToken;
    expect((await f.http('get', '/api/v2/rentals', token, undefined, 'independent.example.test')).status).toBe(401);
    await f.db.execute("UPDATE ar_user SET role='manager',merchant_id=?,auth_version=auth_version+1 WHERE id=?", [separateId, separateCustomer.body.data.user.id]);
    await f.db.insert('ar_merchant_membership', { user_id: separateCustomer.body.data.user.id, merchant_id: separateId, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
    const refreshedStaff = await f.login('same-customer', 'independent.example.test'); expect(refreshedStaff.status).toBe(200);
    const separateToken = 'Bearer ' + refreshedStaff.body.data.token.accessToken;
    expect((await f.http('get', '/api/v2/rental/admin/overview', separateToken, separateId, 'independent.example.test')).status).toBe(200);
    expect((await f.http('get', '/api/v2/rental/admin/overview', separateToken, child.body.merchant.id, 'independent.example.test')).status).toBe(403);
    const device = await f.http('post', '/api/v2/rental/devices', f.rootToken, separateId).send({ uuid: 'independent-device', venueId: venue.id });
    expect(device.status).toBe(200); expect(device.body.device.merchantId).toBe(separateId);
    expect((await f.http('get', '/api/v2/rental/devices/context', token).query({ uuid: 'independent-device' })).status).toBe(409);
  }), 30_000);

  it('assigns an account into and out of a shared merchant using explicit consent in the same application', async () => withFixture(async f => {
    const child = await f.shared(); expect(child.status).toBe(200);
    const childId = child.body.merchant.id;
    const initial = await f.login('future-staff'); expect(initial.status).toBe(200);
    const userId = initial.body.data.user.id, oldToken = 'Bearer ' + initial.body.data.token.accessToken;
    const assigned = await f.http('post', `/api/v2/rental/admin/users/${userId}/merchant`, f.rootToken).send({ merchantId: childId, role: 'manager', reason: 'Synthetic explicit shared-entry staff assignment' });
    expect(assigned.status).toBe(200);
    const binding = assigned.body.binding.token;
    expect((await f.http('post', '/api/v2/rental/auth/login').send({ code: 'future-staff', bindToken: binding })).status).toBe(403);
    expect((await f.http('post', '/api/v2/rental/auth/merchant-binding/confirm', f.rootToken).send({ bindToken: binding })).status).toBe(403);
    expect((await f.http('post', '/api/v2/rental/auth/merchant-binding/confirm', oldToken).send({ bindToken: binding })).status).toBe(200);
    const bound = await f.http('post', '/api/v2/rental/auth/login').send({ code: 'future-staff', bindToken: binding });
    expect(bound.status).toBe(200);
    expect(bound.body.data).toMatchObject({ appId, user: { id: userId, merchantId: childId, role: 'manager' }, merchant: { id: childId, name: 'Synthetic shared' } });
    const token = 'Bearer ' + bound.body.data.token.accessToken;
    expect((await f.http('get', '/api/v2/rentals', oldToken)).status).toBe(401);
    expect((await f.http('get', '/api/v2/rental/admin/overview', token, childId)).status).toBe(200);
    expect((await f.http('post', '/api/v2/rental/auth/login').send({ code: 'future-staff', bindToken: binding })).status).toBe(409);

    const returning = await f.http('post', `/api/v2/rental/admin/users/${userId}/merchant`, f.rootToken).send({ merchantId: 1, role: 'user', reason: 'Synthetic explicit return from shared merchant' });
    expect(returning.status).toBe(200);
    expect((await f.http('post', '/api/v2/rental/auth/merchant-binding/confirm', token).send({ bindToken: returning.body.binding.token })).status).toBe(200);
    const returned = await f.http('post', '/api/v2/rental/auth/login').send({ code: 'future-staff', bindToken: returning.body.binding.token });
    expect(returned.status).toBe(200);
    expect(returned.body.data).toMatchObject({ user: { id: userId, merchantId: null, role: 'user' }, managementMerchant: null, entry: { id: 1 } });
    expect(await f.db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=?', [userId])).toEqual({ merchant_id: null, auth_version: 2 });
    expect(await f.db.query('SELECT * FROM ar_user_wechat_identity WHERE user_id=?', [userId])).toHaveLength(1);
    expect(await f.db.query('SELECT merchant_id,previous_merchant_id FROM ar_merchant_audit WHERE target_id=? AND action=? ORDER BY id', [userId, 'USER_TRANSFERRED'])).toEqual([{ merchant_id: childId, previous_merchant_id: null }, { merchant_id: 1, previous_merchant_id: childId }]);
  }), 30_000);

  it('keeps shared identity registration available when the entry owner is paused and another merchant is active', async () => withFixture(async f => {
    const child = await f.shared(); expect(child.status).toBe(200);
    const venue = await seedVenue(f.db, 1, 100, 0);
    const device = await f.http('post', '/api/v2/rental/devices', f.rootToken).send({ uuid: 'paused-entry-device', venueId: venue.id });
    expect(device.status).toBe(200);
    // Only readiness is synthetic; paused rentals must stop before any provider call.
    f.client.isPaymentReady = () => true;
    const configured = await f.http('patch', `/api/v2/rental/devices/${device.body.device.id}/config`, f.rootToken).send({ enabled: true, version: 0 });
    expect(configured.status).toBe(200); expect(configured.body.actions.canRent).toBe(true);
    await f.db.execute("UPDATE ar_merchant SET status='paused' WHERE id=1");
    const newCustomer = await f.login('new-with-paused-entry'); expect(newCustomer.status).toBe(200);
    const bearer = 'Bearer ' + newCustomer.body.data.token.accessToken;
    const context = await f.http('get', '/api/v2/rental/devices/context', bearer).query({ uuid: 'paused-entry-device' });
    expect(context.status).toBe(200); expect(context.body).toMatchObject({ paymentReady: false, actions: { canRent: false } });
    expect((await f.http('post', '/api/v2/rentals', bearer).send({ deviceId: device.body.device.id, priceVersion: 1, venuePriceVersion: venue.version, idempotencyKey: 'paused-owner-rental-test' })).status).toBe(503);
    expect(Number((await f.db.one('SELECT COUNT(*) AS total FROM ar_rental_order'))!.total)).toBe(0);
    await f.db.execute("UPDATE ar_merchant SET status='paused' WHERE app_id=?", [appId]);
    const platformOnly = await f.login('new-while-all-paused');
    expect(platformOnly.status).toBe(200); expect(platformOnly.body.data).toMatchObject({ user: { merchantId: null }, entry: { status: 'active' }, managementMerchant: null });
    expect((await f.login('new-with-paused-entry')).status).toBe(200);
    expect((await f.http('post', '/api/v2/rental/auth/refresh').send({ refreshToken: newCustomer.body.data.token.refreshToken })).status).toBe(200);
  }), 30_000);
});
