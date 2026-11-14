import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import request from '../http-client';
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/application';
import { bootstrapRoot, RentalAuth } from '../../src/auth';
import type { Row } from '../../src/core/contracts';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
import { WeChatClient } from '../../src/payments/wechat';

const appId = 'wx03dbf50c15cac06f', host = 'd.4mr.cn';

async function withFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated loopback AR rental test MySQL instance.');
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings), database = 'ar_venues_' + randomBytes(10).toString('hex');
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
    db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
    await migrate(db);
    await run(await setup(db));
  } finally {
    vi.restoreAllMocks();
    await db?.close();
    if (created) await control.query(`DROP DATABASE ${database}`);
    await control.end();
  }
}

async function withLegacyDatabase(run: (db: Database) => Promise<void>): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated loopback AR rental test MySQL instance.');
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings), database = 'ar_venue_upgrade_' + randomBytes(10).toString('hex');
  let db: Database | undefined;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
    for (const file of ['001-core.sql', 'user-schema.sql', '002-rentals.sql', '003-admin.sql', '004-phone.sql']) {
      const source = await readFile('database/' + file, 'utf8');
      for (const sql of source.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await db.execute(sql);
    }
    await db.execute('CREATE TABLE ar_schema_meta(name varchar(64) PRIMARY KEY,version int NOT NULL) ENGINE=InnoDB');
    await db.execute("INSERT INTO ar_schema_meta VALUES('ar-device-rental-api',7)");
    await run(db);
  } finally {
    vi.restoreAllMocks(); await db?.close(); await control.query(`DROP DATABASE IF EXISTS ${database}`); await control.end();
  }
}

async function setup(db: Database) {
  const client = new WeChatClient({ appId, appSecret: 'synthetic-venues-secret', mchId: '1000000001', payEnabled: false, allowEnvironmentFallback: false,
    fetch: async () => { throw Error('Venue integration must not contact WeChat.'); } });
  client.codeSession = async code => ({ openid: appId + ':' + code });
  class SyntheticRegistry extends MerchantRegistry {
    override async clientForConfig(id: number, config?: Row, merchant?: Row) {
      const payment = await super.clientForConfig(id, config, merchant);
      payment.codeSession = async code => ({ openid: appId + ':' + code });
      return payment;
    }
  }
  const registry = new SyntheticRegistry(db, client, new MerchantSecrets('d'.repeat(64)));
  const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-venues-http-signing-key-at-least-32-bytes' });
  const { app } = createApplication({ db, client, auth, merchants: registry });
  const http = (method: 'get' | 'post' | 'patch' | 'delete', path: string, bearer?: string, merchantId?: number) => {
    const req = request(app)[method](path).set('Host', host);
    if (bearer) req.set('Authorization', bearer);
    if (merchantId !== undefined) req.set('X-Merchant-Id', String(merchantId));
    return req;
  };
  const login = async (code: string) => {
    const response = await http('post', '/api/v2/rental/auth/login').send({ code });
    expect(response.status).toBe(200);
    return response.body.data;
  };
  const root = await login('root'), rootId = root.user.id, rootToken = 'Bearer ' + root.token.accessToken;
  await db.execute('INSERT INTO ar_user_phone(user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES(?,?,?,?,?,?)', [rootId, appId, '+8613700137000', '86', Date.now(), 'a'.repeat(64)]);
  if (root.user.role !== 'root') await bootstrapRoot(db, rootId, appId, '+8613700137000');
  const staff = async (code: string, role: string, merchantId = 1) => {
    const row = await db.insert('ar_user', { appid: appId, openid: appId + ':' + code, role, merchant_id: merchantId });
    if (['manager', 'adminer'].includes(role)) await db.insert('ar_merchant_membership', { user_id: row.id, merchant_id: merchantId, role, status: 'active', authorization_version: 1, updated_ms: Date.now() });
    const identity = await login(code);
    return { id: row.id, token: 'Bearer ' + identity.token.accessToken, identity };
  };
  const venueInput = { name: 'Synthetic test venue', address: 'Synthetic address', contactName: 'Synthetic contact', contactPhone: '+8613800138000', description: 'Synthetic venue description', status: 'active', useFeeCents: 123, depositCents: 4567 };
  return { db, app, registry, http, login, rootId, rootToken, staff, venueInput };
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL venue migration and scoped venue management', () => {
  it('resumes a legacy venue backfill without merging devices or overwriting historical pricing and orders', async () => withLegacyDatabase(async db => {
    const f = { db, rootId: 1 };
    await db.insert('ar_user', { id: 1, appid: appId, openid: appId + ':root', role: 'root' });
    const active = await f.db.insert('ar_device', { uuid: 'venue-legacy-active', name: 'Synthetic active device', device_type: 'ios', merchant_id: 1 });
    const paused = await f.db.insert('ar_device', { uuid: 'venue-legacy-disabled', name: 'Synthetic disabled device', device_type: 'ios', merchant_id: 1 });
    const unconfigured = await f.db.insert('ar_device', { uuid: 'venue-legacy-unconfigured', name: 'Synthetic unconfigured device', device_type: 'ios', merchant_id: 1 });
    const now = Date.now();
    await f.db.insert('ar_rental_config', { device_id: active.id, merchant_id: 1, enabled: 1, use_fee_cents: 123, deposit_cents: 4567, version: 7, updated_ms: now, updated_by: f.rootId });
    await f.db.insert('ar_rental_config', { device_id: paused.id, merchant_id: 1, enabled: 0, use_fee_cents: 321, deposit_cents: 7654, version: 3, updated_ms: now, updated_by: f.rootId });
    await f.db.insert('ar_rental_order', { device_id: active.id, device_uuid: active.uuid, device_name: active.name, user_id: f.rootId, appid: appId, payer_openid: appId + ':root', mch_id: '1000000001', merchant_id: 1,
      use_fee_cents: 99, deposit_cents: 1100, total_cents: 1199, price_version: 2, status: 'ENDED', payment_status: 'SUCCESS', out_trade_no: 'synthetic-venue-old-order', idempotency_key: 'synthetic-venue-old-request', expires_ms: now - 1000, created_ms: now - 2000, updated_ms: now, refund_amount_cents: 1100, refund_status: 'SUCCESS' });
    const orderBefore = await f.db.one('SELECT * FROM ar_rental_order');
    const configsBefore = await f.db.query('SELECT * FROM ar_rental_config ORDER BY device_id');
    const execute = Database.prototype.execute;
    const interrupted = vi.spyOn(Database.prototype, 'execute').mockImplementation(async function(this: Database, sql, params) {
      if (sql.startsWith('UPDATE ar_device d JOIN ar_venue')) throw Error('Synthetic interrupted venue backfill');
      return execute.call(this, sql, params);
    });
    await expect(migrate(f.db)).rejects.toThrow('Synthetic interrupted venue backfill');
    interrupted.mockRestore();
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBeLessThan(10);
    const partial = await f.db.query('SELECT * FROM ar_venue ORDER BY legacy_device_id');
    expect(partial).toHaveLength(3);
    expect(partial.map(row => ({ device: row.legacy_device_id, fee: row.use_fee_cents, deposit: row.deposit_cents, status: row.status }))).toEqual([
      { device: active.id, fee: 123, deposit: 4567, status: 'active' }, { device: paused.id, fee: 321, deposit: 7654, status: 'paused' }, { device: unconfigured.id, fee: 0, deposit: 0, status: 'paused' },
    ]);
    expect(partial.every(row => row.name.includes('历史配置迁移场地'))).toBe(true);
    await f.db.execute('UPDATE ar_venue SET name=?,use_fee_cents=? WHERE legacy_device_id=?', ['Synthetic verified recovery venue', 777, active.id]);
    await migrate(f.db); await migrate(f.db);
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(SCHEMA_VERSION);
    expect(await f.db.query('SELECT * FROM ar_venue')).toHaveLength(3);
    expect(await f.db.one('SELECT name,use_fee_cents FROM ar_venue WHERE legacy_device_id=?', [active.id])).toEqual({ name: 'Synthetic verified recovery venue', use_fee_cents: 777 });
    const devices = await f.db.query('SELECT id,merchant_id,venue_id FROM ar_device ORDER BY id');
    expect(devices.every(row => Number.isSafeInteger(row.venue_id) && row.venue_id > 0)).toBe(true);
    expect(new Set(devices.map(row => row.venue_id)).size).toBe(3);
    expect(await f.db.query('SELECT * FROM ar_rental_config ORDER BY device_id')).toEqual(configsBefore.map(({ use_fee_cents, deposit_cents, ...row }) => ({ ...row, merchant_id: 1 })));
    expect(await f.db.query('SELECT device_id,use_fee_cents,deposit_cents,revision FROM ar_legacy_device_pricing_archive ORDER BY device_id')).toEqual(configsBefore.map(row => ({ device_id: row.device_id, use_fee_cents: row.use_fee_cents, deposit_cents: row.deposit_cents, revision: row.version })));
    const orderAfter = (await f.db.one('SELECT * FROM ar_rental_order'))!;
    expect(orderAfter).toEqual({ ...orderBefore, merchant_id: 1, payment_config_id: 1, venue_id: null, venue_name: null, venue_price_version: null });
    const ready = await setup(db);
    const edited = await ready.http('patch', `/api/v2/rental/admin/venues/${devices[0].venue_id}`, ready.rootToken).send({ version: 1, useFeeCents: 888 });
    expect(edited.status).toBe(200); expect(edited.body.venue.version).toBe(2);
    expect(await f.db.one('SELECT * FROM ar_rental_order')).toEqual(orderAfter);
  }), 30_000);

  it('allows own-merchant adminers to write, managers to read and never trusts client ownership or roles', async () => withFixture(async f => {
    const adminer = await f.staff('adminer', 'adminer'), manager = await f.staff('manager', 'manager'), user = await f.staff('user', 'user');
    const other = await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'other', name: 'Synthetic other merchant', miniappOwnerId: 1, status: 'active', payEnabled: false });
    expect(other.status).toBe(200); const otherId = other.body.merchant.id;
    const creation = await f.http('post', '/api/v2/rental/admin/venues', adminer.token).send({ ...f.venueInput, merchantId: otherId, role: 'root' });
    expect(creation.status).toBe(200); expect(creation.body.venue).toMatchObject({ merchantId: 1, version: 1, useFeeCents: 123, depositCents: 4567 });
    const foreign = await f.http('post', '/api/v2/rental/admin/venues', f.rootToken, otherId).send({ ...f.venueInput, name: 'Other merchant private venue' });
    expect(foreign.status).toBe(200);
    const list = await f.http('get', '/api/v2/rental/admin/venues', manager.token).query({ merchantId: otherId });
    expect(list.status).toBe(200); expect(list.body.items.map((row: Row) => row.id)).toEqual([creation.body.venue.id]);
    expect((await f.http('post', '/api/v2/rental/admin/venues', manager.token).send(f.venueInput)).status).toBe(403);
    expect((await f.http('patch', `/api/v2/rental/admin/venues/${creation.body.venue.id}`, manager.token).send({ version: 1, status: 'paused' })).status).toBe(403);
    expect((await f.http('get', '/api/v2/rental/admin/venues', user.token)).status).toBe(403);
    expect((await f.http('post', '/api/v2/rental/admin/venues', user.token).send({ ...f.venueInput, role: 'root' })).status).toBe(403);
    expect((await f.http('post', '/api/v2/rental/admin/venues', adminer.token, otherId).send(f.venueInput)).status).toBe(403);
    expect((await f.http('patch', `/api/v2/rental/admin/venues/${foreign.body.venue.id}`, adminer.token).send({ version: 1, name: 'Foreign edit' })).status).toBe(404);
    expect((await f.http('post', '/api/v2/rental/admin/venues', adminer.token).send({ ...f.venueInput, useFeeCents: 1.5 })).status).toBe(422);
    expect((await f.http('post', '/api/v2/rental/admin/venues', adminer.token).send({ ...f.venueInput, depositCents: -1 })).status).toBe(422);
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=?", [adminer.id]);
    expect((await f.http('post', '/api/v2/rental/admin/venues', adminer.token).send(f.venueInput)).status).toBe(403);
    await f.db.execute("UPDATE ar_merchant_membership SET status='active' WHERE user_id=?", [adminer.id]);
    await f.db.execute('UPDATE ar_user SET auth_version=auth_version+1 WHERE id=?', [adminer.id]);
    expect((await f.http('get', '/api/v2/rental/admin/venues', adminer.token)).status).toBe(401);
    expect((await f.http('delete', `/api/v2/rental/admin/venues/${creation.body.venue.id}`, f.rootToken)).status).toBe(404);
    expect(Number((await f.db.one('SELECT COUNT(*) AS total FROM ar_venue'))!.total)).toBe(2);
  }), 30_000);

  it('serializes concurrent venue revisions and enforces non-null same-merchant device binding in MySQL', async () => withFixture(async f => {
    const creation = await f.http('post', '/api/v2/rental/admin/venues', f.rootToken).send(f.venueInput);
    expect(creation.status).toBe(200); const venueId = creation.body.venue.id;
    const revisions = await Promise.all([200, 300].map(useFeeCents => f.http('patch', `/api/v2/rental/admin/venues/${venueId}`, f.rootToken).send({ version: 1, useFeeCents })));
    expect(revisions.map(row => row.status).sort()).toEqual([200, 409]);
    const updated = (await f.db.one('SELECT * FROM ar_venue WHERE id=?', [venueId]))!;
    expect(updated.version).toBe(2); expect([200, 300]).toContain(updated.use_fee_cents);
    const other = await f.http('post', '/api/v2/rental/admin/merchants', f.rootToken).send({ code: 'other', name: 'Synthetic other merchant', miniappOwnerId: 1, status: 'active', payEnabled: false });
    expect(other.status).toBe(200); const otherId = other.body.merchant.id;
    const foreign = await f.http('post', '/api/v2/rental/admin/venues', f.rootToken, otherId).send({ ...f.venueInput, name: 'Foreign venue' });
    expect(foreign.status).toBe(200);
    const device = await f.http('post', '/api/v2/rental/devices', f.rootToken).send({ uuid: 'venue-bound-device', venueId, merchantId: otherId });
    expect(device.status).toBe(200);
    expect(await f.db.one('SELECT merchant_id,venue_id FROM ar_device WHERE id=?', [device.body.device.id])).toEqual({ merchant_id: 1, venue_id: venueId });
    await expect(f.db.execute('INSERT INTO ar_device(uuid,name,device_type,merchant_id,venue_id) VALUES(?,?,?,?,?)', ['foreign-venue-device', 'Synthetic wrong venue', 'ios', 1, foreign.body.venue.id])).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    await expect(f.db.execute('INSERT INTO ar_device(uuid,name,device_type,merchant_id,venue_id) VALUES(?,?,?,?,?)', ['null-venue-device', 'Synthetic missing venue', 'ios', 1, null])).rejects.toMatchObject({ code: 'ER_BAD_NULL_ERROR' });
    await expect(f.db.execute('DELETE FROM ar_venue WHERE id=?', [venueId])).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
    const customer = await f.login('customer');
    const context = await f.http('get', '/api/v2/rental/devices/context', 'Bearer ' + customer.token.accessToken).query({ uuid: 'venue-bound-device' });
    expect(context.status).toBe(200);
    expect(context.body.venue).toEqual({ id: venueId, name: f.venueInput.name, address: f.venueInput.address, description: f.venueInput.description });
    expect(JSON.stringify(context.body.venue)).not.toContain('contactPhone');
    const paused = await f.http('patch', `/api/v2/rental/admin/venues/${venueId}`, f.rootToken).send({ version: 2, status: 'paused' });
    expect(paused.status).toBe(200); expect(paused.body.venue).toMatchObject({ status: 'paused', version: 3 });
  }), 30_000);
});
