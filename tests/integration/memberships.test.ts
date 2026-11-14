import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { RentalAuth } from '../../src/auth';
import { loadAccountPermissions } from '../../src/auth/identity';
import type { Row } from '../../src/core/contracts';
import { Database } from '../../src/core/database';
import { migrate } from '../../src/core/migrations';
import { ApiRouter } from '../../src/core/router';
import { withMerchant, type ApplicationEntry, type MerchantRuntime } from '../../src/merchants/context';

const appId = 'wx03dbf50c15cac06f';

async function withFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated loopback AR rental test database.');
  const options = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(options), database = 'ar_memberships_' + randomBytes(8).toString('hex');
  let db: Database | undefined;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    db = new Database(mysql.createPool({ ...options, database, connectionLimit: 8 }));
    await migrate(db);
    await run(await setup(db));
  } finally { await db?.close(); await control.query(`DROP DATABASE IF EXISTS ${database}`); await control.end(); }
}

async function setup(db: Database) {
  await db.insert('ar_user', { id: 1, appid: appId, openid: 'synthetic-root', role: 'root', merchant_id: null });
  await db.insert('ar_merchant', { id: 2, code: 'shared-membership', name: 'Synthetic shared membership merchant', status: 'active', origin: 'https://d.4mr.cn', hostname: 'd.4mr.cn', app_id: appId, miniapp_owner_id: 1, created_ms: Date.now(), updated_ms: Date.now() });
  const client = { config: { appId }, codeSession: async (code: string) => ({ openid: code }) } as any;
  const merchant: MerchantRuntime = { id: 1, code: 'default', name: 'Synthetic default merchant', status: 'active', appId, origin: 'https://d.4mr.cn', configId: 1, client };
  const entry: ApplicationEntry = { id: 1, legacyMerchantId: 1, name: 'Synthetic platform application', status: 'active', appId, origin: merchant.origin, client };
  const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-membership-integration-key-at-least-32-bytes', rootPhone: '' });
  const router = new ApiRouter(); auth.registerAuth(router);
  const scoped = <T>(operation: () => Promise<T>) => withMerchant({ entry, merchant }, operation);
  const login = (code: string, bindToken?: string) => scoped(() => auth.login(code, bindToken));
  const root = await login('synthetic-root');
  const call = (method: string, path: string, bearer: string, body: Row = {}, params: Row = {}, query: Row = {}) => scoped(() => router.routes.find(row => row.method === method && row.path === '/v2/rental/' + path)!.handler({ req: { headers: { authorization: 'Bearer ' + bearer } }, res: { setHeader: vi.fn() }, body, params, query } as any)) as Promise<Row>;
  return { db, auth, merchant, entry, scoped, login, root, call };
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL authoritative merchant memberships', () => {
  it('migrates legacy employees once, preserves revoked memberships and expires unversioned grants', async () => withFixture(async f => {
    await f.db.insert('ar_user', { id: 2, appid: appId, openid: 'legacy-employee', role: 'manager', merchant_id: 1 });
    await f.db.insert('ar_user', { id: 3, appid: appId, openid: 'legacy-consumer', role: 'user', merchant_id: 1 });
    await f.db.insert('ar_user', { id: 4, appid: appId, openid: 'revoked-employee', role: 'adminer', merchant_id: 1, auth_version: 4 });
    await f.db.insert('ar_merchant_membership', { user_id: 4, merchant_id: 1, role: 'adminer', status: 'revoked', authorization_version: 9, updated_ms: Date.now() });
    await f.db.insert('ar_user_merchant_binding', { id: 'a'.repeat(64), user_id: 2, source_merchant_id: 1, target_merchant_id: 2, target_role: 'adminer', created_by: 1, reason: 'Synthetic pre-versioned grant', created_ms: Date.now(), expires_ms: Date.now() + 3600000 });
    await f.db.execute('DELETE FROM ar_schema_migration WHERE version>=11');
    await f.db.execute('UPDATE ar_schema_meta SET version=10');
    await migrate(f.db); await migrate(f.db);
    expect(await f.db.one('SELECT role,merchant_id FROM ar_user WHERE id=3')).toEqual({ role: 'user', merchant_id: null });
    expect(await f.db.one('SELECT merchant_id,role,status,authorization_version FROM ar_merchant_membership WHERE user_id=2')).toEqual({ merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1 });
    expect(await f.db.one('SELECT status,authorization_version FROM ar_merchant_membership WHERE user_id=4')).toEqual({ status: 'revoked', authorization_version: 9 });
    expect(await f.db.one('SELECT role,merchant_id,auth_version FROM ar_user WHERE id=4')).toEqual({ role: 'user', merchant_id: null, auth_version: 4 });
    expect(Number((await f.db.one('SELECT expires_ms FROM ar_user_merchant_binding'))!.expires_ms)).toBeLessThanOrEqual(Date.now());
    await f.db.execute("UPDATE ar_user SET role='adminer',merchant_id=1 WHERE id=3");
    await migrate(f.db);
    expect(await f.db.one('SELECT * FROM ar_merchant_membership WHERE user_id=3')).toBeNull();
    const rawConsumer = (await f.db.one('SELECT * FROM ar_user WHERE id=3'))!;
    const consumer = await f.scoped(() => loadAccountPermissions(f.db, rawConsumer));
    expect(consumer).toMatchObject({ role: 'user', merchant_id: null });
  }), 30_000);

  it('invalidates an outstanding staff assignment when root revokes authority and requires a new grant', async () => withFixture(async f => {
    await f.db.insert('ar_user', { id: 2, appid: appId, openid: 'synthetic-subject', role: 'adminer', merchant_id: 1 });
    await f.db.insert('ar_merchant_membership', { user_id: 2, merchant_id: 1, role: 'adminer', status: 'active', authorization_version: 1, updated_ms: Date.now() });
    const subject = await f.login('synthetic-subject');
    const pending = await f.call('POST', 'admin/users/:id/merchant', f.root.token.accessToken, { merchantId: 2, role: 'adminer', reason: 'Synthetic grant before revocation' }, { id: '2' });
    await f.call('POST', 'auth/merchant-binding/confirm', subject.token.accessToken, { bindToken: pending.binding.token });
    await f.call('PUT', 'admin/users/:id/role', f.root.token.accessToken, { role: 'user' }, { id: '2' });
    expect(await f.db.one('SELECT role,merchant_id,auth_version FROM ar_user WHERE id=2')).toEqual({ role: 'user', merchant_id: null, auth_version: 1 });
    expect(await f.db.one('SELECT status,authorization_version FROM ar_merchant_membership WHERE user_id=2')).toEqual({ status: 'revoked', authorization_version: 2 });
    await expect(f.login('synthetic-subject', pending.binding.token)).rejects.toMatchObject({ status: 409 });
    await expect(f.scoped(() => f.auth.refresh(subject.token.refreshToken))).rejects.toMatchObject({ status: 401 });
    const fresh = await f.login('synthetic-subject');
    expect(fresh).toMatchObject({ user: { role: 'user', merchantId: null }, managementMerchant: null, entry: { id: 1, legacyMerchantId: 1 } });
    await expect(f.call('POST', 'auth/merchant-binding/confirm', fresh.token.accessToken, { bindToken: pending.binding.token })).rejects.toMatchObject({ status: 409 });
    const employees = await f.call('GET', 'admin/users', f.root.token.accessToken);
    expect(employees).toMatchObject({ scope: 'employees', items: [] });
    const platform = await f.call('GET', 'admin/users', f.root.token.accessToken, {}, {}, { scope: 'platform' });
    expect(platform.items).toMatchObject([{ id: 2, role: 'user', merchantId: null }]);
    const renewed = await f.call('POST', 'admin/users/:id/merchant', f.root.token.accessToken, { merchantId: 2, role: 'adminer', reason: 'Synthetic renewed grant' }, { id: '2' });
    await f.call('POST', 'auth/merchant-binding/confirm', fresh.token.accessToken, { bindToken: renewed.binding.token });
    const bound = await f.login('synthetic-subject', renewed.binding.token);
    expect(bound).toMatchObject({ user: { id: 2, role: 'adminer', merchantId: 2 }, managementMerchant: { id: 2 }, merchant: { id: 2 } });
    expect(await f.db.one('SELECT merchant_id,role,status,authorization_version FROM ar_merchant_membership WHERE user_id=2')).toEqual({ merchant_id: 2, role: 'adminer', status: 'active', authorization_version: 3 });
  }), 30_000);
});
