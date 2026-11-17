import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import request from '../http-client';
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
  const control = await mysql.createConnection(settings), name = 'ar_profile_' + randomBytes(10).toString('hex');
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`); created = true;
    db = new Database(mysql.createPool({ ...settings, database: name, connectionLimit: 8 }));
    await migrate(db); await run(await setup(db));
  } finally { await db?.close(); if (created) await control.query(`DROP DATABASE ${name}`); await control.end(); }
}
async function setup(db: Database) {
  const client = new WeChatClient({ appId, appSecret: 'synthetic-profile-secret', payEnabled: false, allowEnvironmentFallback: false,
    fetch: async () => { throw Error('Profile integration never contacts WeChat.'); } });
  client.codeSession = async code => ({ openid: 'synthetic-profile-' + code });
  const registry = new MerchantRegistry(db, client, new MerchantSecrets('d'.repeat(64)));
  const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-profile-signing-key-at-least-32-bytes', rootPhone: '' });
  const { app } = createApplication({ db, client, auth, merchants: registry });
  const http = (method: 'get' | 'post' | 'patch', path: string, token?: string) => {
    const req = request(app)[method](path).set('Host', host); if (token) req.set('Authorization', token); return req;
  };
  const login = async (code: string) => {
    const response = await http('post', '/api/v2/rental/auth/login').send({ code }); expect(response.status).toBe(200);
    return { ...response.body.data, bearer: 'Bearer ' + response.body.data.token.accessToken };
  };
  return { db, auth, http, login };
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('MySQL user profiles and avatar HTTP boundaries', () => {
  it('upgrades schema 15, preserves existing account information and journals the migration once', async () => withFixture(async f => {
    const actor = await f.login('migration');
    await f.db.execute('UPDATE ar_user SET nickname=? WHERE id=?', ['已有昵称', actor.user.id]);
    await f.db.execute('DROP TABLE ar_user_avatar');
    await f.db.execute('DELETE FROM ar_schema_migration WHERE version=16');
    await f.db.execute('UPDATE ar_schema_meta SET version=15');
    await migrate(f.db); const journal = await f.db.query('SELECT * FROM ar_schema_migration ORDER BY version'); await migrate(f.db);
    expect((await f.db.one('SELECT version FROM ar_schema_meta'))!.version).toBe(SCHEMA_VERSION);
    expect(await f.db.query('SELECT * FROM ar_schema_migration ORDER BY version')).toEqual(journal);
    expect((await f.login('migration')).user).toMatchObject({ id: actor.user.id, nickname: '已有昵称' });
    expect(await f.db.query('SELECT * FROM ar_user_avatar')).toHaveLength(0);
  }), 30_000);
  it('persists selected profile data, returns it on refresh and displays it in the authorized user directory', async () => withFixture(async f => {
    const owner = await f.login('owner'), other = await f.login('other'), root = await f.login('root');
    await f.db.execute("UPDATE ar_user SET role='root',merchant_id=NULL WHERE id=?", [root.user.id]);
    expect((await f.http('patch', '/api/v2/rental/profile').send({ nickname: '匿名' })).status).toBe(403);
    expect((await f.http('patch', '/api/v2/rental/profile').set('Origin', 'https://' + host).send({ nickname: '匿名' })).status).toBe(401);
    const saved = await f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname: '  微信名字 😀  ', avatarDataUrl: png });
    expect(saved.status).toBe(200); expect(saved.body.user).toMatchObject({ id: owner.user.id, nickname: '微信名字 😀', role: 'user', merchantId: null });
    const avatar = saved.body.user.avatar;
    expect(avatar).toMatch(/^\/api\/v2\/rental\/profile\/avatars\/[a-f0-9]{64}$/);
    const image = await f.http('get', avatar);
    expect(image.status).toBe(200); expect(image.type).toBe('image/png'); expect(image.body).toEqual(Buffer.from(png.split(',')[1], 'base64'));
    expect(image.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect(image.headers['content-security-policy']).toContain('sandbox');
    const refreshed = await f.http('post', '/api/v2/rental/auth/refresh').send({ refreshToken: owner.token.refreshToken });
    expect(refreshed.body.data.user).toMatchObject({ id: owner.user.id, nickname: '微信名字 😀', avatar });
    const directory = await f.http('get', '/api/v2/rental/admin/users?scope=platform&search=' + encodeURIComponent('微信名字'), root.bearer);
    expect(directory.status, JSON.stringify(directory.body)).toBe(200);
    expect(directory.body.items).toEqual([expect.objectContaining({ id: owner.user.id, nickname: '微信名字 😀', avatar })]);
    const employee = await f.login('employee');
    await f.db.insert('ar_merchant_membership', { user_id: employee.user.id, merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
    expect((await f.http('patch', '/api/v2/rental/profile', employee.bearer).send({ nickname: '微信员工' })).status).toBe(200);
    const employees = await f.http('get', '/api/v2/rental/admin/users?scope=employees&search=' + encodeURIComponent('微信员工'), root.bearer);
    expect(employees.status, JSON.stringify(employees.body)).toBe(200);
    expect(employees.body.items).toEqual([expect.objectContaining({ id: employee.user.id, nickname: '微信员工', role: 'manager' })]);
    expect((await f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname: '自定义昵称' })).body.user.avatar).toBe(avatar);
    for (const input of [{ id: other.user.id }, { role: 'root' }, { merchantId: 1 }, { avatarUrl: 'https://example.test/other.png' }]) expect((await f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname: '注入', ...input })).status).toBe(422);
    expect((await f.login('other')).user).toMatchObject({ id: other.user.id, nickname: null, avatar: null, role: 'user' });
    expect((await f.login('owner')).user).toMatchObject({ nickname: '自定义昵称', avatar, role: 'user' });
  }), 30_000);
  it('serializes simultaneous first avatar saves and rejects a stale identity between authentication and persistence', async () => withFixture(async f => {
    const owner = await f.login('concurrent');
    const saves = await Promise.all(['第一次', '第二次'].map(nickname => f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname, avatarDataUrl: png })));
    expect(saves.map(result => result.status)).toEqual([200, 200]);
    const current = (await f.db.one('SELECT nickname,avatar FROM ar_user WHERE id=?', [owner.user.id]))!;
    expect(saves.map(result => result.body.user)).toContainEqual(expect.objectContaining(current));
    expect(await f.db.query('SELECT user_id FROM ar_user_avatar')).toEqual([{ user_id: owner.user.id }]);
    for (const saved of saves) expect((await f.http('get', saved.body.user.avatar)).status).toBe(saved.body.user.avatar === current.avatar ? 200 : 404);
    const authenticate = f.auth.authenticate;
    const spy = vi.spyOn(f.auth, 'authenticate').mockImplementationOnce(async ctx => {
      const principal = await authenticate(ctx);
      await f.db.execute('UPDATE ar_user SET auth_version=auth_version+1 WHERE id=?', [owner.user.id]); return principal;
    });
    try {
      expect((await f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname: '过期写入', avatarDataUrl: png })).status).toBe(401);
      expect(await f.db.one('SELECT nickname,avatar FROM ar_user WHERE id=?', [owner.user.id])).toEqual(current);
    } finally { spy.mockRestore(); }
  }), 30_000);
  it('accepts larger profile JSON only on the dedicated patch route and rejects invalid images atomically', async () => withFixture(async f => {
    const owner = await f.login('validation');
    const oversized = 'data:image/png;base64,' + Buffer.alloc(256 * 1024 + 1).toString('base64');
    for (const avatarDataUrl of [oversized, png.replace('image/png', 'image/jpeg'), 'https://example.test/avatar.png']) expect((await f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname: '无效头像', avatarDataUrl })).status).toBe(422);
    expect((await f.http('patch', '/api/v2/rental/profile', owner.bearer).send({ nickname: '过大', avatarDataUrl: 'x'.repeat(400 * 1024) })).status).toBe(413);
    expect((await f.http('post', '/api/v2/rental/profile', owner.bearer).send({ nickname: 'x'.repeat(70000) })).status).toBe(413);
    expect((await f.http('post', '/api/v2/rental/auth/login').send({ code: 'x'.repeat(70000) })).status).toBe(413);
    expect((await f.db.one('SELECT nickname,avatar FROM ar_user WHERE id=?', [owner.user.id]))!).toMatchObject({ nickname: null, avatar: null });
    expect(await f.db.query('SELECT * FROM ar_user_avatar')).toHaveLength(0);
    expect((await f.http('get', '/api/v2/rental/profile/avatars/1')).status).toBe(404);
  }), 30_000);
});
