import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Row, Services } from '../src/core/contracts';
import { RentalService } from '../src/rentals/service';
import type { RentalPrincipal } from '../src/rentals/types';
import { withMerchant, type MerchantRuntime } from '../src/merchants/context';

const appId = 'wx0123456789abcdef';
const opened: DeviceDb[] = [];
class DeviceDb {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    opened.push(this);
    this.sqlite.exec(`
      CREATE TABLE ar_user(id INTEGER PRIMARY KEY,role TEXT,appid TEXT,merchant_id INTEGER,auth_version INTEGER NOT NULL);
      INSERT INTO ar_user VALUES(1,'root','${appId}',NULL,1),(2,'manager','${appId}',1,1),(3,'adminer','${appId}',2,1),(4,'user','${appId}',NULL,1);
      CREATE TABLE ar_merchant(id INTEGER PRIMARY KEY,name TEXT);
      INSERT INTO ar_merchant VALUES(1,'默认商户'),(2,'测试商户');
      CREATE TABLE ar_merchant_membership(user_id INTEGER PRIMARY KEY,merchant_id INTEGER,role TEXT,status TEXT,authorization_version INTEGER);
      INSERT INTO ar_merchant_membership VALUES(2,1,'manager','active',1),(3,2,'adminer','active',1);
      CREATE TABLE ar_venue(id INTEGER PRIMARY KEY,merchant_id INTEGER,name TEXT,address TEXT,description TEXT,status TEXT,use_fee_cents INTEGER,deposit_cents INTEGER,version INTEGER,contact_phone TEXT);
      INSERT INTO ar_venue VALUES(101,1,'默认场地','','','active',2000,8000,1,'private-contact'),(202,2,'测试场地','','','active',300,1000,1,'private-contact');
      CREATE TABLE ar_device(id INTEGER PRIMARY KEY,uuid TEXT,sn TEXT,name TEXT,device_type TEXT,merchant_id INTEGER,venue_id INTEGER,remark_name TEXT DEFAULT '',deleted_ms INTEGER,superseded INTEGER NOT NULL DEFAULT 0,current_uuid TEXT GENERATED ALWAYS AS (CASE WHEN superseded=0 THEN uuid END) UNIQUE,current_sn TEXT GENERATED ALWAYS AS (CASE WHEN superseded=0 THEN sn END) UNIQUE);
      CREATE TABLE ar_device_retired_identifier(kind TEXT,identifier TEXT,original_identifier TEXT,device_id INTEGER,PRIMARY KEY(kind,identifier));
      INSERT INTO ar_device(id,uuid,name,device_type,merchant_id,venue_id) VALUES(11,'global-1','设备Alpha %_','Rokid Studio2',1,101),(12,'global-2','设备Beta %_','Rokid Studio2',2,202),(13,'global-3','第三台设备','Rokid Studio3',1,101);
      CREATE TABLE ar_rental_config(device_id INTEGER PRIMARY KEY,merchant_id INTEGER,enabled INTEGER,version INTEGER);
      INSERT INTO ar_rental_config VALUES(11,1,1,1),(12,2,1,1),(13,1,0,1);
      CREATE TABLE ar_rental_order(id INTEGER PRIMARY KEY,device_id INTEGER,merchant_id INTEGER,status TEXT,refund_amount_cents INTEGER,refund_status TEXT);
      CREATE TABLE ar_rental_slot(device_id INTEGER PRIMARY KEY,rental_id INTEGER,merchant_id INTEGER,state TEXT);
    `);
  }
  async query(sql: string, values: unknown[] = []): Promise<Row[]> { return this.sqlite.prepare(sql).all(...values as any[]) as Row[]; }
  async one(sql: string, values: unknown[] = []): Promise<Row | null> { return (await this.query(sql, values))[0] ?? null; }
  async execute(sql: string, values: unknown[] = []): Promise<void> { this.sqlite.prepare(sql).run(...values as any[]); }
}
afterEach(() => { for (const db of opened.splice(0)) db.sqlite.close(); vi.restoreAllMocks(); });

function fixture() {
  const db = new DeviceDb();
  const payment = { config: { appId, mchId: 'synthetic-account' }, isPaymentReady: () => false } as any;
  const merchants: MerchantRuntime[] = [1, 2].map(id => ({ id, code: id === 1 ? 'default' : 'test', name: id === 1 ? '默认商户' : '测试商户',
    status: 'active', origin: 'https://d.4mr.cn', appId, configId: id, client: payment }));
  const service = new RentalService({ db } as unknown as Services, { authenticate: async () => root, payment, appId,
    resolveMerchant: async id => merchants.find(merchant => merchant.id === id)! });
  const principal = (id: number, role: string, merchantId: number | null): RentalPrincipal => ({ appid: appId, openid: 'synthetic-' + id,
    merchantId: merchantId ?? 1, authVersion: 1, user: { id, role, merchant_id: merchantId, auth_version: 1 } });
  const root = principal(1, 'root', null), manager = principal(2, 'manager', 1), adminer = principal(3, 'adminer', 2), user = principal(4, 'user', null);
  const scoped = <T>(merchantId: number, operation: () => T): T => withMerchant({ entry: merchants[0], merchant: merchants[merchantId - 1] }, operation);
  return { db, service, root, manager, adminer, user, scoped };
}

describe('explicit root device listing across merchants', () => {
  it('paginates all merchants in one query and reports each actual merchant and public venue', async () => {
    const f = fixture(), query = vi.spyOn(f.db, 'query'), execute = vi.spyOn(f.db, 'execute');
    const first = await f.scoped(1, () => f.service.devices(f.root, { scope: 'all', pageSize: 2 }));
    expect(first).toMatchObject({ scope: 'all', page: 1, pageSize: 2, total: 3, items: [
      { device: { id: 13, merchantId: 1, merchantName: '默认商户' }, state: 'DISABLED' },
      { device: { id: 12, merchantId: 2, merchantName: '测试商户' }, state: 'AVAILABLE' },
    ] });
    expect(first).not.toHaveProperty('merchantId');
    expect(query).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
    expect(first.items[1].venue).toEqual({ id: 202, name: '测试场地', address: '', description: '' });
    expect(first.items[1].device).not.toHaveProperty('rental_exists');
    const second = await f.scoped(1, () => f.service.devices(f.root, { scope: 'all', pageSize: 2, page: 2 }));
    expect(second).toMatchObject({ scope: 'all', page: 2, total: 3, items: [{ device: { id: 11, merchantName: '默认商户' } }] });
  });

  it('searches literal wildcard characters across merchants before applying pagination', async () => {
    const f = fixture();
    expect(await f.scoped(1, () => f.service.devices(f.root, { scope: 'all', search: '%_', 'per-page': 1 })))
      .toMatchObject({ total: 2, pageSize: 1, items: [{ device: { id: 12 } }] });
    expect(await f.scoped(1, () => f.service.devices(f.root, { scope: 'all', search: 'Alpha' })))
      .toMatchObject({ total: 1, items: [{ device: { id: 11 } }] });
  });

  it('keeps the default and explicit merchant scope on the selected merchant for root and staff', async () => {
    const f = fixture();
    expect(await f.scoped(1, () => f.service.devices(f.root, {}))).toMatchObject({ scope: 'merchant', merchantId: 1, total: 2 });
    expect(await f.scoped(2, () => f.service.devices(f.root, { scope: 'merchant' })))
      .toMatchObject({ scope: 'merchant', merchantId: 2, total: 1, items: [{ device: { id: 12, merchantName: '测试商户' } }] });
    expect(await f.scoped(1, () => f.service.devices(f.manager, { venueId: 101 }))).toMatchObject({ scope: 'merchant', merchantId: 1, total: 2 });
    expect(await f.scoped(2, () => f.service.devices(f.adminer, { scope: 'merchant' }))).toMatchObject({ scope: 'merchant', merchantId: 2, total: 1 });
    await expect(f.scoped(2, () => f.service.devices(f.manager, {}))).rejects.toMatchObject({ status: 403 });
  });

  it('limits a manager count, search and pagination to the selected venue and permits switching to a paused venue', async () => {
    const f = fixture();
    f.db.sqlite.exec(`INSERT INTO ar_venue SELECT 102,merchant_id,'暂停景点',address,description,'paused',use_fee_cents,deposit_cents,version,contact_phone FROM ar_venue WHERE id=101;
      UPDATE ar_device SET venue_id=102,name='设备Alpha %_ another venue' WHERE id=13;
      INSERT INTO ar_device(id,uuid,name,device_type,merchant_id,venue_id) VALUES(14,'venue-101-14','设备Alpha %_ 14','Rokid Studio2',1,101),(15,'venue-101-15','设备Alpha %_ 15','Rokid Studio2',1,101);`);
    const first = await f.scoped(1, () => f.service.devices(f.manager, { venueId: '101', search: '%_', pageSize: 2 }));
    expect(first).toMatchObject({ total: 3, page: 1, items: [{ device: { id: 15, venueId: 101 } }, { device: { id: 14, venueId: 101 } }] });
    expect(await f.scoped(1, () => f.service.devices(f.manager, { venueId: 101, search: '%_', pageSize: 2, page: 2 })))
      .toMatchObject({ total: 3, page: 2, items: [{ device: { id: 11, venueId: 101 } }] });
    expect(await f.scoped(1, () => f.service.devices(f.manager, { venueId: 102, search: '%_' })))
      .toMatchObject({ total: 1, items: [{ device: { id: 13, venueId: 102 }, state: 'DISABLED' }] });
    expect(await f.scoped(1, () => f.service.devices(f.manager, { venueId: 101, search: 'another venue' })))
      .toMatchObject({ total: 0, items: [] });
  });

  it('requires a venue for a manager and rejects foreign or missing venue identifiers without widening scope', async () => {
    const f = fixture();
    await expect(f.scoped(1, () => f.service.devices(f.manager, {}))).rejects.toMatchObject({ status: 422 });
    await expect(f.scoped(1, () => f.service.devices(f.manager, { venueId: 202 }))).rejects.toMatchObject({ status: 404 });
    await expect(f.scoped(1, () => f.service.devices(f.manager, { venueId: 999 }))).rejects.toMatchObject({ status: 404 });
    await expect(f.scoped(2, () => f.service.devices(f.manager, { venueId: 202 }))).rejects.toMatchObject({ status: 403 });
  });

  it.each([null, 0, -1, 1.5, true, '', '01', '1e2', '101x', ['101'], {}])('rejects an invalid selected venue %j', async venueId => {
    const f = fixture();
    await expect(f.scoped(1, () => f.service.devices(f.manager, { venueId }))).rejects.toMatchObject({ status: 422 });
  });

  it('keeps adminer access across its whole merchant and checks optional venue scope for all administrators', async () => {
    const f = fixture();
    f.db.sqlite.exec("INSERT INTO ar_venue SELECT 203,merchant_id,'另一景点',address,description,status,use_fee_cents,deposit_cents,version,contact_phone FROM ar_venue WHERE id=202; INSERT INTO ar_device(id,uuid,name,device_type,merchant_id,venue_id) VALUES(14,'adminer-203','另一景点设备','Rokid Studio2',2,203)");
    expect(await f.scoped(2, () => f.service.devices(f.adminer, {}))).toMatchObject({ total: 2 });
    expect(await f.scoped(2, () => f.service.devices(f.adminer, { venueId: 203 })))
      .toMatchObject({ total: 1, items: [{ device: { id: 14, venueId: 203 } }] });
    await expect(f.scoped(2, () => f.service.devices(f.adminer, { venueId: 101 }))).rejects.toMatchObject({ status: 404 });
    await expect(f.scoped(1, () => f.service.devices(f.root, { scope: 'all', venueId: 101 }))).rejects.toMatchObject({ status: 422 });
    expect(await f.scoped(1, () => f.service.devices(f.root, { venueId: 101 }))).toMatchObject({ total: 2 });
  });

  it('uses the current database role for venue requirements and rejects revoked or versioned-out staff', async () => {
    const f = fixture();
    const forged = { ...f.manager, user: { ...f.manager.user, role: 'adminer' } };
    await expect(f.scoped(1, () => f.service.devices(forged, {}))).rejects.toMatchObject({ status: 422 });
    f.db.sqlite.exec("UPDATE ar_merchant_membership SET role='manager' WHERE user_id=3");
    await expect(f.scoped(2, () => f.service.devices(f.adminer, {}))).rejects.toMatchObject({ status: 422 });
    expect(await f.scoped(2, () => f.service.devices(f.adminer, { venueId: 202 }))).toMatchObject({ total: 1 });
    f.db.sqlite.exec("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=2");
    await expect(f.scoped(1, () => f.service.devices(f.manager, { venueId: 101 }))).rejects.toMatchObject({ status: 403 });
    f.db.sqlite.exec('UPDATE ar_user SET auth_version=2 WHERE id=3');
    await expect(f.scoped(2, () => f.service.devices(f.adminer, { venueId: 202 }))).rejects.toMatchObject({ status: 403 });
  });

  it.each(['manager', 'adminer', 'user'] as const)('rejects global scope for %s', async role => {
    const f = fixture();
    await expect(f.scoped(role === 'adminer' ? 2 : 1, () => f.service.devices(f[role], { scope: 'all' }))).rejects.toMatchObject({ status: 403 });
  });

  it('requires the current database role to be root even when a manager forges a root principal', async () => {
    const f = fixture();
    const forged = { ...f.manager, user: { ...f.manager.user, role: 'root' } };
    await expect(f.scoped(1, () => f.service.devices(forged, { scope: 'all' }))).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_user SET role='manager',merchant_id=1 WHERE id=1");
    await f.db.execute("INSERT INTO ar_merchant_membership VALUES(1,1,'manager','active',1)");
    await expect(f.scoped(1, () => f.service.devices(f.root, { scope: 'all' }))).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a root principal after its authorization version changes', async () => {
    const f = fixture();
    await f.db.execute('UPDATE ar_user SET auth_version=2 WHERE id=1');
    await expect(f.scoped(1, () => f.service.devices(f.root, { scope: 'all' }))).rejects.toMatchObject({ status: 403 });
  });

  it.each(['unknown', '', ['all']])('rejects an invalid scope %j instead of silently expanding it', async scope => {
    const f = fixture();
    await expect(f.scoped(1, () => f.service.devices(f.root, { scope }))).rejects.toMatchObject({ status: 422 });
  });

  it.each([
    ['missing merchant', 'DELETE FROM ar_merchant WHERE id=2'],
    ['foreign venue', 'UPDATE ar_device SET venue_id=101 WHERE id=12'],
    ['foreign configuration', 'UPDATE ar_rental_config SET merchant_id=1 WHERE device_id=12'],
    ['foreign slot', "INSERT INTO ar_rental_order (id,device_id,merchant_id) VALUES(100,12,2); INSERT INTO ar_rental_slot VALUES(12,100,1,'RENTED')"],
    ['foreign rental', "INSERT INTO ar_rental_order (id,device_id,merchant_id) VALUES(100,12,1); INSERT INTO ar_rental_slot VALUES(12,100,2,'RENTED')"],
    ['missing rental', "INSERT INTO ar_rental_slot VALUES(12,100,2,'RENTED')"],
    ['another device rental', "INSERT INTO ar_rental_order (id,device_id,merchant_id) VALUES(100,11,2); INSERT INTO ar_rental_slot VALUES(12,100,2,'RENTED')"],
  ])('fails closed on a %s relationship in the global page', async (_label, corrupt) => {
    const f = fixture();
    f.db.sqlite.exec(corrupt);
    await expect(f.scoped(1, () => f.service.devices(f.root, { scope: 'all' }))).rejects.toMatchObject({ status: 503 });
  });

  it('reads a valid occupied device without disclosing its rental or mutating its slot', async () => {
    const f = fixture();
    f.db.sqlite.exec("INSERT INTO ar_rental_order (id,device_id,merchant_id) VALUES(100,12,2); INSERT INTO ar_rental_slot VALUES(12,100,2,'SETTLING')");
    const execute = vi.spyOn(f.db, 'execute');
    expect(await f.scoped(1, () => f.service.devices(f.root, { scope: 'all', search: 'global-2' })))
      .toMatchObject({ total: 1, items: [{ device: { id: 12, merchantName: '测试商户' }, state: 'SETTLING', actions: { canDelete: false } }] });
    expect(execute).not.toHaveBeenCalled();
    expect((await f.db.one('SELECT state FROM ar_rental_slot WHERE device_id=12'))!.state).toBe('SETTLING');
  });

  it('preserves the explicit pre-merchant adapter without requiring new account columns', async () => {
    const f = fixture();
    f.db.sqlite.exec('ALTER TABLE ar_user DROP COLUMN merchant_id; ALTER TABLE ar_user DROP COLUMN auth_version; DROP TABLE ar_merchant;');
    const legacyRoot = { ...f.root, user: { id: 1, role: 'root' } };
    expect(await f.service.devices(legacyRoot, { scope: 'all' })).toMatchObject({ total: 3 });
    const forged = { ...f.manager, user: { id: 2, role: 'root' } };
    await expect(f.service.devices(forged, { scope: 'all' })).rejects.toMatchObject({ status: 403 });
  });

  it('does not mistake a modern account without request context for the legacy adapter', async () => {
    const f = fixture();
    await expect(f.service.devices(f.root, { scope: 'all' })).rejects.toMatchObject({ status: 503 });
  });
});
