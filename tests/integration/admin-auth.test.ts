import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { AdminAuth } from '../../src/admin/auth';
import { RentalAuth } from '../../src/auth';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import { ApiRouter } from '../../src/core/router';
import type { Row } from '../../src/core/contracts';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL admin challenge concurrency', () => {
  it('shares images across nodes and consumes exactly once under concurrent browsers', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const database = 'ar_admin_test_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
      await migrate(db); await migrate(db);
      expect(Number((await db.one('SELECT version FROM ar_schema_meta'))!.version)).toBe(SCHEMA_VERSION);
      const appId = 'wx03dbf50c15cac06f', origin = 'https://admin.integration.test';
      for (const [id, role] of [[1, 'manager'], [2, 'user'], [3, 'root'], [4, 'admin'], [5, 'admin']] as const) await db.insert('ar_user', { id, role, appid: appId, openid: 'synthetic-admin-' + id });
      for (const [id, phone] of [[1, '+8613800138000'], [3, '+8613900139000'], [4, '+8613600136000'], [5, '+8613500135000']] as const) await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [id, appId, phone, '86', Date.now(), String(id).repeat(64)]);
      let providerCalls = 0;
      const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      const client = { config: { appId }, codeSession: async (code: string) => ({ openid: 'synthetic-admin-' + code }), unlimitedCode: async () => { providerCalls++; return image; } };
      const context = (input: { id?: string; cookie?: string; token?: string; body?: Row; method?: string } = {}) => ({
        req: { method: input.method || 'POST', protocol: 'https', socket: { remoteAddress: '127.0.0.1' }, headers: { origin, host: 'admin.integration.test', ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.token ? { authorization: 'Bearer ' + input.token } : {}) } },
        res: { setHeader: vi.fn(), append: vi.fn(), type: vi.fn().mockReturnThis(), end: vi.fn() }, params: { id: input.id }, body: input.body || {}, query: {},
      } as any);
      const nodes = [0, 1].map(() => {
        const auth = new RentalAuth(db!, client as any, { jwtSecret: 'synthetic-admin-integration-signing-key-32-bytes' });
        const admin = new AdminAuth(db!, client as any, auth, { publicOrigin: origin }); auth.webAuthenticate = admin.authenticate;
        const router = new ApiRouter(); admin.register(router); auth.registerAuth(router);
        const route = (method: string, path: string) => router.routes.find(row => row.method === method && row.path === '/v2/rental/admin/auth' + path)!.handler;
        const call = (method: string, path: string, input: Parameters<typeof context>[0] = {}) => route(method, path)(context({ ...input, method })) as Promise<Row>;
        const changeRole = (input: Parameters<typeof context>[0]) => router.routes.find(row => row.method === 'PUT' && row.path === '/v2/rental/admin/users/:id/role')!.handler(context({ ...input, method: 'PUT' })) as Promise<Row>;
        const users = (input: Parameters<typeof context>[0]) => router.routes.find(row => row.method === 'GET' && row.path === '/v2/rental/admin/users')!.handler(context({ ...input, method: 'GET' })) as Promise<Row>;
        return { auth, admin, route, call, changeRole, users };
      });
      const tokens = [await nodes[0].auth.login('1'), await nodes[1].auth.login('3')].map(value => value.token.accessToken);
      const userToken = (await nodes[0].auth.login('2')).token.accessToken;
      const createCtx = context(), challenge = await nodes[0].route('POST', '/challenges')(createCtx) as Row;
      const browserCookie = createCtx.res.append.mock.calls[0][1].split(';')[0];
      const images = await Promise.all(Array.from({ length: 6 }, (_, index) => {
        const ctx = context({ id: challenge.id, cookie: browserCookie, method: 'GET' });
        return Promise.resolve(nodes[index % 2].route('GET', '/challenges/:id/qrcode')(ctx)).then(() => ctx.res.end.mock.calls[0][0]);
      }));
      expect(images).toEqual(Array.from({ length: 6 }, () => image)); expect(providerCalls).toBe(1);
      await expect(nodes[0].call('POST', '/challenges/:id/scan', { id: challenge.id, token: userToken })).rejects.toMatchObject({ status: 403 });
      const scans = await Promise.allSettled(nodes.map((node, index) => node.call('POST', '/challenges/:id/scan', { id: challenge.id, token: tokens[index] })));
      expect(scans.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      expect((scans.find(value => value.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      const winner = scans.findIndex(value => value.status === 'fulfilled');
      await nodes[winner].call('POST', '/challenges/:id/confirm', { id: challenge.id, token: tokens[winner], body: { approved: true } });
      const consumeContexts = Array.from({ length: 8 }, () => context({ id: challenge.id, cookie: browserCookie }));
      const consumes = await Promise.allSettled(consumeContexts.map((ctx, index) => nodes[index % 2].route('POST', '/challenges/:id/consume')(ctx)));
      expect(consumes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      for (const value of consumes.filter(value => value.status === 'rejected') as PromiseRejectedResult[]) expect(value.reason).toMatchObject({ status: 409 });
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_admin_session'))!.total)).toBe(1);
      expect((await db.one('SELECT * FROM ar_admin_login_challenge WHERE id=?', [challenge.id]))!.status).toBe('consumed');
      const successIndex = consumes.findIndex(value => value.status === 'fulfilled');
      const sessionCookie = consumeContexts[successIndex].res.append.mock.calls[0][1].split(';')[0];
      expect((await db.one('SELECT id FROM ar_admin_session'))!.id).not.toBe(sessionCookie.split('=')[1]);
      const session = await nodes[1].call('GET', '/session', { cookie: sessionCookie });
      expect(session.user.id).toBe(winner === 0 ? 1 : 3);

      const adminToken = (await nodes[0].auth.login('4')).token.accessToken;
      const createAdminCtx = context(), adminChallenge = await nodes[0].route('POST', '/challenges')(createAdminCtx) as Row;
      const adminBrowserCookie = createAdminCtx.res.append.mock.calls[0][1].split(';')[0];
      await nodes[0].call('POST', '/challenges/:id/scan', { id: adminChallenge.id, token: adminToken });
      await nodes[1].call('POST', '/challenges/:id/confirm', { id: adminChallenge.id, token: adminToken, body: { approved: true } });
      const consumeAdminCtx = context({ id: adminChallenge.id, cookie: adminBrowserCookie });
      expect(await nodes[1].route('POST', '/challenges/:id/consume')(consumeAdminCtx)).toMatchObject({ user: { id: 4, role: 'admin' } });
      const adminSessionCookie = consumeAdminCtx.res.append.mock.calls[0][1].split(';')[0];
      const userList = await nodes[0].users({ cookie: adminSessionCookie });
      expect(userList.items.find((user: Row) => user.id === 2).allowedRoles).toEqual(['user', 'manager']);
      expect(userList.items.find((user: Row) => user.id === 3).allowedRoles).toEqual([]);
      expect(userList.items.find((user: Row) => user.id === 5).allowedRoles).toEqual([]);
      expect(await nodes[0].changeRole({ cookie: adminSessionCookie, id: '2', body: { role: 'manager' } })).toMatchObject({ role: 'manager' });
      expect((await nodes[1].auth.authenticateBearer(context({ token: userToken }))).user.role).toBe('manager');
      for (const [id, role] of [['4', 'user'], ['5', 'manager'], ['3', 'user'], ['2', 'admin']]) await expect(nodes[1].changeRole({ cookie: adminSessionCookie, id, body: { role } })).rejects.toMatchObject({ status: 403 });
      await expect(nodes[0].changeRole({ cookie: adminSessionCookie, id: '2', body: { role: 'root' } })).rejects.toMatchObject({ status: 422 });
      await nodes[0].changeRole({ cookie: adminSessionCookie, id: '2', body: { role: 'user' } });
      // Only root can grant admin or demote an existing admin. Previously issued
      // browser cookies and JWTs immediately observe the lower current role.
      await nodes[0].changeRole({ token: tokens[1], id: '2', body: { role: 'admin' } });
      expect((await nodes[0].auth.authenticateBearer(context({ token: userToken }))).user.role).toBe('admin');
      await nodes[0].changeRole({ token: tokens[1], id: '4', body: { role: 'manager' } });
      expect((await nodes[1].call('GET', '/session', { cookie: adminSessionCookie })).user.role).toBe('manager');
      await expect(nodes[0].users({ cookie: adminSessionCookie })).rejects.toMatchObject({ status: 403 });
      await expect(nodes[1].changeRole({ token: adminToken, id: '1', body: { role: 'user' } })).rejects.toMatchObject({ status: 403 });
      expect(Number((await db.one("SELECT COUNT(*) AS total FROM ar_user WHERE role='root'"))!.total)).toBe(1);

      await db.execute("UPDATE ar_user SET role='user' WHERE id=?", [session.user.id]);
      await expect(nodes[0].call('GET', '/session', { cookie: sessionCookie })).rejects.toMatchObject({ status: 403 });
      await nodes[0].call('POST', '/logout', { cookie: sessionCookie });
      expect((await db.one('SELECT revoked_ms FROM ar_admin_session WHERE user_id=?', [session.user.id]))!.revoked_ms).not.toBeNull();
    } finally {
      await db?.close();
      if (created) await control.query(`DROP DATABASE ${database}`);
      await control.end();
    }
  });
});
