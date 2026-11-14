import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalService, registerRentals } from '../src/rentals';
import { ApiRouter } from '../src/core/router';
import type { Context, Row, Services } from '../src/core/contracts';
import type { RentalPrincipal } from '../src/rentals/types';
import { DeviceService } from '../src/devices/service';

const opened: RentalDb[] = [];
class RentalDb {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    opened.push(this);
    this.sqlite.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE ar_user(id INTEGER PRIMARY KEY,role TEXT,appid TEXT DEFAULT 'wx-rental-test');
      INSERT INTO ar_user(id,role) VALUES(1,'user'),(2,'manager'),(3,'user'),(4,'root');
      CREATE TABLE ar_device(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE,device_type TEXT DEFAULT 'ios',name TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO ar_device(id,uuid,device_type,name) VALUES(7,'camera-7','rokid','AR眼镜'),(8,'camera-8','ios','设备8');`);
    const mysql = readFileSync(resolve('database/002-rentals.sql'), 'utf8');
    const schema = mysql.replace(/^\s*--.*$/gm, '')
      .replace(/id int NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'id INTEGER PRIMARY KEY AUTOINCREMENT')
      .replace(/ CHARACTER SET ascii COLLATE ascii_bin/g, '')
      .replace(/UNIQUE KEY \w+ \(([^)]+)\)/g, 'UNIQUE ($1)')
      .replace(/,\s*KEY \w+ \([^)]+\)/g, '')
      .replace(/ENGINE=InnoDB CHARACTER SET utf8mb4/g, '');
    this.sqlite.exec(schema);
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

function fixture() {
  const db = new RentalDb();
  let now = 1794542400000;
  const appid = 'wx-rental-test';
  const user: RentalPrincipal = { user: { id: 1, role: 'user' }, appid, openid: 'payer-1' };
  const other: RentalPrincipal = { user: { id: 3, role: 'user' }, appid, openid: 'payer-3' };
  const manager: RentalPrincipal = { user: { id: 2, role: 'manager' }, appid, openid: 'payer-2' };
  const root: RentalPrincipal = { user: { id: 4, role: 'root' }, appid, openid: 'payer-4' };
  const orders = new Map<string, Row>(), refunds = new Map<string, Row>();
  const payment = {
    config: { appId: appid, mchId: 'merchant-rental', privateKey: 'test-private', serialNo: 'test-serial', apiV3Key: 'test-api-key', platformKeys: { test: 'test-public' } },
    assertPaymentApplication: vi.fn(),
    isPaymentReady: vi.fn(function(this: any) { return !!this.config.privateKey; }),
    order: vi.fn(async (input: Row) => {
      orders.set(input.out_trade_no, { out_trade_no: input.out_trade_no, appid, mchid: 'merchant-rental', payer: { openid: input.openid }, amount: { total: input.amount, currency: 'CNY' }, trade_state: 'NOTPAY', transaction_id: 'transaction-' + input.out_trade_no });
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
  const configure = (depositCents = 20000, useFeeCents = 2000) => service.configure(manager, 7, { enabled: true, useFeeCents, depositCents, version: 0 });
  const create = (principal = user, key = 'rental-request-1') => service.create(principal, { deviceId: 7, priceVersion: 1, idempotencyKey: key });
  const pay = async (principal = user) => {
    const result = await create(principal);
    await service.payment(principal, result.rental.id);
    const row = (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [result.rental.id]))!;
    const provider = orders.get(row.out_trade_no)!;
    provider.trade_state = 'SUCCESS'; provider.success_time = new Date(now).toISOString();
    const active = await service.syncPayment(principal, row.id);
    return { row, rental: active.rental, provider };
  };
  return { db, service, options, services, payment, orders, refunds, user, other, manager, root, configure, create, pay, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('independent AR rental lifecycle', () => {
  it('defaults omitted device types while preserving explicit and existing types', async () => {
    const f = fixture();
    expect(await f.service.createDevice(f.manager, { uuid: 'default-type-device' })).toMatchObject({ created: true, device: { type: 'Rokid Studio2' } });
    expect(await f.service.createDevice(f.manager, { uuid: 'explicit-ios-device', type: 'ios' })).toMatchObject({ device: { type: 'ios' } });
    expect(await f.service.createDevice(f.manager, { uuid: 'explicit-rokid-device', type: 'rokid' })).toMatchObject({ device: { type: 'rokid' } });
    expect(await f.service.createDevice(f.manager, { uuid: 'explicit-studio-device', type: 'rokid studio2' })).toMatchObject({ device: { type: 'Rokid Studio2' } });
    expect(await f.service.createDevice(f.manager, { uuid: 'short-studio-device', type: 'rs2' })).toMatchObject({ created: true, device: { type: 'Rokid Studio2' } });
    expect((await f.db.one('SELECT device_type FROM ar_device WHERE uuid=?', ['short-studio-device']))!.device_type).toBe('Rokid Studio2');
    expect(await f.service.createDevice(f.manager, { uuid: 'camera-8', type: 'rs2' })).toMatchObject({ created: false, device: { type: 'ios' } });
    expect((await f.service.context(f.user, 'camera-8')).device.type).toBe('ios');
    expect(DeviceService.display({ id: 99, uuid: 'legacy-empty', device_type: '' }).type).toBe('Rokid Studio2');
    await f.db.insert('ar_device', { uuid: 'legacy-model-case', name: 'Synthetic legacy model', device_type: 'rokid studio3' });
    expect((await f.service.context(f.user, 'legacy-model-case')).device.type).toBe('Rokid Studio3');
    expect((await f.db.one('SELECT device_type FROM ar_device WHERE uuid=?', ['legacy-model-case']))!.device_type).toBe('rokid studio3');
  });
  it('registers devices only for managers, without creating a rental configuration or mutating duplicate scans', async () => {
    const f = fixture();
    await expect(f.service.createDevice(f.user, { uuid: 'new-device' })).rejects.toMatchObject({ status: 403 });
    const result = await f.service.createDevice(f.manager, { uuid: 'new-device', type: 'rokid', name: '租赁眼镜' });
    expect(result).toMatchObject({ created: true, device: { uuid: 'new-device', name: '租赁眼镜', type: 'rokid' } });
    expect(await f.service.createDevice(f.root, { uuid: 'new-device', type: 'ios', name: '覆盖名称' })).toMatchObject({ created: false, device: result.device });
    const context = await f.service.context(f.user, 'new-device');
    expect(context).toMatchObject({ state: 'DISABLED', pricing: { enabled: false, version: 0 }, actions: { canRent: false } });
    expect(await f.db.query('SELECT * FROM ar_rental_config')).toEqual([]);
    await expect(f.service.createDevice(f.manager, { uuid: 'bad uuid' })).rejects.toMatchObject({ status: 422 });
    await expect(f.service.createDevice(f.manager, { uuid: 'valid', type: ' ios' })).rejects.toMatchObject({ status: 422 });
  });
  it('searches independent device names with literal wildcard characters and enforces management access', async () => {
    const f = fixture();
    await f.service.createDevice(f.manager, { uuid: 'literal-device', name: '设备100%_ready' });
    await expect(f.service.devices(f.user, {})).rejects.toMatchObject({ status: 403 });
    const result = await f.service.devices(f.manager, { search: '%_', 'per-page': 1 });
    expect(result).toMatchObject({ page: 1, pageSize: 1, total: 1, items: [{ device: { uuid: 'literal-device' }, state: 'DISABLED' }] });
    expect((await f.service.devices(f.root, { search: 'AR眼镜' })).total).toBe(1);
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
    await expect(f.service.configure(f.user, 7, { enabled: true, useFeeCents: 1, depositCents: 1, version: 0 })).rejects.toMatchObject({ status: 403 });
    await f.configure();
    const result = await f.service.create(f.user, { deviceId: 7, priceVersion: 1, idempotencyKey: 'rental-request-1', totalCents: 1, useFeeCents: 1, openid: 'forged' });
    expect(result.rental).toMatchObject({ useFeeCents: 2000, depositCents: 20000, totalCents: 22000, status: 'PENDING_PAYMENT' });
    const row = await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [result.rental.id]);
    expect(row!.payer_openid).toBe('payer-1');
    expect(row!.out_trade_no).toMatch(/^ARL_[a-f0-9]{24}$/);
    await f.service.configure(f.manager, 7, { enabled: true, useFeeCents: 3000, depositCents: 10000, version: 1 });
    expect((await f.service.get(f.user, result.rental.id)).rental.totalCents).toBe(22000);
  });
  it('requires refreshed quote and prevents another payer from reserving an occupied device', async () => {
    const f = fixture(); await f.configure();
    await expect(f.service.create(f.user, { deviceId: 7, priceVersion: 2, idempotencyKey: 'rental-request-1' })).rejects.toMatchObject({ status: 409 });
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
  it('normally charges managers and roots when they rent for themselves', async () => {
    for (const role of ['manager', 'root']) {
      const f = fixture(); await f.configure(); const actor = role === 'root' ? f.root : f.manager;
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
    const forgedManager = { ...f.user, user: { ...f.user.user, role: 'manager' } };
    await expect(f.service.end(forgedManager, paid.row.id, { refundMode: 'deposit', reason: '伪造身份', idempotencyKey: 'forged-manager-end' })).rejects.toMatchObject({ status: 403 });
    const actions = { canEndRental: false, canSyncRefund: false, canRetryRefund: false };
    expect(await f.service.get(f.user, paid.row.id)).toMatchObject({ rental: { status: 'ACTIVE', mine: true }, actions });
    expect(await f.service.context(f.user, 'camera-7')).toMatchObject({ state: 'RENTED', actions });
    expect((await f.service.context(f.manager, 'camera-7')).actions.canEndRental).toBe(true);
    expect(f.payment.payment).not.toHaveBeenCalled();
    expect(f.refunds.size).toBe(0);
    expect(await f.db.query("SELECT * FROM ar_rental_event WHERE event='RENTAL_ENDED'")).toEqual([]);
  });
  it.each(['manager', 'root'])('allows a current %s who is also the payer to settle only with management permission', async role => {
    const f = fixture(); await f.configure(); const actor = role === 'root' ? f.root : f.manager;
    const paid = await f.pay(actor);
    expect((await f.service.get(actor, paid.row.id)).actions.canEndRental).toBe(true);
    const result = await f.service.end(actor, paid.row.id, { refundMode: 'full', reason: '管理员确认本人设备归还', idempotencyKey: 'own-admin-end-' + role, refundAmountCents: 1 });
    expect(result.rental).toMatchObject({ mine: true, status: 'ENDED', refundAmountCents: 22000, refundStatus: 'PROCESSING' });
    expect([...f.refunds.values()][0].amount).toEqual({ refund: 22000, total: 22000, currency: 'CNY' });
    expect((await f.service.context(actor, 'camera-7')).state).toBe('SETTLING');
  });
  it('rechecks the manager inside the settlement transaction after a role revocation', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    const originalOne = f.db.one.bind(f.db);
    let revoked = false;
    vi.spyOn(f.db, 'one').mockImplementation(async (sql, values) => {
      const result = await originalOne(sql, values);
      // Revoke immediately after the initial management read, before the
      // device/order lock and final settlement authorization are acquired.
      if (!revoked && sql === 'SELECT role FROM ar_user WHERE id = ? AND appid = ?') {
        revoked = true;
        await f.db.execute("UPDATE ar_user SET role='user' WHERE id=?", [f.manager.user.id]);
      }
      return result;
    });
    f.payment.payment.mockClear();
    await expect(f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '已撤销管理员', idempotencyKey: 'revoked-during-end' })).rejects.toMatchObject({ status: 403 });
    expect(revoked).toBe(true);
    expect((await f.service.context(f.manager, 'camera-7')).actions).toMatchObject({ canEndRental: false, canSyncRefund: false, canRetryRefund: false });
    await expect(f.service.get(f.manager, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.syncRefund(f.manager, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.retryRefund(f.manager, paid.row.id)).rejects.toMatchObject({ status: 403 });
    expect((await f.service.get(f.user, paid.row.id)).rental.status).toBe('ACTIVE');
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('RENTED');
    expect(f.payment.payment).not.toHaveBeenCalled();
    expect(f.refunds.size).toBe(0);
  });
  it('keeps an approved timed-out refund occupied and retries the same refund only for a current administrator', async () => {
    const f = fixture(); await f.configure(); const paid = await f.pay();
    f.payment.payment.mockRejectedValueOnce(new Error('refund request timed out'));
    const ended = await f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '现场确认归还', idempotencyKey: 'timeout-end-request' });
    expect(ended.rental).toMatchObject({ status: 'ENDED', refundStatus: 'PENDING', refundAmountCents: 20000 });
    const pending = (await f.db.one('SELECT * FROM ar_rental_order WHERE id=?', [paid.row.id]))!;
    expect((await f.service.context(f.user, 'camera-7')).state).toBe('SETTLING');
    const before = f.payment.payment.mock.calls.length;
    await expect(f.service.syncRefund(f.user, paid.row.id)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.retryRefund(f.user, paid.row.id)).rejects.toMatchObject({ status: 403 });
    expect(await f.service.get(f.user, paid.row.id)).toMatchObject({ rental: { refundStatus: 'PENDING' }, actions: { canEndRental: false, canSyncRefund: false, canRetryRefund: false } });
    expect(f.payment.payment.mock.calls).toHaveLength(before);
    expect(await f.service.get(f.manager, paid.row.id)).toMatchObject({ actions: { canEndRental: false, canSyncRefund: true, canRetryRefund: true } });
    expect((await f.service.retryRefund(f.manager, paid.row.id)).rental.refundStatus).toBe('PROCESSING');
    expect([...f.refunds.keys()]).toEqual([pending.out_refund_no]);
    await f.service.end(f.root, paid.row.id, { refundMode: 'deposit', reason: '重复确认', idempotencyKey: 'timeout-end-duplicate' });
    expect(f.refunds.size).toBe(1);
    await f.db.execute("UPDATE ar_user SET role='user' WHERE id=?", [f.manager.user.id]);
    await expect(f.service.end(f.manager, paid.row.id, { refundMode: 'deposit', reason: '已撤销权限后重试', idempotencyKey: 'revoked-end-duplicate' })).rejects.toMatchObject({ status: 403 });
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
