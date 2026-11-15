import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalService, registerRentals } from '../src/rentals';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import type { RentalPrincipal } from '../src/rentals/types';
import { DeviceService } from '../src/devices/service';
import { withMerchant, type MerchantRuntime } from '../src/merchants/context';
import { ApiError } from '../src/core/errors';
import { registerManagement } from '../src/admin/management';

const opened: RentalDb[] = [];
class RentalDb {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    opened.push(this);
    this.sqlite.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE ar_user(id INTEGER PRIMARY KEY,role TEXT,appid TEXT DEFAULT 'wx-rental-test');
      INSERT INTO ar_user(id,role) VALUES(1,'user'),(2,'manager'),(3,'user'),(4,'root'),(5,'adminer');
      CREATE TABLE ar_venue(id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL,name TEXT,address TEXT DEFAULT '',description TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'active',use_fee_cents INTEGER NOT NULL,deposit_cents INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      INSERT INTO ar_venue(id,merchant_id,name,use_fee_cents,deposit_cents) VALUES(1,1,'场地一',2000,20000),(2,2,'场地二',3000,9000),(3,1,'场地三',3000,10000);
      CREATE TABLE ar_device(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE,device_type TEXT DEFAULT 'ios',name TEXT,merchant_id INTEGER NOT NULL DEFAULT 1,venue_id INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO ar_device(id,uuid,device_type,name) VALUES(7,'camera-7','rokid','AR眼镜'),(8,'camera-8','ios','设备8');`);
    const mysql = readFileSync(resolve('database/002-rentals.sql'), 'utf8');
    const schema = mysql.replace(/^\s*--.*$/gm, '')
      .replace(/id int NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'id INTEGER PRIMARY KEY AUTOINCREMENT')
      .replace(/ CHARACTER SET ascii COLLATE ascii_bin/g, '')
      .replace(/UNIQUE KEY \w+ \(([^)]+)\)/g, 'UNIQUE ($1)')
      .replace(/,\s*KEY \w+ \([^)]+\)/g, '')
      .replace(/ENGINE=InnoDB CHARACTER SET utf8mb4/g, '');
    this.sqlite.exec(schema);
    this.sqlite.exec('ALTER TABLE ar_rental_order ADD COLUMN venue_id INTEGER; ALTER TABLE ar_rental_order ADD COLUMN venue_name TEXT; ALTER TABLE ar_rental_order ADD COLUMN venue_price_version INTEGER;');
  }
  async query(sql: string, values: any[] = []): Promise<Row[]> {
    return this.sqlite.prepare(sql.replace(/ FOR UPDATE/g, '')).all(...values) as Row[];
  }
  async one(sql: string, values: any[] = []): Promise<Row | null> { return (await this.query(sql, values))[0] ?? null; }
  async columns(table: string) { return (await this.query(`PRAGMA table_info(${table})`)).map(row => ({ name: row.name, type: row.type, key: row.pk ? 'PRI' : '' })); }
  async execute(sql: string, values: any[] = []) {
    sql = sql.replace('ON DUPLICATE KEY UPDATE available_ms=LEAST(available_ms,VALUES(available_ms)),finished=0', 'ON CONFLICT(rental_id,kind) DO UPDATE SET available_ms=MIN(available_ms,excluded.available_ms),finished=0');
    const result = this.sqlite.prepare(sql).run(...values);
    return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) };
  }
  async insert(table: string, data: Row): Promise<Row> {
    const fields = Object.entries(data).filter(([, value]) => value !== undefined);
    const result = await this.execute(`INSERT INTO ${table} (${fields.map(([key]) => key).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value));
    const primary = (await this.columns(table)).find(column => column.key === 'PRI')!.name;
    return (await this.one(`SELECT * FROM ${table} WHERE ${primary}=?`, [data[primary] ?? result.insertId]))!;
  }
  async transaction<T>(operation: (db: this) => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN');
    try { const result = await operation(this); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
afterEach(() => { for (const db of opened.splice(0)) db.sqlite.close(); vi.restoreAllMocks(); });

function fixture(appid = 'wx-rental-test', mchId = 'merchant-rental') {
  const db = new RentalDb();
  let now = 1794542400000;
  const user: RentalPrincipal = { user: { id: 1, role: 'user' }, appid, openid: 'payer-1' };
  const other: RentalPrincipal = { user: { id: 3, role: 'user' }, appid, openid: 'payer-3' };
  const manager: RentalPrincipal = { user: { id: 2, role: 'manager' }, appid, openid: 'payer-2' };
  const root: RentalPrincipal = { user: { id: 4, role: 'root' }, appid, openid: 'payer-4' };
  const adminer: RentalPrincipal = { user: { id: 5, role: 'adminer' }, appid, openid: 'payer-5' };
  const orders = new Map<string, Row>(), refunds = new Map<string, Row>();
  const payment = {
    config: { appId: appid, mchId, privateKey: 'test-private', serialNo: 'test-serial', apiV3Key: 'test-api-key', platformKeys: { test: 'test-public' } },
    assertPaymentApplication: vi.fn(),
    isPaymentReady: vi.fn(function(this: any) { return !!this.config.privateKey; }),
    order: vi.fn(async (input: Row) => {
      orders.set(input.out_trade_no, { out_trade_no: input.out_trade_no, appid, mchid: mchId, payer: { openid: input.openid }, amount: { total: input.amount, currency: 'CNY' }, trade_state: 'NOTPAY', transaction_id: 'transaction-' + input.out_trade_no });
      return { appId: appid, timeStamp: '1794542400', nonceStr: 'test-nonce', package: 'prepay_id=' + input.out_trade_no, signType: 'RSA', paySign: 'test-signature' };
    }),
    payment: vi.fn(async (method: string, path: string, body?: Row): Promise<Row> => {
      if (path.startsWith('/v3/pay/transactions/out-trade-no/')) {
        const number = decodeURIComponent(path.split('/')[5].split('?')[0]);
        const order = orders.get(number);
        if (!order) throw Object.assign(new Error('verified not found'), { providerCode: 'ORDER_NOT_EXIST' });
        if (method === 'POST' && path.endsWith('/close')) { order.trade_state = 'CLOSED'; return {}; }
        return structuredClone(order);
      }
      if (path === '/v3/refund/domestic/refunds' && method === 'POST') {
        if (!refunds.has(body!.out_refund_no)) refunds.set(body!.out_refund_no, { out_trade_no: body!.out_trade_no, out_refund_no: body!.out_refund_no, refund_id: 'refund-' + body!.out_refund_no, amount: body!.amount, status: 'PROCESSING' });
        return structuredClone(refunds.get(body!.out_refund_no)!);
      }
      if (path.startsWith('/v3/refund/domestic/refunds/')) {
        const number = decodeURIComponent(path.split('/').at(-1)!);
        if (!refunds.has(number)) throw Object.assign(new Error('verified refund missing'), { providerCode: 'RESOURCE_NOT_EXISTS' });
        return structuredClone(refunds.get(number)!);
      }
      throw new Error('Unexpected provider request: ' + method + ' ' + path);
    }),
    notification: vi.fn(async (raw: string) => JSON.parse(raw)),
  };
  const options = { authenticate: async () => user, payment: payment as any, appId: appid, now: () => now };
  const services = { db } as unknown as Services;
  const service = new RentalService(services, options);
  const configure = async (depositCents = 20000, useFeeCents = 2000) => {
    await db.execute('UPDATE ar_venue SET use_fee_cents=?,deposit_cents=? WHERE id=1', [useFeeCents, depositCents]);
    return service.configure(manager, 7, { enabled: true, version: 0 });
  };
  const create = (principal = user, key = 'rental-request-1') => service.create(principal, { deviceId: 7, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: key });
  const pay = async (principal = user) => {
    const result = await create(principal);
    await service.payment(principal, result.rental.id);
    const row = (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [result.rental.id]))!;
    const provider = orders.get(row.out_trade_no)!;
    provider.trade_state = 'SUCCESS'; provider.success_time = new Date(now).toISOString();
    const active = await service.syncPayment(principal, row.id);
    return { row, rental: active.rental, provider };
  };
  return { db, service, options, services, payment, orders, refunds, user, other, manager, adminer, root, configure, create, pay, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('independent AR rental lifecycle', () => {
  it.each(['manager', 'adminer', 'root'] as const)('inherits device operations for %s without trusting a forged client role', async role => {
    const f = fixture(); const actor = f[role];
    expect((await f.service.context(actor, 'role-device-' + role)).actions.canCreate).toBe(true);
    const created = await f.service.createDevice(actor, { venueId: 1, uuid: 'role-device-' + role });
    await f.service.configure(actor, created.device.id, { enabled: true, version: 0 });
    expect(await f.service.context(f.user, created.device.uuid)).toMatchObject({ state: 'AVAILABLE', pricing: { totalCents: 22000 }, actions: { canRent: true, canConfigure: false } });
    expect((await f.service.devices(actor, { search: created.device.uuid })).total).toBe(1);
    const forged = { ...f.user, user: { ...f.user.user, role } };
    await expect(f.service.createDevice(forged, { venueId: 1, uuid: 'forged-role-' + role })).rejects.toMatchObject({ status: 403 });
    await expect(f.service.configure(forged, created.device.id, { enabled: false, version: 1 })).rejects.toMatchObject({ status: 403 });
    expect((await f.service.context(actor, created.device.uuid)).pricing).toMatchObject({ enabled: true, totalCents: 22000, version: 1 });
  });
  it('retains device capabilities when a system administrator is demoted to device manager', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    await f.db.execute("UPDATE ar_user SET role='manager' WHERE id=?", [f.adminer.user.id]);
    expect((await f.service.context(f.adminer, 'camera-7')).actions).toMatchObject({ canConfigure: true, canEndRental: true });
    expect((await f.service.end(f.adminer, paid.row.id, { refundMode: 'deposit', reason: '设备已归还', idempotencyKey: 'demoted-admin-to-manager' })).rental).toMatchObject({ status: 'ENDED', refundAmountCents: 20000, refundStatus: 'PROCESSING' });
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
  });
  it('defaults omitted device types while preserving explicit and existing types', async () => {
    const f = fixture();
    expect(await f.service.createDevice(f.manager, { venueId: 1, uuid: 'default-type-device' })).toMatchObject({ created: true, device: { type: 'Rokid Studio2' } });
    expect(await f.service.createDevice(f.manager, { venueId: 1, uuid: 'explicit-ios-device', type: 'ios' })).toMatchObject({ device: { type: 'ios' } });
    expect(await f.service.createDevice(f.manager, { venueId: 1, uuid: 'explicit-rokid-device', type: 'rokid' })).toMatchObject({ device: { type: 'rokid' } });
    expect(await f.service.createDevice(f.manager, { venueId: 1, uuid: 'explicit-studio-device', type: 'rokid studio2' })).toMatchObject({ device: { type: 'Rokid Studio2' } });
    expect(await f.service.createDevice(f.manager, { venueId: 1, uuid: 'short-studio-device', type: 'rs2' })).toMatchObject({ created: true, device: { type: 'Rokid Studio2' } });
    expect((await f.db.one('SELECT device_type FROM ar_device WHERE uuid=?', ['short-studio-device']))!.device_type).toBe('Rokid Studio2');
    expect(await f.service.createDevice(f.manager, { venueId: 1, uuid: 'camera-8', type: 'rs2' })).toMatchObject({ created: false, device: { type: 'ios' } });
    expect((await f.service.context(f.user, 'camera-8')).device.type).toBe('ios');
    expect(DeviceService.display({ id: 99, uuid: 'legacy-empty', device_type: '' }).type).toBe('Rokid Studio2');
    await f.db.insert('ar_device', { uuid: 'legacy-model-case', name: 'Synthetic legacy model', device_type: 'rokid studio3' });
    expect((await f.service.context(f.user, 'legacy-model-case')).device.type).toBe('Rokid Studio3');
    expect((await f.db.one('SELECT device_type FROM ar_device WHERE uuid=?', ['legacy-model-case']))!.device_type).toBe('rokid studio3');
  });
  it('registers devices only for managers, without creating a rental configuration or mutating duplicate scans', async () => {
    const f = fixture();
    await expect(f.service.createDevice(f.user, { venueId: 1, uuid: 'new-device' })).rejects.toMatchObject({ status: 403 });
    const result = await f.service.createDevice(f.manager, { venueId: 1, uuid: 'new-device', type: 'rokid', name: '租赁眼镜' });
    expect(result).toMatchObject({ created: true, device: { uuid: 'new-device', name: '租赁眼镜', type: 'rokid' } });
    expect(await f.service.createDevice(f.root, { venueId: 1, uuid: 'new-device', type: 'ios', name: '覆盖名称' })).toMatchObject({ created: false, device: result.device });
    const context = await f.service.context(f.user, 'new-device');
    expect(context).toMatchObject({ state: 'DISABLED', pricing: { enabled: false, version: 0 }, actions: { canRent: false } });
    expect(await f.db.query('SELECT * FROM ar_rental_config')).toEqual([]);
    await expect(f.service.createDevice(f.manager, { venueId: 1, uuid: 'bad uuid' })).rejects.toMatchObject({ status: 422 });
    await expect(f.service.createDevice(f.manager, { venueId: 1, uuid: 'valid', type: ' ios' })).rejects.toMatchObject({ status: 422 });
  });
  it('searches independent device names with literal wildcard characters and enforces management access', async () => {
    const f = fixture();
    await f.service.createDevice(f.manager, { venueId: 1, uuid: 'literal-device', name: '设备100%_ready' });
    await expect(f.service.devices(f.user, {})).rejects.toMatchObject({ status: 403 });
    const result = await f.service.devices(f.manager, { search: '%_', 'per-page': 1 });
    expect(result).toMatchObject({ page: 1, pageSize: 1, total: 1, items: [{ device: { uuid: 'literal-device' }, state: 'DISABLED' }] });
    expect((await f.service.devices(f.root, { search: 'AR眼镜' })).total).toBe(1);
  });
  it('reads a page of shared-venue devices with bounded queries and exposes only public summaries', async () => {
    const f = fixture();
    for (let index = 0; index < 20; index++) await f.db.insert('ar_device', { uuid: 'page-device-' + index, name: '场地设备' + index, venue_id: 1, merchant_id: 1 });
    const query = vi.spyOn(f.db, 'query');
    const result = await f.service.devices(f.manager, { pageSize: 50 });
    expect(result.total).toBe(22); expect(result.items).toHaveLength(22);
    expect(query.mock.calls.length).toBeLessThanOrEqual(4);
    for (const item of result.items) {
      expect(item.device).toMatchObject({ venueId: 1, venueName: '场地一' });
      expect(item.pricing).toMatchObject({ totalCents: 22000, venuePriceVersion: 1 });
      expect(item.venue).toEqual({ id: 1, name: '场地一', address: '', description: '' });
      expect(item.device).not.toHaveProperty('venue_use_fee_cents');
    }
  });
  it('shows only public device fields to all roles and keeps new devices disabled', async () => {
    const f = fixture();
    for (const identity of [f.user, f.manager, f.root]) {
      const context = await f.service.context(identity, 'camera-7');
      expect(context).toMatchObject({ state: 'DISABLED', device: { id: 7, name: 'AR眼镜', type: 'rokid' }, rental: null });
      expect(context.device).not.toHaveProperty('ip');
      expect(context.device).not.toHaveProperty('setup');
      expect(context.actions.canRent).toBe(false);
    }
    expect((await f.service.context(f.user, 'missing')).actions.canCreate).toBe(false);
    expect((await f.service.context(f.manager, 'missing')).actions.canCreate).toBe(true);
  });
  it('requires current management role for configuration and snapshots server prices', async () => {
    const f = fixture();
    await expect(f.service.configure(f.user, 7, { enabled: true, version: 0 })).rejects.toMatchObject({ status: 403 });
    await f.configure();
    const result = await f.service.create(f.user, { deviceId: 7, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'rental-request-1', totalCents: 1, useFeeCents: 1, openid: 'forged' });
    expect(result.rental).toMatchObject({ useFeeCents: 2000, depositCents: 20000, totalCents: 22000, status: 'PENDING_PAYMENT' });
    const row = await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [result.rental.id]);
    expect(row!.payer_openid).toBe('payer-1');
    expect(row!.out_trade_no).toMatch(/^ARL_[a-f0-9]{24}$/);
    await f.db.execute('UPDATE ar_venue SET use_fee_cents=3000,deposit_cents=10000,version=2 WHERE id=1');
    await f.service.configure(f.manager, 7, { enabled: true, version: 1 });
    expect((await f.service.get(f.user, result.rental.id)).rental.totalCents).toBe(22000);
  });
  it('requires refreshed quote and prevents another payer from reserving an occupied device', async () => {
    const f = fixture(); await f.configure();
    await expect(f.service.create(f.user, { deviceId: 7, venuePriceVersion: 1, priceVersion: 2, idempotencyKey: 'rental-request-1' })).rejects.toMatchObject({ status: 409 });
    const first = await f.create();
    expect((await f.create()).rental.id).toBe(first.rental.id);
    expect((await f.create(f.user, 'another-request')).rental.id).toBe(first.rental.id);
    await expect(f.create(f.other, 'other-user-request')).rejects.toMatchObject({ status: 409 });
    const context = await f.service.context(f.other, 'camera-7');
    expect(context).toMatchObject({ state: 'RESERVED', relation: 'other', rental: null });
    expect(await f.db.query('SELECT * FROM ar_rental_order')).toHaveLength(1);
  });
  it('cancels a local order without calling WeChat if prepayment was never attempted', async () => {
    const f = fixture(); await f.configure(); const first = await f.create();
    const cancelled = await f.service.cancel(f.user, first.rental.id);
    expect(cancelled.rental.status).toBe('CANCELLED');
    expect(f.payment.payment).not.toHaveBeenCalled();
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('AVAILABLE');
  });
  it('keeps uncertain prepayment occupied and releases only after trusted nonexistence or close', async () => {
    const f = fixture(); await f.configure(); const first = await f.create();
    f.payment.order.mockRejectedValueOnce(new Error('request timed out'));
    await expect(f.service.payment(f.user, first.rental.id)).rejects.toThrow('timed out');
    f.advance(31000);
    f.payment.payment.mockRejectedValueOnce(Object.assign(new Error('404 without verified code'), { status: 404 }));
    await expect(f.service.cancel(f.user, first.rental.id)).rejects.toThrow('404');
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('RESERVED');
    expect((await f.service.cancel(f.user, first.rental.id)).rental.status).toBe('PENDING_PAYMENT');
    f.advance(330001);
    expect((await f.service.cancel(f.user, first.rental.id)).rental.status).toBe('CANCELLED');
  });
  it('does not release an occupied device while provider prepay creation is still in flight', async () => {
    const f = fixture(); await f.configure(); const first = await f.create();
    const original = f.payment.order.getMockImplementation()!;
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    f.payment.order.mockImplementationOnce(async input => { await delayed; return original(input); });
    const paying = f.service.payment(f.user, first.rental.id);
    await vi.waitFor(() => expect(f.payment.order).toHaveBeenCalled());
    const cancelled = await f.service.cancel(f.user, first.rental.id);
    expect(cancelled.rental.status).toBe('PENDING_PAYMENT');
    expect(f.payment.payment).not.toHaveBeenCalled();
    await expect(f.create(f.other, 'other-user-request')).rejects.toMatchObject({ status: 409 });
    release(); await paying;
    expect((await f.service.cancel(f.user, first.rental.id)).rental.status).toBe('CANCELLED');
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('AVAILABLE');
  });
  it('retains a signed transient not-found result until the original order expiry has passed', async () => {
    const f = fixture(); await f.configure(); const first = await f.create();
    f.payment.order.mockRejectedValueOnce(new Error('provider may still be creating the order'));
    await expect(f.service.payment(f.user, first.rental.id)).rejects.toThrow();
    f.advance(31000);
    expect((await f.service.syncPayment(f.user, first.rental.id)).rental.status).toBe('PENDING_PAYMENT');
    expect((await f.service.cancel(f.user, first.rental.id)).rental.status).toBe('PENDING_PAYMENT');
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('RESERVED');
    f.advance(300000);
    expect((await f.service.cancel(f.user, first.rental.id)).rental.status).toBe('CANCELLED');
  });
  it('caches prepayment and validates provider payer, merchant and amount before activation', async () => {
    const f = fixture(); await f.configure(); const first = await f.create();
    const params = await f.service.payment(f.user, first.rental.id);
    expect(params.payParams.appId).toBe(f.user.appid);
    await f.service.payment(f.user, first.rental.id);
    expect(f.payment.order).toHaveBeenCalledOnce();
    expect(f.payment.order.mock.calls[0][0].time_expire).toBe(first.rental.expiresAt);
    const row = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [first.rental.id]))!;
    const provider = f.orders.get(row.out_trade_no)!;
    provider.trade_state = 'SUCCESS'; provider.amount.total = 1;
    await expect(f.service.syncPayment(f.user, row.id)).rejects.toMatchObject({ status: 403 });
    expect((await f.service.get(f.user, row.id)).rental.status).toBe('PENDING_PAYMENT');
    provider.amount.total = 22000; provider.payer.openid = 'other-payer';
    await expect(f.service.syncPayment(f.user, row.id)).rejects.toMatchObject({ status: 403 });
    provider.payer.openid = f.user.openid;
    const active = await f.service.syncPayment(f.user, row.id);
    f.advance(60000);
    expect((await f.service.syncPayment(f.user, row.id)).rental.startedAt).toBe(active.rental.startedAt);
    await expect(f.service.get(f.other, row.id)).rejects.toMatchObject({ status: 403 });
  });
  it('normally charges every management role when they rent for themselves', async () => {
    for (const role of ['manager', 'adminer', 'root'] as const) {
      const f = fixture(); await f.configure(); const actor = f[role];
      const result = await f.create(actor);
      expect(result.rental).toMatchObject({ totalCents: 22000, mine: true, paymentStatus: 'NOTPAY' });
    }
  });
  it('keeps customer refund views read-only and rejects self-service settlement, sync and retry', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    f.payment.payment.mockClear();
    for (const refundMode of ['deposit', 'full']) {
      await expect(f.service.end(f.user, paid.row.id, { refundMode, reason: '本人申请', idempotencyKey: 'customer-end-' + refundMode })).rejects.toMatchObject({ status: 403 });
    }
    await expect(f.service.syncRefund(f.user, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.retryRefund(f.user, paid.row.id)).rejects.toMatchObject({ status: 403 });
    for (const role of ['manager', 'adminer', 'root']) {
      const forgedManager = { ...f.user, user: { ...f.user.user, role } };
      await expect(f.service.end(forgedManager, paid.row.id, { refundMode: 'deposit', reason: '伪造身份', idempotencyKey: 'forged-' + role + '-end' })).rejects.toMatchObject({ status: 403 });
    }
    const actions = { canEndRental: false, canSyncRefund: false, canRetryRefund: false };
    expect(await f.service.get(f.user, paid.row.id)).toMatchObject({ rental: { status: 'ACTIVE', mine: true }, actions });
    expect(await f.service.context(f.user, 'camera-7')).toMatchObject({ state: 'RENTED', actions });
    expect((await f.service.context(f.manager, 'camera-7')).actions.canEndRental).toBe(true);
    expect(f.payment.payment).not.toHaveBeenCalled();
    expect(f.refunds.size).toBe(0);
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='RENTAL_ENDED'")).toEqual([]);
  });
  it.each(['manager', 'adminer', 'root'] as const)('allows a current %s who is also the payer to settle only with management permission', async role => {
    const f = fixture(); await f.configure(); const actor = f[role];
    const paid = await f.pay(actor);
    expect((await f.service.get(actor, paid.row.id)).actions.canEndRental).toBe(true);
    const result = await f.service.end(actor, paid.row.id, { refundMode: 'full', reason: '管理员确认本人设备归还', idempotencyKey: 'own-admin-end-' + role, refundAmountCents: 1 });
    expect(result.rental).toMatchObject({ mine: true, status: 'ENDED', refundAmountCents: 22000, refundStatus: 'PROCESSING' });
    expect([...f.refunds.values()][0].amount).toEqual({ refund: 22000, total: 22000, currency: 'CNY' });
    expect((await f.service.context(actor, 'camera-7')).state).toBe('SETTLING');
  });
  it.each(['manager', 'adminer'] as const)('rechecks the current %s inside the settlement transaction after a role revocation', async role => {
    const f = fixture(); await f.configure(); const paid = await f.pay(); const actor = f[role];
    const originalOne = f.db.one.bind(f.db);
    let revoked = false;
    vi.spyOn(f.db, 'one').mockImplementation(async (sql, values) => {
      const result = await originalOne(sql, values);
      // Revoke immediately after the initial management read, before the
      // device/order lock and final settlement authorization are acquired.
      if (!revoked && sql === 'SELECT id,role FROM ar_user WHERE id = ? AND appid = ?') {
        revoked = true;
        await f.db.execute("UPDATE ar_user SET role='user' WHERE id=?", [actor.user.id]);
      }
      return result;
    });
    f.payment.payment.mockClear();
    await expect(f.service.end(actor, paid.row.id, { refundMode: 'deposit', reason: '已撤销管理员', idempotencyKey: 'revoked-during-end' })).rejects.toMatchObject({ status: 403 });
    expect(revoked).toBe(true);
    expect((await f.service.context(actor, 'camera-7')).actions).toMatchObject({ canEndRental: false, canSyncRefund: false, canRetryRefund: false });
    await expect(f.service.get(actor, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.syncRefund(actor, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.retryRefund(actor, paid.row.id)).rejects.toMatchObject({ status: 403 });
    expect((await f.service.get(f.user, paid.row.id)).rental.status).toBe('ACTIVE');
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('RENTED');
    expect(f.payment.payment).not.toHaveBeenCalled();
    expect(f.refunds.size).toBe(0);
  });
  it.each(['manager', 'adminer'] as const)('keeps an approved timed-out refund occupied and retries the same refund only for a current %s', async role => {
    const f = fixture(); await f.configure(); const paid = await f.pay(); const actor = f[role];
    f.payment.payment.mockRejectedValueOnce(new Error('refund request timed out'));
    const ended = await f.service.end(actor, paid.row.id, { refundMode: 'deposit', reason: '现场确认归还', idempotencyKey: 'timeout-end-request' });
    expect(ended.rental).toMatchObject({ status: 'ENDED', refundStatus: 'PENDING', refundAmountCents: 20000 });
    const pending = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [paid.row.id]))!;
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    const before = f.payment.payment.mock.calls.length;
    await expect(f.service.syncRefund(f.user, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.retryRefund(f.user, paid.row.id)).rejects.toMatchObject({ status: 403 });
    expect(await f.service.get(f.user, paid.row.id)).toMatchObject({ rental: { refundStatus: 'PENDING' }, actions: { canEndRental: false, canSyncRefund: false, canRetryRefund: false } });
    expect(f.payment.payment.mock.calls).toHaveLength(before);
    expect(await f.service.get(actor, paid.row.id)).toMatchObject({ actions: { canEndRental: false, canSyncRefund: true, canRetryRefund: true } });
    expect((await f.service.retryRefund(actor, paid.row.id)).rental.refundStatus).toBe('PROCESSING');
    expect([...f.refunds.keys()]).toEqual([pending.out_refund_no]);
    await f.service.end(f.root, paid.row.id, { refundMode: 'deposit', reason: '重复确认', idempotencyKey: 'timeout-end-duplicate' });
    expect(f.refunds.size).toBe(1);
    await f.db.execute("UPDATE ar_user SET role='user' WHERE id=?", [actor.user.id]);
    await expect(f.service.end(actor, paid.row.id, { refundMode: 'deposit', reason: '已撤销权限后重试', idempotencyKey: 'revoked-end-duplicate' })).rejects.toMatchObject({ status: 403 });
    [...f.refunds.values()][0].status = 'SUCCESS';
    // The approved durable refund is still completed by the worker after its
    // initiating manager loses permission; customers only read the result.
    f.advance(30001); await f.service.processJobs();
    expect((await f.service.get(f.user, paid.row.id)).rental.refundStatus).toBe('SUCCESS');
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('AVAILABLE');
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='REFUND_SUCCESS'")).toHaveLength(1);
  });
  it.each(['deposit', 'full'])('ends once with %s refund, stops timing and releases only after provider success', async mode => {
    const f = fixture(); await f.configure(); const paid = await f.pay(); f.advance(60000);
    await expect(f.service.end(f.user, paid.row.id, { refundMode: mode, reason: '归还', idempotencyKey: 'end-request-1' })).rejects.toMatchObject({ status: 403 });
    const ended = await f.service.end(f.manager, paid.row.id, { refundMode: mode, reason: '现场确认归还', idempotencyKey: 'end-request-1', refundAmountCents: 1 });
    const amount = mode === 'deposit' ? 20000 : 22000;
    expect(ended.rental).toMatchObject({ status: 'ENDED', refundStatus: 'PROCESSING', refundAmountCents: amount });
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('SETTLING');
    const refund = [...f.refunds.values()][0];
    expect(refund.amount).toEqual({ refund: amount, total: 22000, currency: 'CNY' });
    expect(refund.out_refund_no).toMatch(/^ARF_[a-f0-9]{24}$/);
    f.advance(600000);
    await f.service.end(f.root, paid.row.id, { refundMode: mode, reason: '重复点击', idempotencyKey: 'end-request-2' });
    expect((await f.service.get(f.user, paid.row.id)).rental.endedAt).toBe(ended.rental.endedAt);
    expect(f.refunds.size).toBe(1);
    await expect(f.service.end(f.manager, paid.row.id, { refundMode: mode === 'deposit' ? 'full' : 'deposit', reason: '更改方式', idempotencyKey: 'end-request-3' })).rejects.toMatchObject({ status: 409 });
    refund.status = 'SUCCESS';
    expect((await f.service.syncRefund(f.manager, paid.row.id)).rental.refundStatus).toBe('SUCCESS');
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('AVAILABLE');
  });
  it('ends zero-deposit rentals without sending a zero-amount provider refund', async () => {
    const f = fixture(); await f.configure(0, 500); const paid = await f.pay();
    const ended = await f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '已归还', idempotencyKey: 'end-request-1' });
    expect(ended.rental).toMatchObject({ refundAmountCents: 0, refundStatus: 'SUCCESS' });
    expect(f.refunds.size).toBe(0);
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('AVAILABLE');
  });
  it('retains occupied state on refund exceptions and rejects amount-substituted provider results', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    await f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '已归还', idempotencyKey: 'end-request-1' });
    const refund = [...f.refunds.values()][0];
    refund.status = 'SUCCESS'; refund.amount.refund = 1;
    await expect(f.service.syncRefund(f.manager, paid.row.id)).rejects.toMatchObject({ status: 403 });
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    refund.amount.refund = 20000; refund.status = 'ABNORMAL';
    expect((await f.service.syncRefund(f.manager, paid.row.id)).rental.refundStatus).toBe('ABNORMAL');
    await expect(f.service.retryRefund(f.manager, paid.row.id)).rejects.toMatchObject({ status: 409 });
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
  });
  it.each(['ABNORMAL', 'CLOSED'] as const)('keeps a newer %s observation when an earlier refund POST finishes late', async exceptional => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    const original = f.payment.payment.getMockImplementation()!;
    let accepted!: () => void, release!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.payment.payment.mockImplementationOnce(async (method, path, input) => {
      const earlierProcessing = await original(method, path, input);
      accepted(); await gate;
      return earlierProcessing;
    });
    const ending = f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '真实乱序响应回归', idempotencyKey: 'out-of-order-refund-' + exceptional });
    await acceptance;
    const refund = [...f.refunds.values()][0]; refund.status = exceptional;
    const notification = (status: string) => ({ params: {}, req: { rawBody: JSON.stringify({ event_type: 'REFUND.' + status, resource: { out_refund_no: refund.out_refund_no } }), headers: {} } } as any);
    await f.service.refundNotification(notification(exceptional));
    expect((await f.service.get(f.user, paid.row.id)).rental.refundStatus).toBe(exceptional);
    release();
    expect((await ending).rental.refundStatus).toBe(exceptional);
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    await expect(f.service.retryRefund(f.manager, paid.row.id)).rejects.toMatchObject({ status: 409 });
    expect(f.refunds.size).toBe(1);
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='REFUND_EXCEPTION'")).toHaveLength(1);
    refund.status = 'SUCCESS'; refund.amount.refund = 1;
    await expect(f.service.refundNotification(notification('SUCCESS'))).rejects.toMatchObject({ status: 403 });
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    refund.amount.refund = 20000;
    await f.service.refundNotification(notification('SUCCESS'));
    await f.service.refundNotification(notification('SUCCESS'));
    expect((await f.service.get(f.user, paid.row.id)).rental.refundStatus).toBe('SUCCESS');
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('AVAILABLE');
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='REFUND_SUCCESS'")).toHaveLength(1);
  });
  it('returns a conflict for an end key reused on another order without starting another refund', async () => {
    const f = fixture(); await f.configure(); const first = await f.pay();
    await f.service.configure(f.manager, 8, { enabled: true, version: 0 });
    const second = await f.service.create(f.user, { deviceId: 8, priceVersion: 1, venuePriceVersion: 1, idempotencyKey: 'second-active-rental' });
    await f.service.payment(f.user, second.rental.id);
    const row = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [second.rental.id]))!;
    f.orders.get(row.out_trade_no)!.trade_state = 'SUCCESS'; await f.service.syncPayment(f.user, row.id);
    const end = { refundMode: 'deposit', reason: '现场归还', idempotencyKey: 'shared-end-command-key' };
    await f.service.end(f.manager, first.row.id, end);
    await expect(f.service.end(f.manager, row.id, end)).rejects.toMatchObject({ status: 409 });
    expect((await f.service.get(f.user, row.id)).rental).toMatchObject({ status: 'ACTIVE', refundStatus: null });
    expect((await f.db.one('SELECT state FROM ar_rental_slot WHERE device_id=8'))!.state).toBe('RENTED');
    expect(f.refunds.size).toBe(1);
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='RENTAL_ENDED'")).toHaveLength(1);
    await f.service.end(f.manager, first.row.id, end);
    expect(f.refunds.size).toBe(1);
  });
  it('does not let a late old payment or refund release a newer rental', async () => {
    const f = fixture(); await f.configure(); const old = await f.create();
    await f.service.payment(f.user, old.rental.id);
    const oldRow = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [old.rental.id]))!;
    await f.service.cancel(f.user, old.rental.id);
    const next = await f.create(f.other, 'other-user-request'); await f.service.payment(f.other, next.rental.id);
    const nextRow = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [next.rental.id]))!;
    f.orders.get(nextRow.out_trade_no)!.trade_state = 'SUCCESS';
    await f.service.syncPayment(f.other, next.rental.id);
    f.orders.get(oldRow.out_trade_no)!.trade_state = 'SUCCESS';
    expect((await f.service.syncPayment(f.user, old.rental.id)).rental.status).toBe('COMPENSATING');
    await f.service.processJobs();
    const refund = [...f.refunds.values()][0]; expect(refund.amount.refund).toBe(22000);
    refund.status = 'SUCCESS'; await f.service.syncRefund(f.manager, old.rental.id);
    const current = await f.service.context(f.other, 'camera-7');
    expect(current).toMatchObject({ state: 'RENTED', relation: 'mine', rental: { id: next.rental.id } });
  });
  it('recovers expired reservations from durable jobs after service restart', async () => {
    const f = fixture(); await f.configure(); await f.create(); f.advance(300001);
    const restarted = new RentalService(f.services, f.options);
    await restarted.processJobs();
    expect((await restarted.context(f.other, 'camera-7')).state).toBe('AVAILABLE');
    expect((await f.db.one('SELECT * FROM ar_rental_job'))!.finished).toBe(1);
  });
  it('authenticates every business route and verifies notification before provider order processing', async () => {
    const f = fixture(); const router = new ApiRouter(); const authenticate = vi.fn().mockRejectedValue(new Error('unauthorized'));
    registerRentals(router, f.services, { ...f.options, authenticate });
    const route = router.routes.find(route => route.method === 'GET' && route.path === '/v2/rental/devices/context')!;
    await expect(route.handler({ query: { uuid: 'camera-7' }, res: { setHeader() {} } } as any)).rejects.toThrow('unauthorized');
    f.payment.notification.mockRejectedValueOnce(new Error('invalid signature'));
    await expect(f.service.paymentNotification({ req: { rawBody: '{}', headers: {} } } as any)).rejects.toThrow('invalid signature');
    expect(f.payment.payment).not.toHaveBeenCalled();
  });
  it('rejects disabled payment configuration instead of creating fake paid rentals', async () => {
    const f = fixture(); await f.configure(); f.payment.config.privateKey = '';
    expect((await f.service.context(f.user, 'camera-7')).actions.canRent).toBe(false);
    await expect(f.create()).rejects.toMatchObject({ status: 503 });
    expect(await f.db.query('SELECT * FROM ar_rental_order')).toEqual([]);
  });
  it('keeps reconciling existing payments and refunds when new payments are disabled', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    f.payment.isPaymentReady.mockReturnValue(false);
    expect((await f.service.context(f.user, 'camera-7')).paymentReady).toBe(false);
    await expect(f.service.payment(f.user, paid.row.id)).rejects.toMatchObject({ status: 503 });
    await f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '归还', idempotencyKey: 'disabled-pay-refund' });
    [...f.refunds.values()][0].status = 'SUCCESS';
    expect((await f.service.syncRefund(f.manager, paid.row.id)).rental.refundStatus).toBe('SUCCESS');
  });
  it('queries and verifies the refund before accepting a notification, and handles duplicates once', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    await f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '归还', idempotencyKey: 'notification-refund' });
    const refund = [...f.refunds.values()][0];
    const notice = { event_type: 'REFUND.SUCCESS', resource: { out_refund_no: refund.out_refund_no, refund_status: 'SUCCESS', amount: { refund: 20000 } } };
    const context = { req: { rawBody: Buffer.from(JSON.stringify(notice)), headers: {} } } as any;
    refund.status = 'SUCCESS'; refund.amount.refund = 1;
    await expect(f.service.refundNotification(context)).rejects.toMatchObject({ status: 403 });
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    refund.amount.refund = 20000;
    await f.service.refundNotification(context);
    await f.service.refundNotification(context);
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='REFUND_SUCCESS'")).toHaveLength(1);
    expect((await f.service.context(f.other, 'camera-7')).state).toBe('AVAILABLE');
  });
});

describe('merchant venues, device bindings and immutable rental quotes', () => {
  it('shares one venue price across devices while preserving previously accepted order quotes', async () => {
    const f = fixture(); await f.configure();
    await f.service.configure(f.manager, 8, { enabled: true, version: 0 });
    await f.db.execute('UPDATE ar_rental_config SET use_fee_cents=1,deposit_cents=2 WHERE device_id=7');
    await f.db.execute('UPDATE ar_rental_config SET use_fee_cents=9900,deposit_cents=8800 WHERE device_id=8');
    for (const uuid of ['camera-7', 'camera-8']) {
      expect((await f.service.context(f.user, uuid)).pricing).toMatchObject({ venueId: 1, useFeeCents: 2000, depositCents: 20000, totalCents: 22000, venuePriceVersion: 1 });
    }
    const accepted = await f.create();
    await f.db.execute("UPDATE ar_venue SET name='统一场地新名称',use_fee_cents=5000,deposit_cents=10000,version=2 WHERE id=1");
    for (const uuid of ['camera-7', 'camera-8']) {
      expect((await f.service.context(f.user, uuid)).pricing).toMatchObject({ venueId: 1, venueName: '统一场地新名称', useFeeCents: 5000, depositCents: 10000, totalCents: 15000, venuePriceVersion: 2 });
    }
    await expect(f.service.create(f.user, { deviceId: 8, priceVersion: 1, venuePriceVersion: 1, idempotencyKey: 'shared-venue-stale-quote' })).rejects.toMatchObject({ status: 409 });
    const current = await f.service.create(f.user, { deviceId: 8, priceVersion: 1, venuePriceVersion: 2, idempotencyKey: 'shared-venue-current-quote' });
    expect(current.rental).toMatchObject({ venueId: 1, venueName: '统一场地新名称', venuePriceVersion: 2, totalCents: 15000 });
    expect((await f.service.get(f.user, accepted.rental.id)).rental).toMatchObject({ venueId: 1, venueName: '场地一', venuePriceVersion: 1, useFeeCents: 2000, depositCents: 20000, totalCents: 22000 });
  });

  it('requires an active venue owned by the device merchant and returns its public identity', async () => {
    const f = fixture();
    await expect(f.service.createDevice(f.manager, { uuid: 'venue-not-selected' })).rejects.toMatchObject({ status: 422 });
    await expect(f.service.createDevice(f.manager, { uuid: 'foreign-venue-device', venueId: 2, merchantId: 2 })).rejects.toMatchObject({ status: 422 });
    await f.db.execute("UPDATE ar_venue SET status='paused' WHERE id=1");
    await expect(f.service.createDevice(f.manager, { uuid: 'paused-venue-device', venueId: 1 })).rejects.toMatchObject({ status: 422 });
    const created = await f.service.createDevice(f.manager, { uuid: 'valid-venue-device', venueId: 3 });
    expect(created.device).toMatchObject({ venueId: 3, venueName: '场地三', merchantId: 1 });
    expect(await f.service.context(f.user, 'valid-venue-device')).toMatchObject({ venue: { id: 3, name: '场地三' }, pricing: { enabled: false, totalCents: 13000, venuePriceVersion: 1 } });
    await expect(f.service.createDevice(f.manager, { uuid: 'valid-venue-device', venueId: 1 })).rejects.toMatchObject({ status: 422 });
  });

  it('uses only venue prices, rejects device price writes and requires both quote revisions', async () => {
    const f = fixture(); await f.configure();
    await f.db.execute('UPDATE ar_rental_config SET use_fee_cents=1,deposit_cents=1 WHERE device_id=7');
    expect((await f.service.context(f.user, 'camera-7')).pricing).toMatchObject({ useFeeCents: 2000, depositCents: 20000, totalCents: 22000, version: 1, venuePriceVersion: 1 });
    for (const input of [{ useFeeCents: 1 }, { depositCents: 1 }, { totalCents: 1 }, { use_fee_cents: 1 }]) {
      await expect(f.service.configure(f.manager, 7, { enabled: true, version: 1, ...input })).rejects.toMatchObject({ status: 422 });
    }
    await expect(f.service.create(f.user, { deviceId: 7, priceVersion: 1, idempotencyKey: 'missing-venue-quote-version' })).rejects.toMatchObject({ status: 422 });
    await f.db.execute('UPDATE ar_venue SET use_fee_cents=3000,deposit_cents=10000,version=2 WHERE id=1');
    await expect(f.create()).rejects.toMatchObject({ status: 409 });
    const created = await f.service.create(f.user, { deviceId: 7, priceVersion: 1, venuePriceVersion: 2, idempotencyKey: 'confirmed-venue-quote', useFeeCents: 1, depositCents: 1, venueId: 2 });
    expect(created.rental).toMatchObject({ venueId: 1, venueName: '场地一', venuePriceVersion: 2, useFeeCents: 3000, depositCents: 10000, totalCents: 13000 });
    await f.db.execute("UPDATE ar_venue SET name='场地新名称',use_fee_cents=999,deposit_cents=999,version=3 WHERE id=1");
    expect((await f.service.get(f.user, created.rental.id)).rental).toMatchObject({ venueName: '场地一', venuePriceVersion: 2, totalCents: 13000 });
    expect((await f.service.create(f.user, { deviceId: 7, priceVersion: 1, venuePriceVersion: 2, idempotencyKey: 'confirmed-venue-quote' })).rental.id).toBe(created.rental.id);
    await f.service.payment(f.user, created.rental.id);
    const stored = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    expect(f.orders.get(stored.out_trade_no)!.amount.total).toBe(13000);
    f.orders.get(stored.out_trade_no)!.trade_state = 'SUCCESS'; await f.service.syncPayment(f.user, stored.id);
    await f.service.end(f.manager, stored.id, { refundMode: 'deposit', reason: '按原场地报价退款', idempotencyKey: 'original-venue-refund' });
    expect([...f.refunds.values()][0].amount).toEqual({ refund: 10000, total: 13000, currency: 'CNY' });
  });

  it('blocks missing or foreign venue bindings without falling back to device money', async () => {
    const f = fixture(); await f.configure();
    for (const venueId of [999, 2]) {
      await f.db.execute('UPDATE ar_device SET venue_id=? WHERE id=7', [venueId]);
      await expect(f.service.context(f.user, 'camera-7')).rejects.toMatchObject({ status: 503 });
      await expect(f.create()).rejects.toMatchObject({ status: 503 });
    }
    expect(await f.db.query('SELECT * FROM ar_rental_order')).toEqual([]);
    expect(f.payment.order).not.toHaveBeenCalled();
  });

  it('stops new rentals at paused venues while preserving existing payments and refund amounts', async () => {
    const f = fixture(); await f.configure(); const created = await f.create();
    await f.db.execute("UPDATE ar_venue SET status='paused',version=2 WHERE id=1");
    await f.service.payment(f.user, created.rental.id);
    const order = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    f.orders.get(order.out_trade_no)!.trade_state = 'SUCCESS'; await f.service.syncPayment(f.user, order.id);
    await f.service.end(f.manager, order.id, { refundMode: 'deposit', reason: '场地停用后归还', idempotencyKey: 'paused-venue-refund' });
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    await expect(f.service.configure(f.manager, 7, { enabled: true, version: 1 })).rejects.toMatchObject({ status: 409 });
    [...f.refunds.values()][0].status = 'SUCCESS'; await f.service.syncRefund(f.manager, order.id);
    expect(await f.service.context(f.user, 'camera-7')).toMatchObject({ state: 'DISABLED', actions: { canRent: false } });
    await expect(f.service.create(f.other, { deviceId: 7, priceVersion: 1, venuePriceVersion: 2, idempotencyKey: 'paused-venue-new-rental' })).rejects.toMatchObject({ status: 409 });
    expect([...f.refunds.values()][0].amount.refund).toBe(20000);
  });

  it('disables a device after an allowed venue change and requires a fresh device revision to reopen', async () => {
    const f = fixture(); await f.configure();
    await expect(f.service.configure(f.manager, 7, { enabled: true, version: 1, venueId: 2 })).rejects.toMatchObject({ status: 422 });
    const changed = await f.service.configure(f.manager, 7, { enabled: true, version: 1, venueId: 3 });
    expect(changed).toMatchObject({ device: { venueId: 3, venueName: '场地三' }, state: 'DISABLED', pricing: { enabled: false, version: 2, totalCents: 13000 } });
    await expect(f.create()).rejects.toMatchObject({ status: 409 });
    await expect(f.service.configure(f.manager, 7, { enabled: true, version: 1 })).rejects.toMatchObject({ status: 409 });
    await f.service.configure(f.manager, 7, { enabled: true, version: 2 });
    const created = await f.service.create(f.user, { deviceId: 7, priceVersion: 3, venuePriceVersion: 1, idempotencyKey: 'reopened-new-venue' });
    expect(created.rental).toMatchObject({ venueId: 3, venueName: '场地三', totalCents: 13000, priceVersion: 3 });
  });

  it('rejects venue changes during reservations, active rentals and every unfinished refund state', async () => {
    const f = fixture(); await f.configure(); const created = await f.create();
    const change = () => f.service.configure(f.manager, 7, { enabled: false, version: 1, venueId: 3 });
    await expect(change()).rejects.toMatchObject({ status: 409 });
    await f.service.payment(f.user, created.rental.id);
    const order = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    f.orders.get(order.out_trade_no)!.trade_state = 'SUCCESS'; await f.service.syncPayment(f.user, order.id);
    await expect(change()).rejects.toMatchObject({ status: 409 });
    await f.service.end(f.manager, order.id, { refundMode: 'deposit', reason: '测试场地变更锁定', idempotencyKey: 'venue-change-refund' });
    for (const status of ['PENDING', 'PROCESSING', 'ABNORMAL', 'CLOSED']) {
      await f.db.execute('UPDATE ar_rental_order SET refund_status=? WHERE id=?', [status, order.id]);
      await expect(change()).rejects.toMatchObject({ status: 409 });
    }
    await f.db.execute('DELETE FROM ar_rental_slot WHERE device_id=7');
    await expect(change()).rejects.toMatchObject({ status: 409 });
    await f.db.execute("UPDATE ar_rental_order SET refund_status='SUCCESS' WHERE id=?", [order.id]);
    expect((await change()).device.venueId).toBe(3);
    expect((await f.service.get(f.user, order.id)).rental).toMatchObject({ venueId: 1, venueName: '场地一', depositCents: 20000 });
  });
});

function merchantFixture(shared = false) {
  const first = fixture(), second = fixture(shared ? first.user.appid : 'wx-second-rental', 'second-merchant');
  const db = first.db;
  db.sqlite.exec(`ALTER TABLE ar_user ADD COLUMN merchant_id INTEGER DEFAULT 1;
    ALTER TABLE ar_user ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
    UPDATE ar_user SET merchant_id=NULL WHERE role='root';
    INSERT INTO ar_user(id,role,appid,merchant_id) VALUES(11,'user','wx-second-rental',2),(12,'manager','wx-second-rental',2);
    INSERT INTO ar_device(id,uuid,device_type,name,merchant_id,venue_id) VALUES(9,'second-device','rokid','第二商户设备',2,2);
    UPDATE ar_venue SET use_fee_cents=2000,deposit_cents=8000 WHERE id=1;
    ALTER TABLE ar_rental_order ADD COLUMN payment_config_id INTEGER DEFAULT 1;`);
  for (const table of ['ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job']) db.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN merchant_id INTEGER NOT NULL DEFAULT 1`);
  db.sqlite.exec(`CREATE TABLE ar_merchant_membership(user_id INTEGER PRIMARY KEY,merchant_id INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',authorization_version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO ar_merchant_membership(user_id,merchant_id,role) VALUES(2,1,'manager'),(5,1,'adminer'),(12,2,'manager');`);
  if (shared) {
    db.sqlite.exec("CREATE TABLE ar_merchant(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO ar_merchant VALUES(1,'第一商户'),(2,'第二商户');");
    db.sqlite.prepare('UPDATE ar_user SET appid=? WHERE id IN (11,12)').run(first.user.appid);
  }
  const scoped = (identity: RentalPrincipal, merchantId: number): RentalPrincipal => ({ ...identity, merchantId, authVersion: 1, user: { ...identity.user, merchant_id: identity.user.role === 'root' ? null : merchantId, auth_version: 1 } });
  const user = scoped(first.user, 1), manager = scoped(first.manager, 1), root = scoped(first.root, 1);
  const userB = scoped({ user: { id: 11, role: 'user' }, appid: second.user.appid, openid: 'payer-11' }, 2);
  const managerB = scoped({ user: { id: 12, role: 'manager' }, appid: second.user.appid, openid: 'payer-12' }, 2);
  const merchantA: MerchantRuntime = { id: 1, code: 'first', name: '第一商户', status: 'active', origin: 'https://first.example', appId: first.user.appid, client: first.payment as any, configId: 1 };
  const merchantB: MerchantRuntime = { id: 2, code: 'second', name: '第二商户', status: 'active', origin: 'https://second.example', appId: second.user.appid, client: second.payment as any, configId: 2 };
  const clients = new Map<number, any>([[1, first.payment], [2, second.payment]]);
  const resolvePaymentConfig = vi.fn(async (id: number) => {
    const client = clients.get(id);
    if (!client) throw new ApiError(503, '原订单支付配置不可用');
    return client;
  });
  const resolvePaymentForOrder = vi.fn(async (row: Row) => resolvePaymentConfig(Number(row.payment_config_id)));
  const resolveMerchant = vi.fn(async (id: number) => {
    const merchant = id === 1 ? merchantA : id === 2 ? merchantB : null;
    if (!merchant) throw new ApiError(503, '商户微信配置未就绪');
    return merchant;
  });
  const options = { ...first.options, resolvePaymentForOrder, resolvePaymentConfig, ...(shared ? { resolveMerchant } : {}) };
  const service = new RentalService(first.services, options);
  const a = <T>(operation: () => T) => withMerchant({ entry: merchantA, merchant: merchantA }, operation);
  const b = <T>(operation: () => T) => withMerchant({ entry: merchantB, merchant: merchantB }, operation);
  const configure = () => a(() => service.configure(manager, 7, { enabled: true, version: 0 }));
  const configureB = () => b(() => service.configure(managerB, 9, { enabled: true, version: 0 }));
  const create = () => a(() => service.create(user, { deviceId: 7, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'merchant-a-rental' }));
  const createB = () => b(() => service.create(userB, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'merchant-b-rental' }));
  const providerSuccess = (order: Row, provider: typeof first) => {
    const payment = provider.orders.get(order.out_trade_no)!;
    payment.trade_state = 'SUCCESS';
    return payment;
  };
  return { first, second, db, service, options, a, b, user, manager, root, userB, managerB, merchantA, merchantB, clients, resolveMerchant, resolvePaymentForOrder, configure, configureB, create, createB, providerSuccess };
}

describe('shared mini-program merchant rentals', () => {
  it('keeps different mini-program identities isolated when merchant resolution is enabled', async () => {
    const f = merchantFixture(); await f.configure();
    const service = new RentalService(f.first.services, { ...f.options, resolveMerchant: f.resolveMerchant });
    const created = await f.create();
    await expect(f.a(() => service.context(f.user, 'second-device'))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
    await expect(f.b(() => service.get(f.userB, created.rental.id))).rejects.toMatchObject({ status: 404 });
    await expect(f.b(() => service.create(f.userB, { deviceId: 7, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'different-app-merchant' }))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
    expect(f.first.payment.order).not.toHaveBeenCalled(); expect(f.second.payment.order).not.toHaveBeenCalled();
  });
  it('selects a scanned device owner on the server and ignores client receiving-account fields', async () => {
    const f = merchantFixture(true); await f.configureB();
    expect(await f.a(() => f.service.context(f.user, 'second-device'))).toMatchObject({ merchant: { id: 2, name: '第二商户' }, device: { merchantId: 2, merchantName: '第二商户' }, actions: { canRent: true, canConfigure: false } });
    expect(await f.a(() => f.service.context(f.managerB, 'unregistered-shared-device'))).toMatchObject({ merchant: { id: 2 }, state: 'UNREGISTERED', actions: { canCreate: true } });
    const router = new ApiRouter();
    registerRentals(router, f.first.services, { ...f.options, authenticate: async () => f.user });
    const create = router.routes.find(route => route.method === 'POST' && route.path === '/v2/rentals')!;
    const created = await f.a(() => create.handler({ body: { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'shared-device-owner', merchantId: 1, mchId: 'forged-account', mchid: 'forged-account', paymentConfigId: 1 }, res: { setHeader() {}, status() {} } } as any)) as Row;
    const order = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    expect(order).toMatchObject({ user_id: 1, merchant_id: 2, payment_config_id: 2, appid: f.user.appid, payer_openid: 'payer-1', mch_id: 'second-merchant', total_cents: 12000 });
    await f.a(() => f.service.payment(f.user, order.id));
    f.providerSuccess(order, f.second);
    expect((await f.a(() => f.service.syncPayment(f.user, order.id))).rental).toMatchObject({ status: 'ACTIVE', merchantId: 2, merchantName: '第二商户' });
    expect(f.second.payment.order).toHaveBeenCalledTimes(1); expect(f.first.payment.order).not.toHaveBeenCalled();
    expect((await f.db.one('SELECT merchant_id FROM ar_user WHERE id=1'))!.merchant_id).toBe(1);
  });

  it('lists only the current payer across shared merchants while keeping employee authority scoped', async () => {
    const f = merchantFixture(true); await f.configure(); await f.configureB();
    const first = await f.create();
    const second = await f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'same-customer-second-merchant' }));
    const original = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [first.rental.id]))!;
    await f.db.insert('ar_rental_order', { ...original, id: undefined, user_id: 3, out_trade_no: 'other-customer-order', idempotency_key: 'other-customer-order' });
    await f.db.insert('ar_rental_order', { ...original, id: undefined, appid: 'wx-unrelated-application', out_trade_no: 'other-application-order', idempotency_key: 'other-application-order' });
    expect(await f.a(() => f.service.list(f.user, { merchantId: 1 }))).toMatchObject({ total: 2, items: [{ id: second.rental.id, merchantId: 2, merchantName: '第二商户', mine: true }, { id: first.rental.id, merchantId: 1, merchantName: '第一商户', mine: true }] });
    await expect(f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'merchant-a-rental' }))).rejects.toMatchObject({ status: 409 });
    await expect(f.a(() => f.service.get(f.manager, second.rental.id))).rejects.toMatchObject({ status: 403 });
    await expect(f.a(() => f.service.configure(f.manager, 9, { enabled: false, version: 1 }))).rejects.toMatchObject({ status: 403 });
    await expect(f.a(() => f.service.end(f.manager, second.rental.id, { refundMode: 'full', reason: '越权请求', idempotencyKey: 'wrong-merchant-refund' }))).rejects.toMatchObject({ status: 403 });
    expect(f.second.refunds.size).toBe(0);
  });

  it('fails closed for unregistered device owners, missing merchant configuration, inactive accounts and original credentials', async () => {
    const f = merchantFixture(true); await f.configureB();
    await expect(f.service.createDevice(f.manager, { venueId: 1, uuid: 'device-without-valid-owner', merchantId: 2 })).rejects.toMatchObject({ status: 503 });
    expect(await f.db.one('SELECT * FROM ar_device WHERE uuid=?', ['device-without-valid-owner'])).toBeNull();
    await f.db.execute('UPDATE ar_device SET merchant_id=999 WHERE id=9');
    await expect(f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'unregistered-device-owner' }))).rejects.toMatchObject({ status: 503 });
    await f.db.execute('UPDATE ar_device SET merchant_id=2 WHERE id=9');
    f.resolveMerchant.mockRejectedValueOnce(new ApiError(503, '商户微信配置未就绪'));
    await expect(f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'missing-merchant-config' }))).rejects.toMatchObject({ status: 503 });
    f.merchantB.status = 'paused';
    await expect(f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'inactive-merchant-config' }))).rejects.toMatchObject({ status: 503 });
    expect(await f.db.query('SELECT * FROM ar_rental_order')).toEqual([]);
    f.merchantB.status = 'active';
    const created = await f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'original-config-required' }));
    f.clients.delete(2);
    await expect(f.a(() => f.service.payment(f.user, created.rental.id))).rejects.toMatchObject({ status: 503 });
    expect((await f.a(() => f.service.context(f.user, 'second-device'))).state).toBe('RESERVED');
    expect(f.first.payment.order).not.toHaveBeenCalled(); expect(f.second.payment.order).not.toHaveBeenCalled();
    await f.db.execute('UPDATE ar_device SET merchant_id=1,venue_id=1 WHERE id=9');
    await expect(f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'inconsistent-device-owner' }))).rejects.toMatchObject({ status: 503 });
    await f.db.execute('UPDATE ar_user SET auth_version=2 WHERE id=1');
    await expect(f.create()).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks device ownership under the reservation lock after merchant routing', async () => {
    const f = merchantFixture(true); await f.configureB();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementationOnce(async operation => {
      await f.db.execute('UPDATE ar_device SET merchant_id=1,venue_id=1 WHERE id=9');
      return transaction(operation);
    });
    await expect(f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'ownership-changed-before-lock' }))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
    expect(await f.db.query('SELECT * FROM ar_rental_order')).toEqual([]);
    expect(await f.db.query('SELECT * FROM ar_rental_slot')).toEqual([]);
    expect(f.first.payment.order).not.toHaveBeenCalled(); expect(f.second.payment.order).not.toHaveBeenCalled();
  });

  it('retains the original merchant for late-payment compensation after a device transfer and account change', async () => {
    const f = merchantFixture(true); await f.configure(); await f.configureB();
    const created = await f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'old-shared-merchant-order' }));
    await f.a(() => f.service.payment(f.user, created.rental.id));
    const old = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    await f.a(() => f.service.cancel(f.user, old.id));
    await f.db.execute('UPDATE ar_device SET merchant_id=1,venue_id=1 WHERE id=9');
    await f.db.execute('UPDATE ar_rental_config SET merchant_id=1 WHERE device_id=9');
    const current = await f.a(() => f.service.create(f.user, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'new-shared-merchant-order' }));
    await f.a(() => f.service.payment(f.user, current.rental.id));
    const next = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [current.rental.id]))!;
    f.providerSuccess(next, f.first); await f.a(() => f.service.syncPayment(f.user, next.id));
    const replacement = fixture(f.user.appid, 'replacement-merchant');
    f.merchantB.client = replacement.payment as any; f.merchantB.configId = 3; f.clients.set(3, replacement.payment);
    f.providerSuccess(old, f.second);
    expect((await f.a(() => f.service.syncPayment(f.user, old.id))).rental.status).toBe('COMPENSATING');
    await f.service.processJobs();
    expect([...f.second.refunds.values()][0].amount.refund).toBe(12000);
    expect(f.first.refunds.size).toBe(0); expect(replacement.refunds.size).toBe(0);
    const refund = [...f.second.refunds.values()][0]; refund.status = 'SUCCESS';
    await expect(f.a(() => f.service.syncRefund(f.manager, old.id))).rejects.toMatchObject({ status: 403 });
    await f.a(() => f.service.syncRefund(f.managerB, old.id));
    expect(await f.a(() => f.service.context(f.user, 'second-device'))).toMatchObject({ merchant: { id: 1 }, state: 'RENTED', rental: { id: next.id }, relation: 'mine' });
    expect(replacement.payment.payment).not.toHaveBeenCalled();
  });
});

describe('merchant-scoped rentals and original payment accounts', () => {
  it('uses active memberships rather than stale account role projections for device authority', async () => {
    const f = merchantFixture(true);
    await f.db.execute("UPDATE ar_user SET role='user',merchant_id=NULL WHERE id=12");
    await f.configureB();
    expect((await f.a(() => f.service.context(f.managerB, 'second-device'))).actions.canConfigure).toBe(true);
    await f.db.execute("UPDATE ar_user SET role='manager',merchant_id=2 WHERE id=12");
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=12");
    expect((await f.a(() => f.service.context(f.managerB, 'second-device'))).actions.canConfigure).toBe(false);
    await expect(f.b(() => f.service.configure(f.managerB, 9, { enabled: false, version: 1 }))).rejects.toMatchObject({ status: 403 });
    await expect(f.b(() => f.service.createDevice(f.managerB, { venueId: 2, uuid: 'revoked-member-device' }))).rejects.toMatchObject({ status: 403 });
  });
  it('scopes platform totals and order searches to the selected merchant AppID, including root', async () => {
    const f = merchantFixture(); await f.configure(); await f.configureB();
    await f.create(); const second = await f.createB();
    const row = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [second.rental.id]))!;
    await f.db.insert('ar_rental_order', { ...row, id: undefined, appid: 'wx-invalid-legacy', out_trade_no: 'different-app-synthetic', idempotency_key: 'different-app-synthetic' });
    let actor = { ...f.root, merchantId: 2 };
    const router = new ApiRouter();
    registerManagement(router, f.db as any, { authenticate: async () => actor } as any, f.service);
    const overview = router.routes.find(route => route.path === '/v2/rental/admin/overview')!;
    const orders = router.routes.find(route => route.path === '/v2/rental/admin/orders')!;
    expect(await f.b(() => overview.handler({} as any))).toMatchObject({ devices: { total: 1 }, orders: { total: 1 } });
    expect(await f.b(() => orders.handler({ query: { search: 'second-device', merchantId: 1 } } as any))).toMatchObject({ total: 1, items: [{ id: second.rental.id }] });
    expect(await f.b(() => orders.handler({ query: { search: 'camera-7' } } as any))).toMatchObject({ total: 0, items: [] });
    actor = f.userB;
    await expect(f.b(() => overview.handler({} as any))).rejects.toMatchObject({ status: 403 });
  });

  it('isolates every device entry and order read, including forged manager scope', async () => {
    const f = merchantFixture(); await f.configure(); await f.configureB();
    const created = await f.create();
    expect(await f.a(() => f.service.devices(f.manager, {}))).toMatchObject({ total: 2 });
    expect(await f.b(() => f.service.devices(f.managerB, {}))).toMatchObject({ total: 1, items: [{ device: { id: 9 } }] });
    await expect(f.a(() => f.service.context(f.user, 'second-device'))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
    await expect(f.b(() => f.service.get(f.managerB, created.rental.id))).rejects.toMatchObject({ status: 404 });
    await expect(f.b(() => f.service.configure(f.managerB, 7, { enabled: false, version: 1 }))).rejects.toMatchObject({ status: 404 });
    await expect(f.b(() => f.service.create(f.userB, { deviceId: 7, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'wrong-merchant-device' }))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
    await expect(f.b(() => f.service.createDevice(f.managerB, { venueId: 2, uuid: 'camera-7' }))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
    const forged = { ...f.managerB, appid: f.user.appid, merchantId: 1, user: { ...f.managerB.user, merchant_id: 1 } };
    await expect(f.a(() => f.service.configure(forged, 7, { enabled: false, version: 1 }))).rejects.toMatchObject({ status: 403 });
    expect(f.first.payment.order).not.toHaveBeenCalled(); expect(f.second.payment.order).not.toHaveBeenCalled();
  });

  it('lets root manage the selected merchant while rejecting its other-app payer identity', async () => {
    const f = merchantFixture(); await f.configureB();
    const selectedRoot = { ...f.root, merchantId: 2 };
    expect(await f.b(() => f.service.devices(selectedRoot, {}))).toMatchObject({ total: 1 });
    expect((await f.b(() => f.service.context(selectedRoot, 'second-device'))).actions.canConfigure).toBe(true);
    await expect(f.b(() => f.service.create(selectedRoot, { deviceId: 9, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'root-other-app-payer' }))).rejects.toMatchObject({ status: 403 });
    const registered = await f.b(() => f.service.createDevice(selectedRoot, { venueId: 2, uuid: 'root-created-for-second' }));
    expect((await f.db.one('SELECT merchant_id FROM ar_device WHERE id=?', [registered.device.id]))!.merchant_id).toBe(2);
    const created = await f.createB();
    await expect(f.b(() => f.service.payment(selectedRoot, created.rental.id))).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks account assignment and version under the new-rental transaction', async () => {
    const f = merchantFixture(); await f.configure();
    await f.db.execute('UPDATE ar_user SET merchant_id=2,auth_version=2 WHERE id=?', [f.user.user.id]);
    await expect(f.create()).rejects.toMatchObject({ status: 403 });
    expect(await f.db.query('SELECT * FROM ar_rental_order')).toEqual([]);
    expect(await f.db.query('SELECT * FROM ar_rental_slot')).toEqual([]);
    await f.db.execute('UPDATE ar_user SET auth_version=2 WHERE id=?', [f.manager.user.id]);
    expect((await f.a(() => f.service.context(f.manager, 'camera-7'))).actions.canConfigure).toBe(false);
    await expect(f.a(() => f.service.createDevice(f.manager, { venueId: 1, uuid: 'stale-manager-device' }))).rejects.toMatchObject({ status: 403 });
  });

  it('snapshots merchant/config ownership on orders, configurations, slots, events and jobs', async () => {
    const f = merchantFixture(); await f.configureB(); const created = await f.createB();
    const order = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    expect(order).toMatchObject({ merchant_id: 2, payment_config_id: 2, appid: f.userB.appid, mch_id: 'second-merchant', total_cents: 12000 });
    for (const table of ['ar_rental_config', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job']) expect((await f.db.query('SELECT * FROM ' + table)).map(row => row.merchant_id)).toEqual([2]);
    await f.b(() => f.service.payment(f.userB, order.id));
    expect(f.second.payment.order.mock.calls[0][1]).toBe('https://d.4mr.cn/api/v2/rental/payment-notify/2');
    expect(f.first.payment.order).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched original credentials without borrowing a current client', async () => {
    const f = merchantFixture(); await f.configureB(); const created = await f.createB();
    f.clients.delete(2);
    await expect(f.b(() => f.service.payment(f.userB, created.rental.id))).rejects.toMatchObject({ status: 503 });
    f.clients.set(2, f.first.payment);
    await expect(f.b(() => f.service.payment(f.userB, created.rental.id))).rejects.toMatchObject({ status: 503 });
    expect(f.first.payment.order).not.toHaveBeenCalled(); expect(f.second.payment.order).not.toHaveBeenCalled();
    expect((await f.b(() => f.service.context(f.userB, 'second-device'))).state).toBe('RESERVED');
  });

  it('keeps previous config versions for existing orders and binds callbacks to that version', async () => {
    const f = merchantFixture(); await f.configureB(); const created = await f.createB();
    const original = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    const rotated = fixture(f.userB.appid, 'second-merchant');
    f.clients.set(3, rotated.payment); f.merchantB.client = rotated.payment as any; f.merchantB.configId = 3;
    await f.b(() => f.service.payment(f.userB, original.id));
    f.providerSuccess(original, f.second);
    const rawBody = Buffer.from(JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { out_trade_no: original.out_trade_no } }));
    await expect(f.service.paymentNotification({ params: { configId: '3' }, req: { rawBody, headers: {} } } as any)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.paymentNotification({ params: {}, req: { rawBody, headers: {} } } as any)).rejects.toMatchObject({ status: 403 });
    await f.service.paymentNotification({ params: { configId: '2' }, req: { rawBody, headers: {} } } as any);
    await f.service.paymentNotification({ params: { configId: '2' }, req: { rawBody, headers: {} } } as any);
    expect((await f.b(() => f.service.get(f.userB, original.id))).rental.status).toBe('ACTIVE');
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='PAYMENT_CONFIRMED'")).toHaveLength(1);
    expect(rotated.payment.order).not.toHaveBeenCalled(); expect(rotated.payment.payment).not.toHaveBeenCalled();
    expect(f.first.payment.payment).not.toHaveBeenCalled();
  });

  it('processes both merchants outside request context and settles refunds while paused', async () => {
    const f = merchantFixture(); await f.configure(); await f.configureB();
    const a = await f.create(), b = await f.createB();
    await f.a(() => f.service.payment(f.user, a.rental.id)); await f.b(() => f.service.payment(f.userB, b.rental.id));
    const orderA = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [a.rental.id]))!;
    const orderB = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [b.rental.id]))!;
    f.providerSuccess(orderA, f.first); f.providerSuccess(orderB, f.second);
    f.first.advance(30001); await f.service.processJobs();
    expect((await f.db.query('SELECT status FROM ar_rental_order')).map(row => row.status)).toEqual(['ACTIVE', 'ACTIVE']);
    f.merchantA.status = 'paused'; f.merchantB.status = 'draft';
    expect((await f.b(() => f.service.context(f.userB, 'second-device'))).paymentReady).toBe(false);
    await expect(f.createB()).rejects.toMatchObject({ status: 503 });
    await expect(f.b(() => f.service.payment(f.userB, orderB.id))).rejects.toMatchObject({ status: 503 });
    await f.a(() => f.service.end(f.manager, orderA.id, { refundMode: 'deposit', reason: '现场归还', idempotencyKey: 'merchant-a-refund' }));
    await f.b(() => f.service.end({ ...f.root, merchantId: 2 }, orderB.id, { refundMode: 'deposit', reason: 'root代为归还', idempotencyKey: 'merchant-b-refund' }));
    expect([...f.first.refunds.values()][0].amount.refund).toBe(8000);
    expect([...f.second.refunds.values()][0].amount.refund).toBe(9000);
    [...f.first.refunds.values()][0].status = 'SUCCESS'; [...f.second.refunds.values()][0].status = 'SUCCESS';
    f.first.advance(30001); await f.service.processJobs();
    expect(await f.db.query('SELECT * FROM ar_rental_slot')).toEqual([]);
    expect((await f.db.query('SELECT refund_status FROM ar_rental_order')).map(row => row.refund_status)).toEqual(['SUCCESS', 'SUCCESS']);
  });

  it('compensates a pre-transfer late payment through the original account without releasing the new rental', async () => {
    const f = merchantFixture(); await f.configure(); const created = await f.create();
    await f.a(() => f.service.payment(f.user, created.rental.id));
    const old = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    await f.a(() => f.service.cancel(f.user, old.id));
    await f.db.execute('UPDATE ar_device SET merchant_id=2,venue_id=2 WHERE id=7');
    await f.db.execute('UPDATE ar_rental_config SET merchant_id=2 WHERE device_id=7');
    const current = await f.b(() => f.service.create(f.userB, { deviceId: 7, venuePriceVersion: 1, priceVersion: 1, idempotencyKey: 'post-transfer-rental' }));
    await f.b(() => f.service.payment(f.userB, current.rental.id));
    const next = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [current.rental.id]))!;
    f.providerSuccess(next, f.second); await f.b(() => f.service.syncPayment(f.userB, next.id));
    f.providerSuccess(old, f.first);
    expect((await f.a(() => f.service.syncPayment(f.user, old.id))).rental.status).toBe('COMPENSATING');
    await f.service.processJobs();
    expect([...f.first.refunds.values()][0].amount.refund).toBe(10000);
    expect(f.second.refunds.size).toBe(0);
    [...f.first.refunds.values()][0].status = 'SUCCESS'; await f.a(() => f.service.syncRefund(f.manager, old.id));
    expect(await f.b(() => f.service.context(f.userB, 'camera-7'))).toMatchObject({ state: 'RENTED', rental: { id: next.id }, relation: 'mine' });
    await expect(f.a(() => f.service.context(f.manager, 'camera-7'))).rejects.toMatchObject({ code: 'MERCHANT_MISMATCH' });
  });

  it('rejects another config callback before querying or releasing a merchant refund', async () => {
    const f = merchantFixture(); await f.configureB(); const created = await f.createB();
    const order = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [created.rental.id]))!;
    await f.b(() => f.service.payment(f.userB, order.id)); f.providerSuccess(order, f.second);
    await f.b(() => f.service.syncPayment(f.userB, order.id));
    await f.b(() => f.service.end(f.managerB, order.id, { refundMode: 'deposit', reason: '已归还', idempotencyKey: 'second-refund-callback' }));
    const refund = [...f.second.refunds.values()][0]; refund.status = 'SUCCESS';
    const rawBody = Buffer.from(JSON.stringify({ event_type: 'REFUND.SUCCESS', resource: { out_refund_no: refund.out_refund_no } }));
    f.first.payment.payment.mockClear(); f.second.payment.payment.mockClear();
    await expect(f.service.refundNotification({ params: { configId: '1' }, req: { rawBody, headers: {} } } as any)).rejects.toMatchObject({ status: 403 });
    expect(f.first.payment.payment).not.toHaveBeenCalled(); expect(f.second.payment.payment).not.toHaveBeenCalled();
    expect((await f.b(() => f.service.context(f.userB, 'second-device'))).state).toBe('SETTLING');
    await f.service.refundNotification({ params: { configId: '2' }, req: { rawBody, headers: {} } } as any);
    expect((await f.b(() => f.service.context(f.userB, 'second-device'))).state).toBe('AVAILABLE');
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='REFUND_SUCCESS' AND merchant_id=2")).toHaveLength(1);
  });
});
