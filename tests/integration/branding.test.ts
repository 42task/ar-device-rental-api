import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import request from '../http-client';
import rawRequest from 'supertest';
import { createApplication } from '../../src/application';
import { RentalAuth } from '../../src/auth';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
import { WeChatClient } from '../../src/payments/wechat';

const appId = 'wx03dbf50c15cac06f', host = 'd.4mr.cn';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aDHsAAAAASUVORK5CYII=';

async function withFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated loopback AR rental test MySQL instance.');
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings), database = 'ar_branding_' + randomBytes(10).toString('hex');
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
    db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
    await migrate(db);
    await run(await setup(db));
  } finally {
    await db?.close(); if (created) await control.query(`DROP DATABASE ${database}`); await control.end();
  }
}
async function setup(db: Database) {
  const client = new WeChatClient({ appId, appSecret: 'synthetic-branding-secret', payEnabled: false, allowEnvironmentFallback: false,
    fetch: async () => { throw Error('Branding integration never contacts WeChat.'); } });
  client.codeSession = async code => ({ openid: 'synthetic-branding-' + code });
  const registry = new MerchantRegistry(db, client, new MerchantSecrets('c'.repeat(64)));
  const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-branding-http-signing-key-at-least-32-bytes', rootPhone: '' });
  const { app } = createApplication({ db, client, auth, merchants: registry });
  const http = (method: 'get' | 'post' | 'patch', path: string, bearer?: string, merchantId?: number) => {
    const req = request(app)[method](path).set('Host', host);
    if (bearer) req.set('Authorization', bearer); if (merchantId !== undefined) req.set('X-Merchant-Id', String(merchantId)); return req;
  };
  const login = async (code: string) => {
    const response = await http('post', '/api/v2/rental/auth/login').send({ code });
    expect(response.status).toBe(200); return response.body.data;
  };
  const staff = async (code: string, role: string, merchantId: number | null = 1) => {
    const row = await db.insert('ar_user', { appid: appId, openid: 'synthetic-branding-' + code, role, merchant_id: merchantId });
    if (['manager', 'adminer'].includes(role)) await db.insert('ar_merchant_membership', { user_id: row.id, merchant_id: merchantId, role, status: 'active', authorization_version: 1, updated_ms: Date.now() });
    const identity = await login(code); return { id: row.id, token: 'Bearer ' + identity.token.accessToken };
  };
  const root = await staff('root', 'root', null);
  const merchant = async (code: string, separate = false) => {
    const result = await http('post', '/api/v2/rental/admin/merchants', root.token).send({ code, name: 'Synthetic ' + code,
      status: 'active', payEnabled: false, ...(separate ? { miniappOwnerId: null, origin: 'https://branding-other.example.test', appId: 'wx2222222222222222' } : {}) });
    expect(result.status).toBe(200); return result.body.merchant;
  };
  return { db, app, http, staff, root, merchant };
}
const input = { displayName: '合成品牌', version: 0 };

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('MySQL merchant branding and logo HTTP boundaries', () => {
  it('upgrades schema 13 without overwriting merchants and journals branding migrations idempotently', async () => withFixture(async f => {
    const before = await f.db.query('SELECT * FROM ar_merchant ORDER BY id');
    await f.db.execute('DROP TABLE ar_venue_appearance');
    await f.db.execute('DROP TABLE ar_merchant_branding');
    await f.db.execute('DELETE FROM ar_schema_migration WHERE version>=14');
    await f.db.execute('UPDATE ar_schema_meta SET version=13');
    await migrate(f.db); await migrate(f.db);
    expect(await f.db.query('SELECT * FROM ar_merchant ORDER BY id')).toEqual(before);
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(SCHEMA_VERSION);
    expect(await f.db.query('SELECT version FROM ar_schema_migration ORDER BY version')).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].map(version => ({ version })));
    expect((await f.http('get', '/api/v2/rental/branding/1')).body.branding).toMatchObject({ version: 0, logoUrl: '' });
  }), 30_000);
  it('enforces own-merchant adminer access, current membership and deliberate root scope', async () => withFixture(async f => {
    const own = await f.staff('adminer', 'adminer'), manager = await f.staff('manager', 'manager'), customer = await f.staff('customer', 'user', null);
    const child = await f.merchant('branding_child'), foreign = await f.staff('foreign', 'adminer', child.id);
    for (const actor of [manager, customer]) {
      expect((await f.http('get', '/api/v2/rental/admin/branding', actor.token, 1)).status).toBe(403);
      expect((await f.http('patch', '/api/v2/rental/admin/branding', actor.token, 1).send({ ...input, role: 'root' })).status).toBe(403);
    }
    for (const method of ['get', 'patch'] as const) expect((await f.http(method, '/api/v2/rental/admin/branding', f.root.token).send(method === 'patch' ? input : undefined)).status).toBe(422);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, child.id).send(input)).status).toBe(403);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, merchantId: child.id })).status).toBe(422);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send(input)).status).toBe(200);
    const first = await f.http('get', '/api/v2/rental/admin/branding', foreign.token, child.id);
    expect(first.status).toBe(200); expect(first.body.branding.version).toBe(0);
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=?", [own.id]);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, version: 1 })).status).toBe(403);
    await f.db.execute("UPDATE ar_merchant_membership SET status='active' WHERE user_id=?", [own.id]);
    await f.db.execute('UPDATE ar_user SET auth_version=auth_version+1 WHERE id=?', [own.id]);
    expect((await f.http('get', '/api/v2/rental/admin/branding', own.token, 1)).status).toBe(401);
    expect(await f.db.query('SELECT merchant_id,version FROM ar_merchant_branding')).toEqual([{ merchant_id: 1, version: 1 }]);
  }), 30_000);
  it('serializes competing first saves and serves versioned binary logos only through their public application', async () => withFixture(async f => {
    const own = await f.staff('first-adminer', 'adminer');
    const saves = await Promise.all([input, { ...input, displayName: '另一次修改' }].map(body => f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...body, logoDataUrl: png })));
    expect(saves.map(result => result.status).sort()).toEqual([200, 409]);
    const saved = saves.find(result => result.status === 200)!.body;
    expect(saved.branding.logoUrl).toBe('https://d.4mr.cn/api/v2/rental/branding/1/logo?v=1');
    const publicBrand = await f.http('get', '/api/v2/rental/branding/1');
    expect(publicBrand.status).toBe(200); expect(publicBrand.body).toEqual(saved); expect(publicBrand.headers['cache-control']).toBe('no-store');
    const logo = await f.http('get', '/api/v2/rental/branding/1/logo?v=1');
    expect(logo.status).toBe(200); expect(logo.type).toBe('image/png'); expect(logo.body).toEqual(Buffer.from(png.split(',')[1], 'base64'));
    expect(logo.headers['x-content-type-options']).toBe('nosniff');
    const separate = await f.merchant('branding_separate', true);
    expect((await f.http('get', '/api/v2/rental/branding/' + separate.id)).status).toBe(404);
    expect((await f.http('get', '/api/v2/rental/branding/' + separate.id + '/logo')).status).toBe(404);
    await f.db.execute("UPDATE ar_merchant SET status='paused' WHERE id=1");
    expect((await f.http('get', '/api/v2/rental/branding/1')).status).toBe(404);
    expect((await f.http('get', '/api/v2/rental/branding/1/logo')).status).toBe(404);
  }), 30_000);
  it('limits expanded JSON parsing to branding, preserves protocol checks and rejects invalid images before persistence', async () => withFixture(async f => {
    const own = await f.staff('upload-adminer', 'adminer');
    const large = 'data:image/png;base64,' + Buffer.alloc(256 * 1024 + 1).toString('base64');
    const tooLargeImage = await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, logoDataUrl: large });
    expect(tooLargeImage.status).toBe(422);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, logoDataUrl: png.replace('image/png', 'image/jpeg') })).status).toBe(422);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, logoDataUrl: 'x'.repeat(400 * 1024) })).status).toBe(413);
    expect((await f.http('post', '/api/v2/rental/auth/login').send({ code: 'x'.repeat(70000) })).status).toBe(413);
    const old = await rawRequest(f.app).patch('/api/v2/rental/admin/branding').set('Host', host).set('Authorization', own.token).set('X-Merchant-Id', '1').send(input);
    expect(old.status).toBe(426);
    expect(await f.db.query('SELECT * FROM ar_merchant_branding')).toHaveLength(0);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, logoDataUrl: png })).status).toBe(200);
    const cleared = await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ ...input, version: 1, logoUrl: '' });
    expect(cleared.status).toBe(200); expect(cleared.body.branding.logoUrl).toBe('');
    expect((await f.http('get', '/api/v2/rental/branding/1/logo')).status).toBe(404);
  }), 30_000);
});
