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
import { seedVenue } from './venue-fixtures';

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
describe.skipIf(process.env.RUN_INTEGRATION !== '1')('MySQL independent venue appearance and image boundaries', () => {
  it('keeps styles and main images per venue while enforcing both directions of the brand/appearance boundary', async () => withFixture(async f => {
    const own = await f.staff('appearance-adminer', 'adminer'), manager = await f.staff('appearance-manager', 'manager');
    const first = await seedVenue(f.db), second = await seedVenue(f.db), child = await f.merchant('appearance_child'), foreign = await seedVenue(f.db, child.id);
    const path = (id: number) => `/api/v2/rental/admin/venues/${id}/appearance`;
    const defaults = await f.http('get', path(first.id), own.token, 1);
    expect(defaults.status).toBe(200); expect(defaults.body.appearance).toEqual({ theme: 'aero', heroImageUrl: '', version: 0, updatedAt: null });
    for (const method of ['get', 'patch'] as const) expect((await f.http(method, path(first.id), f.root.token).send(method === 'patch' ? { theme: 'ink', version: 0 } : undefined)).status).toBe(422);
    expect((await f.http('get', path(first.id), manager.token, 1)).status).toBe(403);
    expect((await f.http('patch', path(first.id), manager.token, 1).send({ theme: 'ink', version: 0 })).status).toBe(403);
    expect((await f.http('patch', path(foreign.id), own.token, 1).send({ theme: 'ink', version: 0 })).status).toBe(404);
    expect((await f.http('patch', path(foreign.id), own.token, child.id).send({ theme: 'ink', version: 0 })).status).toBe(403);
    for (const fields of [{ theme: 'forest' }, { heroImageUrl: '' }, { heroDataUrl: png }]) expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ displayName: 'Synthetic brand', version: 0, ...fields })).status).toBe(422);
    for (const fields of [{ displayName: 'Wrong scope' }, { logoUrl: '' }, { logoDataUrl: png }]) expect((await f.http('patch', path(first.id), own.token, 1).send({ theme: 'forest', version: 0, ...fields })).status).toBe(422);
    const firstSaved = await f.http('patch', path(first.id), own.token, 1).send({ theme: 'forest', version: 0, heroDataUrl: png });
    expect(firstSaved.status).toBe(200); expect(firstSaved.body.appearance).toMatchObject({ theme: 'forest', version: 1 });
    const secondSaved = await f.http('patch', path(second.id), own.token, 1).send({ theme: 'ink', version: 0, heroImageUrl: 'https://cdn.example.test/second.png' });
    expect(secondSaved.status).toBe(200); expect(secondSaved.body.appearance).toMatchObject({ theme: 'ink', heroImageUrl: 'https://cdn.example.test/second.png', version: 1 });
    expect((await f.http('get', `/api/v2/rental/venues/${first.id}/appearance`)).body).toEqual(firstSaved.body);
    expect(await f.db.query('SELECT * FROM ar_merchant_branding')).toHaveLength(0);
    await f.db.execute("UPDATE ar_merchant_membership SET status='revoked' WHERE user_id=?", [own.id]);
    expect((await f.http('patch', path(first.id), own.token, 1).send({ theme: 'sunset', version: 1 })).status).toBe(403);
    await f.db.execute("UPDATE ar_merchant_membership SET status='active' WHERE user_id=?", [own.id]);
    await f.db.execute('UPDATE ar_user SET auth_version=auth_version+1 WHERE id=?', [own.id]);
    expect((await f.http('get', path(first.id), own.token, 1)).status).toBe(401);
  }), 30_000);
  it('serializes first-save races and exposes images only for active venues in the same application', async () => withFixture(async f => {
    const own = await f.staff('appearance-first', 'adminer'), other = await f.staff('appearance-second', 'adminer');
    const venue = await seedVenue(f.db), path = `/api/v2/rental/admin/venues/${venue.id}/appearance`;
    const writes = await Promise.all([own, other].map(actor => f.http('patch', path, actor.token, 1).send({ theme: 'forest', version: 0, heroDataUrl: png })));
    expect(writes.map(row => row.status).sort()).toEqual([200, 409]);
    const saved = writes.find(row => row.status === 200)!.body;
    expect(saved.appearance.heroImageUrl).toBe(`https://d.4mr.cn/api/v2/rental/venues/${venue.id}/appearance/hero?v=1`);
    const image = await f.http('get', `/api/v2/rental/venues/${venue.id}/appearance/hero?v=1`);
    expect(image.status).toBe(200); expect(image.type).toBe('image/png'); expect(image.body).toEqual(Buffer.from(png.split(',')[1], 'base64')); expect(image.headers['cache-control']).toBe('no-store'); expect(image.headers['x-content-type-options']).toBe('nosniff');
    const separate = await f.merchant('appearance_separate', true), outside = await seedVenue(f.db, separate.id);
    const outsideSaved = await f.http('patch', `/api/v2/rental/admin/venues/${outside.id}/appearance`, f.root.token, separate.id).send({ theme: 'ink', version: 0, heroDataUrl: png });
    expect(outsideSaved.status).toBe(200); expect(outsideSaved.body.appearance.heroImageUrl).toContain('https://branding-other.example.test/api/v2/rental/venues/');
    for (const suffix of ['', '/hero']) expect((await f.http('get', `/api/v2/rental/venues/${outside.id}/appearance${suffix}`)).status).toBe(404);
    await f.db.execute("UPDATE ar_venue SET status='paused' WHERE id=?", [venue.id]);
    for (const suffix of ['', '/hero']) expect((await f.http('get', `/api/v2/rental/venues/${venue.id}/appearance${suffix}`)).status).toBe(404);
    await f.db.execute("UPDATE ar_venue SET status='active' WHERE id=?", [venue.id]);
    await f.db.execute("UPDATE ar_merchant SET status='paused' WHERE id=1");
    expect((await f.http('get', `/api/v2/rental/venues/${venue.id}/appearance`)).status).toBe(404);
  }), 30_000);
  it('uses a 768KB appearance parser while enforcing image and protocol checks before persistence', async () => withFixture(async f => {
    const own = await f.staff('appearance-upload', 'adminer'), venue = await seedVenue(f.db), path = `/api/v2/rental/admin/venues/${venue.id}/appearance`;
    const tooLargeImage = 'data:image/png;base64,' + Buffer.alloc(512 * 1024 + 1).toString('base64');
    expect((await f.http('patch', path, own.token, 1).send({ theme: 'forest', version: 0, heroDataUrl: tooLargeImage })).status).toBe(422);
    expect((await f.http('patch', path, own.token, 1).send({ theme: 'forest', version: 0, heroDataUrl: 'x'.repeat(800 * 1024) })).status).toBe(413);
    expect((await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ displayName: 'Synthetic brand', version: 0, logoDataUrl: 'x'.repeat(400 * 1024) })).status).toBe(413);
    expect((await f.http('patch', path, own.token, 1).send({ theme: 'forest', version: 0, heroDataUrl: png.replace('image/png', 'image/jpeg') })).status).toBe(422);
    expect((await f.http('patch', path, own.token, 1).send({ theme: 'forest', version: 0, heroImageUrl: 'data:image/svg+xml,<svg/>' })).status).toBe(422);
    const old = await rawRequest(f.app).patch(path).set('Host', host).set('Authorization', own.token).set('X-Merchant-Id', '1').send({ theme: 'forest', version: 0 });
    expect(old.status).toBe(426); expect(await f.db.query('SELECT * FROM ar_venue_appearance')).toHaveLength(0);
    const saved = await f.http('patch', path, own.token, 1).send({ theme: 'forest', version: 0, heroDataUrl: png });
    expect(saved.status).toBe(200);
    const invalidEdit = await f.http('patch', path, own.token, 1).send({ theme: 'ink', version: 1, heroImageUrl: 'http://unsafe.example.test/image.png' });
    expect(invalidEdit.status).toBe(422); expect((await f.http('get', path, own.token, 1)).body).toEqual(saved.body);
    const cleared = await f.http('patch', path, own.token, 1).send({ theme: 'sunset', version: 1, heroImageUrl: '' });
    expect(cleared.status).toBe(200); expect(cleared.body.appearance).toMatchObject({ heroImageUrl: '', version: 2 });
    expect((await f.http('get', `/api/v2/rental/venues/${venue.id}/appearance/hero`)).status).toBe(404);
  }), 30_000);
  it('upgrades from schema14 while preserving a configured merchant logo and its independent version', async () => withFixture(async f => {
    const own = await f.staff('appearance-migration', 'adminer');
    const saved = await f.http('patch', '/api/v2/rental/admin/branding', own.token, 1).send({ displayName: 'Synthetic brand', version: 0, logoDataUrl: png });
    expect(saved.status).toBe(200);
    const before = await f.db.query('SELECT * FROM ar_merchant_branding');
    await f.db.execute('DROP TABLE ar_venue_appearance'); await f.db.execute('DELETE FROM ar_schema_migration WHERE version=15'); await f.db.execute('UPDATE ar_schema_meta SET version=14');
    await migrate(f.db); await migrate(f.db);
    expect(await f.db.query('SELECT * FROM ar_merchant_branding')).toEqual(before);
    expect(await f.db.query('SELECT * FROM ar_venue_appearance')).toHaveLength(0);
    expect((await f.http('get', '/api/v2/rental/admin/branding', own.token, 1)).body).toEqual(saved.body);
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(15);
  }), 30_000);
});
