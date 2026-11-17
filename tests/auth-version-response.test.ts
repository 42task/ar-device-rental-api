import { DatabaseSync } from 'node:sqlite';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalAuth } from '../src/auth';
import type { Row } from '../src/core/contracts';
import type { Database } from '../src/core/database';
import { ApiRouter } from '../src/core/router';
import { runWithMerchant, type MerchantRuntime } from '../src/merchants/context';

const appId = 'wx0123456789abcdef';
const signingKey = 'synthetic-auth-version-response-signing-key-32-bytes';
const issuer = 'auth-version-response-test', audience = 'auth-version-client-test';
const opened: DatabaseSync[] = [];
afterEach(() => opened.splice(0).forEach(database => database.close()));

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user (
      id INTEGER PRIMARY KEY AUTOINCREMENT, appid TEXT, openid TEXT, unionid TEXT,
      nickname TEXT, avatar TEXT, tel TEXT, role TEXT DEFAULT 'user', merchant_id INTEGER,
      auth_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT, UNIQUE(appid,openid));
    CREATE TABLE ar_user_wechat_identity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, appid TEXT, openid TEXT,
      unionid TEXT, status TEXT DEFAULT 'active', UNIQUE(appid,openid));
    CREATE TABLE ar_merchant_membership (
      user_id INTEGER PRIMARY KEY, merchant_id INTEGER, role TEXT, status TEXT,
      authorization_version INTEGER, updated_ms INTEGER);
    CREATE TABLE ar_merchant(id INTEGER PRIMARY KEY,code TEXT,name TEXT,status TEXT,origin TEXT,app_id TEXT,active_config_id INTEGER);
    INSERT INTO ar_merchant VALUES(1,'default','Synthetic merchant','active','https://version.example.test','${appId}',1);`);
  const sql = (query: string) => query.replace(/ FOR UPDATE/g, '').replace(/CURRENT_TIMESTAMP\(3\)/g, 'CURRENT_TIMESTAMP');
  const database = {
    async query(query: string, values: any[] = []): Promise<Row[]> {
      return sqlite.prepare(sql(query)).all(...values) as Row[];
    },
    async one(query: string, values: any[] = []): Promise<Row | null> {
      return (await this.query(query, values))[0] ?? null;
    },
    async execute(query: string, values: any[] = []) {
      const result = sqlite.prepare(sql(query)).run(...values);
      return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) };
    },
    async insert(table: string, data: Row): Promise<Row> {
      const entries = Object.entries(data);
      const result = await this.execute(`INSERT INTO ${table} (${entries.map(([name]) => name)}) VALUES (${entries.map(() => '?')})`, entries.map(([, value]) => value));
      return (await this.one(`SELECT * FROM ${table} WHERE id=?`, [result.insertId]))!;
    },
    async transaction<T>(operation: (transaction: any) => Promise<T>): Promise<T> {
      sqlite.exec('BEGIN');
      try {
        const result = await operation(this);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let now = 1_800_000_000_000;
  const client = { config: { appId }, codeSession: vi.fn(async () => ({ openid: 'synthetic-version-payer' })) };
  const merchant: MerchantRuntime = {
    id: 1, code: 'default', name: 'Synthetic merchant', status: 'active',
    origin: 'https://version.example.test', appId, configId: 1, client: client as any,
  };
  const auth = new RentalAuth(database as unknown as Database, client as any, {
    jwtSecret: signingKey, rootPhone: '', issuer, audience, now: () => now,
  });
  const router = new ApiRouter();
  auth.registerAuth(router);
  const route = (path: string) => router.routes.find(item => item.method === 'POST' && item.path === '/v2/rental/auth/' + path)!.handler;
  const request = async (path: string, body: Row): Promise<Row> => runWithMerchant(merchant, async () => {
    const response = await route(path)({ body, query: {}, params: {}, req: { headers: {} }, res: { setHeader: vi.fn() } } as any) as Row;
    expect(response.success).toBe(true);
    return response.data;
  });
  const claims = (token: string) => jwt.verify(token, signingKey, {
    algorithms: ['HS256'], issuer, audience, clockTimestamp: Math.floor(now / 1000),
  }) as JwtPayload;
  const expectVersion = async (response: Row) => {
    const snapshot = (await database.one('SELECT auth_version FROM ar_user WHERE id=?', [response.user.id]))!;
    expect(typeof response.authVersion).toBe('number');
    expect(response.authVersion).toBe(snapshot.auth_version);
    expect(response.user).not.toHaveProperty('authVersion');
    expect(response.user).not.toHaveProperty('auth_version');
    expect(claims(response.token.accessToken)).toMatchObject({ uid: response.user.id, auth_version: snapshot.auth_version, purpose: 'access' });
    expect(claims(response.token.refreshToken)).toMatchObject({ uid: response.user.id, auth_version: snapshot.auth_version, purpose: 'refresh' });
    expect(claims(response.token.accessToken).iid).toBeGreaterThan(0);
    return snapshot.auth_version;
  };
  return { database, request, claims, expectVersion, advance: () => { now += 1000; } };
}

describe('authentication response authorization version contract', () => {
  it('returns the modern login database version beside tokens carrying the same authorization version', async () => {
    const f = fixture();
    const login = await f.request('login', { code: 'verified-synthetic-code' });
    expect(login.user.role).toBe('user');
    expect(await f.expectVersion(login)).toBe(0);
  });

  it('keeps the authorization version stable while ordinary refresh rotates tokens', async () => {
    const f = fixture();
    const login = await f.request('login', { code: 'first-login' });
    f.advance();
    const refreshed = await f.request('refresh', { refreshToken: login.token.refreshToken });
    f.advance();
    const renewed = await f.request('refresh', { refreshToken: refreshed.token.refreshToken });
    for (const response of [login, refreshed, renewed]) expect(await f.expectVersion(response)).toBe(0);
    expect(f.claims(refreshed.token.accessToken).jti).not.toBe(f.claims(login.token.accessToken).jti);
    expect(f.claims(renewed.token.refreshToken).jti).not.toBe(f.claims(refreshed.token.refreshToken).jti);
  });

  it('rejects an old refresh after a database version change and exposes the new version on fresh login', async () => {
    const f = fixture();
    const login = await f.request('login', { code: 'before-authorization-change' });
    await f.database.execute('UPDATE ar_user SET auth_version=auth_version+1 WHERE id=?', [login.user.id]);
    await expect(f.request('refresh', { refreshToken: login.token.refreshToken })).rejects.toMatchObject({ status: 401 });
    const fresh = await f.request('login', { code: 'after-authorization-change' });
    expect(fresh.user.id).toBe(login.user.id);
    expect(await f.expectVersion(fresh)).toBe(1);
    expect(fresh.authVersion).not.toBe(login.authVersion);
    const refreshed = await f.request('refresh', { refreshToken: fresh.token.refreshToken });
    expect(await f.expectVersion(refreshed)).toBe(1);
  });

  it('exposes a manager authorization change even when its role and merchant remain unchanged', async () => {
    const f = fixture();
    const initial = await f.request('login', { code: 'create-synthetic-account' });
    await f.database.execute("UPDATE ar_user SET role='manager',merchant_id=1,auth_version=7 WHERE id=?", [initial.user.id]);
    await f.database.execute("INSERT INTO ar_merchant_membership VALUES(?,1,'manager','active',1,0)", [initial.user.id]);
    const before = await f.request('login', { code: 'manager-before-version-change' });
    expect(before).toMatchObject({ user: { role: 'manager', merchantId: 1 }, managementMerchant: { id: 1 }, authVersion: 7 });
    expect(await f.expectVersion(before)).toBe(7);
    await f.database.execute('UPDATE ar_user SET auth_version=auth_version+1 WHERE id=?', [initial.user.id]);
    await expect(f.request('refresh', { refreshToken: before.token.refreshToken })).rejects.toMatchObject({ status: 401 });
    const after = await f.request('login', { code: 'manager-after-version-change' });
    expect(after.user).toEqual(before.user);
    expect(after.managementMerchant).toEqual(before.managementMerchant);
    expect(await f.expectVersion(after)).toBe(8);
    expect(await f.expectVersion(await f.request('refresh', { refreshToken: after.token.refreshToken }))).toBe(8);
  });
});
