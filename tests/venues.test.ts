import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RentalPrincipal } from '../src/auth';
import type { Row } from '../src/core/contracts';
import type { Database } from '../src/core/database';
import { runWithMerchant, type MerchantRuntime } from '../src/merchants/context';
import { publicVenue, VenueService } from '../src/venues';

const opened: DatabaseSync[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

async function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY,role TEXT,merchant_id INTEGER,auth_version INTEGER DEFAULT 0);
    INSERT INTO ar_user VALUES(1,'root',NULL,0),(2,'adminer',1,0),(3,'manager',1,0),(4,'user',1,0),(5,'adminer',2,0);
    CREATE TABLE ar_merchant_membership(user_id INTEGER PRIMARY KEY,merchant_id INTEGER,role TEXT,status TEXT,authorization_version INTEGER,updated_ms INTEGER);
    INSERT INTO ar_merchant_membership VALUES(2,1,'adminer','active',1,1800000000000),(3,1,'manager','active',1,1800000000000),(5,2,'adminer','active',1,1800000000000);
    CREATE TABLE ar_venue(id INTEGER PRIMARY KEY AUTOINCREMENT,merchant_id INTEGER NOT NULL,name TEXT NOT NULL,address TEXT DEFAULT '',contact_name TEXT DEFAULT '',contact_phone TEXT DEFAULT '',description TEXT DEFAULT '',status TEXT DEFAULT 'active',use_fee_cents INTEGER NOT NULL,deposit_cents INTEGER NOT NULL,version INTEGER NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,updated_by INTEGER,legacy_device_id INTEGER UNIQUE);`);
  const clean = (sql: string) => sql.replace(/ FOR UPDATE/g, '');
  const db = {
    async query(sql: string, params: any[] = []) { return sqlite.prepare(clean(sql)).all(...params) as Row[]; },
    async one(sql: string, params: any[] = []) { return (await this.query(sql, params))[0] ?? null; },
    async execute(sql: string, params: any[] = []) { const result = sqlite.prepare(clean(sql)).run(...params); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async insert(table: string, values: Row) { const entries = Object.entries(values); const result = await this.execute(`INSERT INTO ${table}(${entries.map(([key]) => key)}) VALUES(${entries.map(() => '?')})`, entries.map(([, value]) => value)); return (await this.one(`SELECT * FROM ${table} WHERE id=?`, [result.insertId]))!; },
    async transaction<T>(operation: (db: any) => Promise<T>) { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const runtime = (id: number): MerchantRuntime => ({ id, code: 'merchant' + id, name: '商户' + id, appId: 'wx03dbf50c15cac06f', origin: 'https://d.example.test', status: 'active', configId: id, client: {} as any });
  const first = runtime(1), second = runtime(2);
  const principal = async (id: number): Promise<RentalPrincipal> => ({ user: (await db.one('SELECT * FROM ar_user WHERE id=?', [id]))!, appid: first.appId, openid: 'synthetic-' + id, authVersion: 0 });
  const service = new VenueService(db as unknown as Database, () => 1800000000000);
  const input = { name: '合成测试场地', address: '测试地址', contactName: '测试联系人', contactPhone: '+86 138 0013 8000', description: '场地说明\n第二行', useFeeCents: 100, depositCents: 2000 };
  return { db, service, first, second, principal, input };
}

describe('venue merchant scope, pricing and management permissions', () => {
  it('takes venue ownership from the authenticated merchant and omits internal fields from public details', async () => {
    const f = await fixture(), adminer = await f.principal(2);
    const result = await runWithMerchant(f.first, () => f.service.create(adminer, { ...f.input, merchantId: 2, updatedBy: 1 }));
    expect(result.venue).toMatchObject({ merchantId: 1, name: f.input.name, contactPhone: f.input.contactPhone, useFeeCents: 100, depositCents: 2000, status: 'active', version: 1 });
    const row = (await f.db.one('SELECT * FROM ar_venue WHERE id=?', [result.venue.id]))!;
    expect(row).toMatchObject({ merchant_id: 1, updated_by: 2 });
    expect(publicVenue(row)).toEqual({ id: result.venue.id, name: f.input.name, address: f.input.address, description: f.input.description });
  });
  it('allows managers to list only their merchant venues and denies them write access', async () => {
    const f = await fixture(), adminer = await f.principal(2), manager = await f.principal(3), root = await f.principal(1);
    const own = await runWithMerchant(f.first, () => f.service.create(adminer, f.input));
    await runWithMerchant(f.second, () => f.service.create(root, { ...f.input, name: '另一个商户场地' }));
    expect(await runWithMerchant(f.first, () => f.service.list(manager, { merchantId: 2 }))).toMatchObject({ items: [{ id: own.venue.id, merchantId: 1 }] });
    await expect(runWithMerchant(f.first, () => f.service.create(manager, f.input))).rejects.toMatchObject({ status: 403 });
    await expect(runWithMerchant(f.first, () => f.service.update(manager, own.venue.id, { version: 1, status: 'paused' }))).rejects.toMatchObject({ status: 403 });
  });
  it('rejects ordinary users and staff selecting another merchant even with forged client roles', async () => {
    const f = await fixture(), user = await f.principal(4), adminer = await f.principal(2);
    user.user.role = 'root';
    await expect(runWithMerchant(f.first, () => f.service.list(user))).rejects.toMatchObject({ status: 403 });
    await expect(runWithMerchant(f.first, () => f.service.create(user, f.input))).rejects.toMatchObject({ status: 403 });
    await expect(runWithMerchant(f.second, () => f.service.create(adminer, f.input))).rejects.toMatchObject({ status: 403 });
    expect(await f.db.query('SELECT * FROM ar_venue')).toHaveLength(0);
  });
  it('rechecks database roles and authentication version inside the transaction', async () => {
    const f = await fixture(), adminer = await f.principal(2);
    await f.db.execute("UPDATE ar_merchant_membership SET role='manager' WHERE user_id=2");
    await expect(runWithMerchant(f.first, () => f.service.create(adminer, f.input))).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_merchant_membership SET role='adminer' WHERE user_id=2");
    await f.db.execute('UPDATE ar_user SET auth_version=1 WHERE id=2');
    await expect(runWithMerchant(f.first, () => f.service.create(adminer, f.input))).rejects.toMatchObject({ status: 401 });
    expect(await f.db.query('SELECT * FROM ar_venue')).toHaveLength(0);
  });
  it('updates pricing and status with optimistic versions and cannot edit a different merchant venue', async () => {
    const f = await fixture(), adminer = await f.principal(2), root = await f.principal(1);
    const created = await runWithMerchant(f.first, () => f.service.create(adminer, f.input));
    const updated = await runWithMerchant(f.first, () => f.service.update(adminer, created.venue.id, { version: 1, useFeeCents: 200, depositCents: 3000, status: 'paused', merchantId: 2 }));
    expect(updated.venue).toMatchObject({ merchantId: 1, useFeeCents: 200, depositCents: 3000, status: 'paused', version: 2 });
    await expect(runWithMerchant(f.first, () => f.service.update(adminer, created.venue.id, { version: 1, useFeeCents: 900 }))).rejects.toMatchObject({ status: 409 });
    await expect(runWithMerchant(f.second, () => f.service.update(root, created.venue.id, { version: 2, status: 'active' }))).rejects.toMatchObject({ status: 404 });
    expect(await runWithMerchant(f.first, () => f.service.list(adminer, { status: 'active' }))).toEqual({ items: [] });
    expect(await runWithMerchant(f.first, () => f.service.list(adminer, { status: 'paused' }))).toMatchObject({ items: [{ id: created.venue.id }] });
  });
  it.each([undefined, -1, 1.1, '100', NaN, Infinity, 2147483648])('rejects a non-integer or out-of-range fee: %s', async value => {
    const f = await fixture(), adminer = await f.principal(2);
    await expect(runWithMerchant(f.first, () => f.service.create(adminer, { ...f.input, useFeeCents: value }))).rejects.toMatchObject({ status: 422 });
    expect(await f.db.query('SELECT * FROM ar_venue')).toHaveLength(0);
  });
  it('rejects overflowing totals, invalid versions, status and control characters', async () => {
    const f = await fixture(), adminer = await f.principal(2);
    for (const invalid of [{ useFeeCents: 2147483647, depositCents: 1 }, { name: 'bad\u0000name' }, { status: 'deleted' }]) {
      await expect(runWithMerchant(f.first, () => f.service.create(adminer, { ...f.input, ...invalid }))).rejects.toMatchObject({ status: 422 });
    }
    const created = await runWithMerchant(f.first, () => f.service.create(adminer, f.input));
    await expect(runWithMerchant(f.first, () => f.service.update(adminer, created.venue.id, { status: 'paused' }))).rejects.toMatchObject({ status: 422 });
  });
  it('rolls back a venue edit if its final read fails', async () => {
    const f = await fixture(), adminer = await f.principal(2);
    const created = await runWithMerchant(f.first, () => f.service.create(adminer, f.input)), original = f.db.one.bind(f.db);
    const failure = vi.spyOn(f.db, 'one').mockImplementation(async (sql, params) => {
      if (sql === 'SELECT * FROM ar_venue WHERE id=? AND merchant_id=?') throw Error('Synthetic venue transaction failure');
      return original(sql, params);
    });
    await expect(runWithMerchant(f.first, () => f.service.update(adminer, created.venue.id, { version: 1, useFeeCents: 200 }))).rejects.toThrow('Synthetic venue transaction failure');
    failure.mockRestore();
    expect(await f.db.one('SELECT use_fee_cents,version FROM ar_venue WHERE id=?', [created.venue.id])).toEqual({ use_fee_cents: 100, version: 1 });
  });
});
