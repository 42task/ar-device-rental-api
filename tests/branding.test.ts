import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RentalPrincipal } from '../src/auth';
import type { Row } from '../src/core/contracts';
import type { Database } from '../src/core/database';
import { withMerchant, type MerchantRuntime } from '../src/merchants/context';
import { BrandingService, MAX_LOGO_BYTES, parseLogoDataUrl, registerBranding, validateLogoUrl } from '../src/merchants/branding';
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
  const service = new BrandingService(db as unknown as Database, () => 1800000000000);
  const input = { displayName: '品牌体验', version: 0 };
  return { db, service, first, second, scope, principal, input };
}

describe('merchant branding authority and public projection', () => {
  it('keeps the existing application display name for the unconfigured default merchant', async () => {
    const f = fixture();
    await f.db.execute("UPDATE ar_merchant SET code='default' WHERE id=1");
    const result = await f.scope(1, () => f.service.public(1));
    expect(result.branding.displayName).toBe(f.first.name);
    expect(result.branding).not.toHaveProperty('theme');
    expect(result.branding).not.toHaveProperty('heroImageUrl');
    expect((await f.scope(1, () => f.service.public(2))).branding.displayName).toBe('商户二');
  });
  it('provides safe defaults and keeps each merchant independent with optimistic versions', async () => {
    const f = fixture(), actor = await f.principal(2), root = await f.principal(1);
    expect(await f.scope(1, () => f.service.managed(actor))).toEqual({ merchant: { id: 1, name: '商户一', code: 'first' }, branding: { displayName: '商户一', logoUrl: '', version: 0, updatedAt: null } });
    const saved = await f.scope(1, () => f.service.save(actor, { ...f.input, logoUrl: 'https://cdn.example.test/first.png' }));
    expect(saved.branding).toMatchObject({ displayName: '品牌体验', logoUrl: 'https://cdn.example.test/first.png', version: 1 });
    await f.scope(2, () => f.service.save(root, { ...f.input, displayName: '第二个品牌' }));
    expect((await f.scope(1, () => f.service.public(1))).branding).toEqual(saved.branding);
    expect((await f.scope(1, () => f.service.public(2))).branding).toMatchObject({ displayName: '第二个品牌', version: 1 });
    await expect(f.scope(1, () => f.service.save(actor, { ...f.input, displayName: '过期修改' }))).rejects.toMatchObject({ status: 409 });
  });
  it('checks current roles, membership, tenant scope and authentication version rather than client claims', async () => {
    const f = fixture(), actor = await f.principal(2);
    for (const id of [3, 4, 5]) {
      const denied = await f.principal(id); denied.user.role = 'root';
      await expect(f.scope(1, () => f.service.managed(denied))).rejects.toMatchObject({ status: 403 });
      await expect(f.scope(1, () => f.service.save(denied, f.input))).rejects.toMatchObject({ status: 403 });
    }
    await expect(f.scope(2, () => f.service.save(actor, f.input))).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=2");
    await expect(f.scope(1, () => f.service.save(actor, f.input))).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_merchant_membership SET status='active' WHERE user_id=2");
    await f.db.execute('UPDATE ar_user SET auth_version=1 WHERE id=2');
    await expect(f.scope(1, () => f.service.save(actor, f.input))).rejects.toMatchObject({ status: 401 });
    expect(await f.db.query('SELECT * FROM ar_merchant_branding')).toHaveLength(0);
  });
  it('rejects ownership injection, invalid themes, names, versions and unsafe URL schemes', async () => {
    const f = fixture(), actor = await f.principal(2);
    for (const input of [{ merchantId: 2 }, { merchant_id: null }, { theme: 'aero' }, { heroImageUrl: '' }, { heroDataUrl: png }, { displayName: '' }, { displayName: 'x'.repeat(33) }, { displayName: 'bad\u0000name' }, { version: -1 }, { version: '0' }, { logoUrl: 'javascript:alert(1)' }, { logoUrl: 'data:image/svg+xml,<svg/>' }, { logoUrl: 'https://user:secret@example.test/image.png' }]) {
      await expect(f.scope(1, () => f.service.save(actor, { ...f.input, ...input }))).rejects.toMatchObject({ status: 422 });
    }
    expect(await f.db.query('SELECT * FROM ar_merchant_branding')).toHaveLength(0);
  });
  it('serves only own-application active brands and logos without disclosing configuration metadata', async () => {
    const f = fixture(), actor = await f.principal(2);
    const saved = await f.scope(1, () => f.service.save(actor, { ...f.input, logoDataUrl: png }));
    expect(saved.branding.logoUrl).toBe('https://d.example.test/api/v2/rental/branding/1/logo?v=1');
    expect(JSON.stringify(saved)).not.toContain('updated_by'); expect(JSON.stringify(saved)).not.toContain('logo_data');
    const logo = await f.scope(1, () => f.service.logo(1));
    expect(logo.mime).toBe('image/png'); expect(logo.data).toEqual(parseLogoDataUrl(png).data);
    for (const id of [3, 99]) await expect(f.scope(1, () => f.service.public(id))).rejects.toMatchObject({ status: 404 });
    await f.db.execute("UPDATE ar_merchant SET status='paused' WHERE id=1");
    await expect(f.scope(1, () => f.service.public(1))).rejects.toMatchObject({ status: 404 });
    await expect(f.scope(1, () => f.service.logo(1))).rejects.toMatchObject({ status: 404 });
    expect((await f.scope(1, () => f.service.managed(actor))).branding.logoUrl).toBe(saved.branding.logoUrl);
  });
  it('preserves an uploaded logo during name edits and removes its bytes when cleared', async () => {
    const f = fixture(), actor = await f.principal(2);
    await f.scope(1, () => f.service.save(actor, { ...f.input, logoDataUrl: png }));
    expect((await f.scope(1, () => f.service.save(actor, { ...f.input, version: 1, displayName: '新名称' }))).branding.logoUrl).toContain('?v=2');
    expect((await f.scope(1, () => f.service.logo(1))).data).toEqual(parseLogoDataUrl(png).data);
    expect((await f.scope(1, () => f.service.save(actor, { ...f.input, version: 2, logoUrl: '' }))).branding.logoUrl).toBe('');
    await expect(f.scope(1, () => f.service.logo(1))).rejects.toMatchObject({ status: 404 });
    expect(await f.db.one('SELECT logo_data,logo_mime FROM ar_merchant_branding')).toMatchObject({ logo_data: null, logo_mime: null });
  });
  it('requires explicit root scope even for configuration reads', async () => {
    const f = fixture(), root = await f.principal(1), router = new ApiRouter();
    registerBranding(router, f.db as unknown as Database, { authenticate: async () => root } as any);
    for (const method of ['GET', 'PATCH']) {
      const route = router.routes.find(route => route.method === method && route.path.endsWith('/admin/branding'))!;
      const ctx = { body: f.input, query: {}, params: {}, req: { headers: {} }, res: {} } as any;
      await expect(f.scope(1, () => route.handler(ctx))).rejects.toMatchObject({ status: 422 });
      ctx.req.headers['x-merchant-id'] = '1';
      expect(await f.scope(1, () => route.handler(ctx))).toHaveProperty('branding');
    }
  });
  it('uses the selected merchant origin when root configures a different application entry', async () => {
    const f = fixture(), root = await f.principal(1);
    const selected = { ...f.second, id: 3, origin: 'https://other.example.test', appId: 'wx2222222222222222' };
    const result = await withMerchant({ entry: f.first, merchant: selected }, () => f.service.save(root, { ...f.input, logoDataUrl: png }));
    expect(result.branding.logoUrl).toBe('https://other.example.test/api/v2/rental/branding/3/logo?v=1');
    await expect(f.scope(1, () => f.service.public(3))).rejects.toMatchObject({ status: 404 });
  });
});

describe('logo input validation', () => {
  it('accepts PNG data and HTTPS URLs while rejecting SVG, spoofed MIME, malformed base64 and oversized images', () => {
    expect(parseLogoDataUrl(png).mime).toBe('image/png');
    expect(validateLogoUrl('https://cdn.example.test/logo.png?revision=2')).toBe('https://cdn.example.test/logo.png?revision=2');
    for (const value of ['data:image/svg+xml;base64,PHN2Zy8+', png.replace('image/png', 'image/jpeg'), png.slice(0, -1), 'data:image/png;base64,' + Buffer.alloc(MAX_LOGO_BYTES + 1).toString('base64'), null]) expect(() => parseLogoDataUrl(value)).toThrow();
    expect(() => validateLogoUrl('https://example.test/image.png\n')).toThrow();
  });
});
