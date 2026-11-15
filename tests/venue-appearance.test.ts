import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RentalPrincipal } from '../src/auth';
import type { Row } from '../src/core/contracts';
import type { Database } from '../src/core/database';
import { withMerchant, type MerchantRuntime } from '../src/merchants/context';
import { VenueAppearanceService, registerVenueAppearance } from '../src/venues/appearance';
import { MAX_HERO_BYTES, parseHeroDataUrl } from '../src/core/images';
import { ApiRouter } from '../src/core/router';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aDHsAAAAASUVORK5CYII=';
const opened: DatabaseSync[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY,role TEXT,merchant_id INTEGER,auth_version INTEGER DEFAULT 0);
    INSERT INTO ar_user VALUES(1,'root',NULL,0),(2,'adminer',1,0),(3,'manager',1,0),(4,'user',NULL,0),(5,'adminer',2,0);
    CREATE TABLE ar_merchant_membership(user_id INTEGER PRIMARY KEY,merchant_id INTEGER,role TEXT,status TEXT,authorization_version INTEGER);
    INSERT INTO ar_merchant_membership VALUES(2,1,'adminer','active',1),(3,1,'manager','active',1),(5,2,'adminer','active',1);
    CREATE TABLE ar_merchant(id INTEGER PRIMARY KEY,name TEXT,code TEXT,status TEXT);
    INSERT INTO ar_merchant VALUES(1,'商户一','first','active'),(2,'商户二','second','active'),(3,'独立入口商户','third','active');
    CREATE TABLE ar_application_merchant(merchant_id INTEGER PRIMARY KEY,application_id INTEGER);
    INSERT INTO ar_application_merchant VALUES(1,1),(2,1),(3,3);
    CREATE TABLE ar_merchant_branding(merchant_id INTEGER PRIMARY KEY,display_name TEXT,theme TEXT,logo_url TEXT,logo_data BLOB,logo_mime TEXT,version INTEGER,updated_ms INTEGER,updated_by INTEGER);
    CREATE TABLE ar_venue(id INTEGER PRIMARY KEY,merchant_id INTEGER,name TEXT,status TEXT);
    INSERT INTO ar_venue VALUES(10,1,'景点一','active'),(11,1,'景点二','active'),(20,2,'第二商户景点','active'),(30,3,'独立入口景点','active');
    CREATE TABLE ar_venue_appearance(venue_id INTEGER PRIMARY KEY,merchant_id INTEGER,theme TEXT,image_url TEXT,image_data BLOB,image_mime TEXT,version INTEGER,updated_ms INTEGER,updated_by INTEGER);
`);
  const clean = (sql: string) => sql.replace(/ FOR UPDATE/g, '');
  const db = {
    async query(sql: string, params: any[] = []) { return sqlite.prepare(clean(sql)).all(...params) as Row[]; },
    async one(sql: string, params: any[] = []) { return (await this.query(sql, params))[0] ?? null; },
    async execute(sql: string, params: any[] = []) { const result = sqlite.prepare(clean(sql)).run(...params); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async transaction<T>(operation: (db: any) => Promise<T>) { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const runtime = (id: number): MerchantRuntime => ({ id, code: 'merchant' + id, name: '商户' + id, appId: 'wx03dbf50c15cac06f', origin: 'https://d.example.test', status: 'active', configId: id, client: {} as any });
  const first = runtime(1), second = runtime(2);
  const scope = <T>(id: number, run: () => T) => withMerchant({ entry: first, merchant: id === 1 ? first : second }, run);
  const principal = async (id: number): Promise<RentalPrincipal> => ({ user: (await db.one('SELECT * FROM ar_user WHERE id=?', [id]))!, appid: first.appId, openid: 'synthetic-' + id, authVersion: 0 });
  const service = new VenueAppearanceService(db as unknown as Database, () => 1800000000000);
  const input = { theme: 'forest', version: 0 };
  return { db, service, first, second, scope, principal, input };
}

describe('venue appearance scope and image choices', () => {
  it('defaults to current Aero imagery and keeps same-merchant venues independent from the merchant brand', async () => {
    const f = fixture(), actor = await f.principal(2);
    expect(await f.scope(1, () => f.service.managed(actor, 10))).toEqual({ venue: { id: 10, merchantId: 1, name: '景点一' }, appearance: { theme: 'aero', heroImageUrl: '', version: 0, updatedAt: null } });
    const first = await f.scope(1, () => f.service.save(actor, 10, { ...f.input, heroImageUrl: 'https://cdn.example.test/venue.png' }));
    await f.scope(1, () => f.service.save(actor, 11, { ...f.input, theme: 'ink' }));
    expect(first.appearance).toMatchObject({ theme: 'forest', heroImageUrl: 'https://cdn.example.test/venue.png', version: 1 });
    expect((await f.scope(1, () => f.service.managed(actor, 11))).appearance).toMatchObject({ theme: 'ink', heroImageUrl: '', version: 1 });
    expect((await f.scope(1, () => f.service.public(10))).appearance).toEqual(first.appearance);
    expect(await f.db.query('SELECT * FROM ar_merchant_branding')).toHaveLength(0);
    await expect(f.scope(1, () => f.service.save(actor, 10, f.input))).rejects.toMatchObject({ status: 409 });
  });
  it('rechecks current roles, membership, scope and authorization versions inside transactions', async () => {
    const f = fixture(), actor = await f.principal(2);
    for (const id of [3, 4, 5]) {
      const denied = await f.principal(id); denied.user.role = 'root';
      await expect(f.scope(1, () => f.service.managed(denied, 10))).rejects.toMatchObject({ status: 403 });
      await expect(f.scope(1, () => f.service.save(denied, 10, f.input))).rejects.toMatchObject({ status: 403 });
    }
    await expect(f.scope(1, () => f.service.save(actor, 20, f.input))).rejects.toMatchObject({ status: 404 });
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=2");
    await expect(f.scope(1, () => f.service.save(actor, 10, f.input))).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_merchant_membership SET status='active' WHERE user_id=2");
    await f.db.execute('UPDATE ar_user SET auth_version=1 WHERE id=2');
    await expect(f.scope(1, () => f.service.save(actor, 10, f.input))).rejects.toMatchObject({ status: 401 });
    expect(await f.db.query('SELECT * FROM ar_venue_appearance')).toHaveLength(0);
  });
  it('rejects ownership assertions, bad themes, unsafe URLs and invalid or conflicting image uploads atomically', async () => {
    const f = fixture(), actor = await f.principal(2);
    for (const invalid of [{ merchantId: 2 }, { merchant_id: null }, { venueId: 11 }, { displayName: '错误归属' }, { logoUrl: '' }, { logoDataUrl: png }, { theme: 'unknown' }, { theme: {} }, { version: -1 }, { version: '0' }, { heroImageUrl: 'javascript:alert(1)' }, { heroImageUrl: null }, { heroImageUrl: '', heroDataUrl: png }, { heroDataUrl: png.replace('image/png', 'image/jpeg') }, { heroDataUrl: 'data:image/png;base64,' + Buffer.alloc(MAX_HERO_BYTES + 1).toString('base64') }]) {
      await expect(f.scope(1, () => f.service.save(actor, 10, { ...f.input, ...invalid }))).rejects.toMatchObject({ status: 422 });
    }
    expect(await f.db.query('SELECT * FROM ar_venue_appearance')).toHaveLength(0);
  });
  it('keeps an uploaded hero through theme edits and restores the default when cleared', async () => {
    const f = fixture(), actor = await f.principal(2);
    const saved = await f.scope(1, () => f.service.save(actor, 10, { ...f.input, heroDataUrl: png }));
    expect(saved.appearance.heroImageUrl).toBe('https://d.example.test/api/v2/rental/venues/10/appearance/hero?v=1');
    expect((await f.scope(1, () => f.service.hero(10))).data).toEqual(parseHeroDataUrl(png).data);
    const edited = await f.scope(1, () => f.service.save(actor, 10, { theme: 'sunset', version: 1 }));
    expect(edited.appearance.heroImageUrl).toContain('?v=2');
    expect((await f.scope(1, () => f.service.hero(10))).mime).toBe('image/png');
    const cleared = await f.scope(1, () => f.service.save(actor, 10, { theme: 'sunset', version: 2, heroImageUrl: '' }));
    expect(cleared.appearance.heroImageUrl).toBe('');
    await expect(f.scope(1, () => f.service.hero(10))).rejects.toMatchObject({ status: 404 });
  });
  it('serves only active venues and merchants in the current application entry', async () => {
    const f = fixture(), actor = await f.principal(2);
    await f.scope(1, () => f.service.save(actor, 10, { ...f.input, heroDataUrl: png }));
    await expect(f.scope(1, () => f.service.public(30))).rejects.toMatchObject({ status: 404 });
    await expect(f.scope(1, () => f.service.hero(30))).rejects.toMatchObject({ status: 404 });
    await f.db.execute("UPDATE ar_venue SET status='paused' WHERE id=10");
    await expect(f.scope(1, () => f.service.public(10))).rejects.toMatchObject({ status: 404 });
    await expect(f.scope(1, () => f.service.hero(10))).rejects.toMatchObject({ status: 404 });
    expect((await f.scope(1, () => f.service.managed(actor, 10))).appearance.version).toBe(1);
    await f.db.execute("UPDATE ar_venue SET status='active' WHERE id=10");
    await f.db.execute("UPDATE ar_merchant SET status='paused' WHERE id=1");
    await expect(f.scope(1, () => f.service.public(10))).rejects.toMatchObject({ status: 404 });
  });
  it('uses the selected merchant origin for root editing a different application and enforces explicit root scope', async () => {
    const f = fixture(), root = await f.principal(1);
    const selected = { ...f.second, id: 3, origin: 'https://other.example.test', appId: 'wx2222222222222222' };
    const saved = await withMerchant({ entry: f.first, merchant: selected }, () => f.service.save(root, 30, { ...f.input, heroDataUrl: png }));
    expect(saved.appearance.heroImageUrl).toBe('https://other.example.test/api/v2/rental/venues/30/appearance/hero?v=1');
    const router = new ApiRouter(); registerVenueAppearance(router, f.db as unknown as Database, { authenticate: async () => root } as any);
    for (const method of ['GET', 'PATCH']) {
      const route = router.routes.find(route => route.method === method && route.path.startsWith('/v2/rental/admin/'))!;
      const ctx = { body: f.input, query: {}, params: { id: '10' }, req: { headers: {} }, res: {} } as any;
      await expect(f.scope(1, () => route.handler(ctx))).rejects.toMatchObject({ status: 422 });
      ctx.req.headers['x-merchant-id'] = '1';
      expect(await f.scope(1, () => route.handler(ctx))).toHaveProperty('appearance');
    }
  });
});
