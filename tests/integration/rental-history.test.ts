import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import request from '../http-client';
import { createApplication } from '../../src/application';
import { RentalAuth } from '../../src/auth';
import type { Row } from '../../src/core/contracts';
import { Database } from '../../src/core/database';
import { migrate } from '../../src/core/migrations';
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
import { WeChatClient } from '../../src/payments/wechat';
import { seedVenue } from './venue-fixtures';

const appId = 'wx03dbf50c15cac06f';
const otherAppId = 'wx1111111111111111';
const host = 'd.4mr.cn';
const base = '/api/v2/rental/admin/';
const started = Date.UTC(2026, 0, 2);

async function setup(db: Database) {
  const client = new WeChatClient({ appId, appSecret: 'synthetic-history-secret', mchId: '1000000001',
    payEnabled: false, allowEnvironmentFallback: false, fetch: async () => { throw Error('Rental history test cannot call WeChat.'); } });
  client.codeSession = async code => ({ openid: 'synthetic-history-' + code });
  const registry = new MerchantRegistry(db, client, new MerchantSecrets('c'.repeat(64)));
  const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-history-signing-key-at-least-32-bytes', rootPhone: '' });
  const { app } = createApplication({ db, client, auth, merchants: registry });
  const http = (method: 'get' | 'post', path: string, bearer?: string, merchant?: number) => {
    const operation = request(app)[method](path).set('Host', host);
    if (bearer) operation.set('Authorization', bearer);
    if (merchant !== undefined) operation.set('X-Merchant-Id', String(merchant));
    return operation;
  };
  const login = async (code: string, role?: 'manager' | 'adminer' | 'root') => {
    const signIn = () => http('post', '/api/v2/rental/auth/login').send({ code });
    let response = await signIn();
    expect(response.status).toBe(200);
    const id = Number(response.body.data.user.id);
    if (role) {
      if (role === 'root') await db.execute("UPDATE ar_user SET role='root' WHERE id=?", [id]);
      else await db.insert('ar_merchant_membership', { user_id: id, merchant_id: 1, role, status: 'active', authorization_version: 1, updated_ms: started });
      response = await signIn();
      expect(response.body.data.user.role).toBe(role);
    }
    return { id, bearer: 'Bearer ' + response.body.data.token.accessToken };
  };
  const root = await login('root', 'root');
  const child = await http('post', base + 'merchants', root.bearer).send({ code: 'history-child', name: 'Synthetic history child',
    miniappOwnerId: 1, status: 'active', mchId: '2000000001', payEnabled: false });
  expect(child.status).toBe(200);
  const merchant = Number(child.body.merchant.id);
  const venue = await seedVenue(db);
  const childVenue = await seedVenue(db, merchant);
  const device = await db.insert('ar_device', { sn: 'History-Device', name: 'Current name', merchant_id: 1, venue_id: venue.id });
  const alternate = await db.insert('ar_device', { sn: 'history-device', name: 'Other name', merchant_id: 1, venue_id: venue.id });
  const order = (user: number, overrides: Row = {}) => db.insert('ar_rental_order', {
    device_id: device.id, device_sn: device.sn, device_name: 'Historical % name', user_id: user, appid: appId,
    mch_id: '1000000001', payer_openid: 'synthetic-order-payer', use_fee_cents: 100, deposit_cents: 5000, total_cents: 5100,
    price_version: 1, status: 'ENDED', payment_status: 'SUCCESS', out_trade_no: randomBytes(16).toString('hex'),
    idempotency_key: randomBytes(8).toString('hex'), paid_ms: started, started_ms: started, ended_ms: started + 500,
    expires_ms: started + 1000, created_ms: started - 1000, updated_ms: started, merchant_id: 1, venue_id: venue.id, ...overrides,
  });
  return { db, http, login, root, merchant, device, childVenue, alternate, order };
}

async function withFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') {
    throw Error('Use the dedicated loopback AR rental test MySQL instance.');
  }
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings);
  const name = 'ar_rental_history_' + randomBytes(10).toString('hex');
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`);
    created = true;
    db = new Database(mysql.createPool({ ...settings, database: name, connectionLimit: 4 }));
    await migrate(db);
    await run(await setup(db));
  } finally {
    await db?.close();
    if (created) await control.query(`DROP DATABASE ${name}`);
    await control.end();
  }
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('merchant rental history', () => {
  it('scopes order events and renter contact data to the original merchant and app', async () => withFixture(async f => {
    const admin = await f.login('admin', 'adminer'), manager = await f.login('manager', 'manager');
    const renter = await f.login('renter'), wrongAppPhone = await f.login('wrong-phone'), pending = await f.login('pending');
    const childRenter = await f.login('child'), compensating = await f.login('compensating');
    await f.db.update('ar_user', renter.id, { nickname: 'Synthetic % guest', avatar: '/api/v2/rental/profile/avatars/' + 'a'.repeat(64) });
    await f.db.update('ar_user', wrongAppPhone.id, { tel: '+12025550103' });
    await f.db.insert('ar_user_phone', { user_id: renter.id, appid: appId, phone_e164: '+12025550101', country_code: '1', verified_ms: started, code_hash: '1'.repeat(64) });
    await f.db.insert('ar_user_phone', { user_id: wrongAppPhone.id, appid: otherAppId, phone_e164: '+12025550102', country_code: '1', verified_ms: started, code_hash: '2'.repeat(64) });

    const original = await f.order(renter.id);
    await f.order(renter.id, { device_id: f.alternate.id, device_sn: f.alternate.sn, started_ms: started + 1000, status: 'ACTIVE', ended_ms: null });
    await f.order(wrongAppPhone.id);
    const pendingOrder = await f.order(pending.id, { status: 'PENDING_PAYMENT', payment_status: 'NOTPAY', started_ms: null, paid_ms: null });
    await f.order(compensating.id, { status: 'COMPENSATING', started_ms: null });
    const child = await f.order(childRenter.id, { merchant_id: f.merchant, venue_id: f.childVenue.id });
    const wrongApp = await f.order(childRenter.id, { appid: otherAppId });
    await f.db.update('ar_device', f.device.id, { merchant_id: f.merchant, venue_id: f.childVenue.id });

    const record = (order: Row, type: string, owner: number, created: number, details: Row = {}) => f.db.insert('ar_rental_event', {
      rental_id: order.id, actor_user_id: type === 'RENTAL_ENDED' ? admin.id : null, merchant_id: owner, event: type, details, created_ms: created,
    });
    const settled = await record(original, 'RENTAL_ENDED', 1, started + 100, { reason: 'Synthetic return', refundMode: 'deposit', refundAmountCents: 5000, openid: 'private-placeholder' });
    const reserved = await record(pendingOrder, 'RESERVED', 1, started);
    await record(original, 'PAYMENT_CONFIRMED', f.merchant, started + 200);
    const childEvent = await record(child, 'PAYMENT_CONFIRMED', f.merchant, started + 300);
    await record(wrongApp, 'PAYMENT_CONFIRMED', 1, started + 400);

    for (const path of ['rental-events', 'renters']) {
      expect((await f.http('get', base + path)).status).toBe(401);
      expect((await f.http('get', base + path, manager.bearer, f.merchant)).status).toBe(403);
      expect((await f.http('get', base + path, renter.bearer)).status).toBe(403);
      expect((await f.http('get', base + path, admin.bearer, f.merchant)).status).toBe(403);
      expect((await f.http('get', base + path, f.root.bearer)).status).toBe(422);
    }
    const events = await f.http('get', base + 'rental-events', admin.bearer, 1);
    expect(events.status, JSON.stringify(events.body)).toBe(200);
    expect(events.headers['cache-control']).toBe('no-store');
    expect(events.body.items.map((entry: Row) => entry.id)).toEqual([settled.id, reserved.id]);
    expect(events.body.items[0]).toEqual({ id: settled.id, rentalId: original.id, actorUserId: admin.id, event: 'RENTAL_ENDED',
      deviceName: 'Historical % name', uuid: null, sn: f.device.sn, createdAt: new Date(started + 100).toISOString(),
      details: { reason: 'Synthetic return', refundMode: 'deposit', refundAmountCents: 5000 } });
    expect((await f.http('get', base + 'rental-events', admin.bearer, 1).query({ search: '%', event: 'RENTAL_ENDED' })).body.total).toBe(1);
    expect((await f.http('get', base + 'rental-events', admin.bearer, 1).query({ rentalId: child.id })).body.total).toBe(0);
    const managerEvents = await f.http('get', base + 'rental-events', manager.bearer, 1);
    expect(managerEvents.status).toBe(200);
    expect(managerEvents.body).toEqual(events.body);
    expect((await f.http('get', base + 'rental-events', manager.bearer, 1).query({ rentalId: child.id })).body.total).toBe(0);
    expect((await f.http('get', base + 'rental-events', f.root.bearer, 1)).body).toEqual(events.body);
    expect((await f.http('get', base + 'rental-events', f.root.bearer, f.merchant)).body.items.map((entry: Row) => entry.id)).toEqual([childEvent.id]);

    expect((await f.http('get', base + 'renters', manager.bearer, 1)).status).toBe(403);
    const renters = await f.http('get', base + 'renters', admin.bearer, 1);
    expect(renters.status, JSON.stringify(renters.body)).toBe(200);
    expect(renters.headers['cache-control']).toBe('no-store');
    expect(renters.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(renters.body.items[0]).toEqual({ id: renter.id, nickname: 'Synthetic % guest', avatarUrl: '/api/v2/rental/profile/avatars/' + 'a'.repeat(64),
      phone: '+12025550101', rentalCount: 2, firstRentalAt: new Date(started).toISOString(), lastRentalAt: new Date(started + 1000).toISOString() });
    expect(renters.body.items[1]).toMatchObject({ id: wrongAppPhone.id, phone: null });
    const matched = await f.http('get', base + 'renters', admin.bearer, 1).query({ deviceSn: f.device.sn, search: '%' });
    expect(matched.body.items).toEqual([expect.objectContaining({ id: renter.id, rentalCount: 1, lastRentalAt: new Date(started).toISOString() })]);
    expect((await f.http('get', base + 'renters', admin.bearer, 1).query({ page: 2 })).body).toMatchObject({ items: [], page: 2, total: 2 });
    expect((await f.http('get', base + 'renters', f.root.bearer, f.merchant)).body.items.map((entry: Row) => entry.id)).toEqual([childRenter.id]);

    await f.db.execute("UPDATE ar_user_wechat_identity SET status='revoked' WHERE user_id=? AND appid=?", [renter.id, appId]);
    const revokedContact = await f.http('get', base + 'renters', admin.bearer, 1).query({ search: String(renter.id) });
    expect(revokedContact.body.items).toEqual([expect.objectContaining({ id: renter.id, phone: null })]);
    await f.db.execute("UPDATE ar_merchant_membership SET role='manager',authorization_version=2 WHERE user_id=?", [admin.id]);
    expect((await f.http('get', base + 'rental-events', admin.bearer, 1)).status).toBe(200);
    expect((await f.http('get', base + 'renters', admin.bearer, 1)).status).toBe(403);
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked',authorization_version=2 WHERE user_id=?", [manager.id]);
    expect((await f.http('get', base + 'rental-events', manager.bearer, 1)).status).toBe(403);
  }), 30_000);
});
