import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalAuth, bootstrapRoot } from '../src/auth';
import { ApiRouter } from '../src/core/router';
import type { Row } from '../src/core/contracts';
import type { Database } from '../src/core/database';

const appId = 'wx0123456789abcdef', key = 'new-rental-secret-32-bytes-at-least';
const opened: DatabaseSync[] = [];
const temporary: string[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY AUTOINCREMENT,appid TEXT,openid TEXT,unionid TEXT,nickname TEXT,avatar TEXT,tel TEXT,role TEXT DEFAULT 'user',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(appid,openid));
    CREATE TABLE ar_user_phone(user_id INTEGER PRIMARY KEY,appid TEXT,phone_e164 TEXT,country_code TEXT,verified_ms INTEGER,code_hash TEXT UNIQUE);
    CREATE TABLE ar_role_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id INTEGER,target_user_id INTEGER,previous_role TEXT,next_role TEXT,source TEXT,reason TEXT);
    CREATE TABLE ar_admin_guard(id INTEGER PRIMARY KEY); INSERT INTO ar_admin_guard VALUES(1);`);
  const sql = (value: string) => value.replace(/ FOR UPDATE/g, '').replace(/CURRENT_TIMESTAMP\(3\)/g, 'CURRENT_TIMESTAMP').replace(/CAST\((u\.)?id AS CHAR\)/g, 'CAST($1id AS TEXT)');
  const db = {
    async query(query: string, values: any[] = []) { return sqlite.prepare(sql(query)).all(...values) as Row[]; },
    async one(query: string, values: any[] = []) { return (await this.query(query, values))[0] ?? null; },
    async execute(query: string, values: any[] = []) { const result = sqlite.prepare(sql(query)).run(...values); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async insert(table: string, data: Row) { const entries = Object.entries(data); const result = await this.execute(`INSERT INTO ${table} (${entries.map(([name]) => name)}) VALUES (${entries.map(() => '?')})`, entries.map(([, value]) => value)); return (await this.one(`SELECT * FROM ${table} WHERE id=?`, [result.insertId]))!; },
    async transaction<T>(operation: (tx: any) => Promise<T>): Promise<T> { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  let now = Date.parse('2026-11-13T06:00:00Z');
  const client = { config: { appId }, codeSession: vi.fn(async (_code: string): Promise<Row> => ({ openid: 'server-payer-1' })) };
  const options = { jwtSecret: key, now: () => now };
  const auth = new RentalAuth(db as unknown as Database, client as any, options), router = new ApiRouter(); auth.registerAuth(router);
  const context = (token: string, body: Row = {}, params: Row = {}, query: Row = {}) => ({ req: { headers: { authorization: 'Bearer ' + token } }, res: { setHeader: vi.fn() }, body, params, query } as any);
  const route = (method: string, path: string) => router.routes.find(item => item.method === method && item.path === path)!.handler;
  return { db, client, auth, options, context, route, advance: (ms: number) => { now += ms; } };
}

describe('independent rental authentication', () => {
  it('creates an ordinary user from verified OpenID even without UnionID; reuses only this App identity', async () => {
    const f = fixture();
    const login = await f.auth.login('code');
    expect(login).toMatchObject({ user: { id: 1, role: 'user' }, openid: 'server-payer-1', unionid: null, appId });
    expect(await f.db.query('SELECT * FROM ar_user')).toHaveLength(1);
    expect((await f.auth.login('other-code')).user.id).toBe(1);
    f.client.codeSession.mockResolvedValueOnce({ openid: 'different-openid', unionid: 'same-union' });
    const second = await f.auth.login('code-2');
    f.client.codeSession.mockResolvedValueOnce({ openid: 'third-openid', unionid: 'same-union' });
    expect((await f.auth.login('code-3')).user.id).not.toBe(second.user.id);
    expect(login).not.toHaveProperty('session_key');
  });
  it('accepts only code from the frontend and never trusts role or supplied OpenID', async () => {
    const f = fixture();
    const response: any = await f.route('POST', '/v2/rental/auth/login')(f.context('', { code: 'real-code', openid: 'attacker', role: 'root' }));
    expect(response).toMatchObject({ success: true, data: { openid: 'server-payer-1', user: { role: 'user' } } });
    expect(f.client.codeSession).toHaveBeenCalledWith('real-code');
  });
  it('separates access/refresh purposes and rejects old domains, wrong AppID, issuer, audience and expiry', async () => {
    const f = fixture(), login = await f.auth.login('code');
    expect((await f.auth.authenticate(f.context(login.token.accessToken))).openid).toBe('server-payer-1');
    await expect(f.auth.authenticate(f.context(login.token.refreshToken))).rejects.toMatchObject({ status: 401 });
    await expect(f.auth.refresh(login.token.accessToken)).rejects.toMatchObject({ status: 401 });
    expect((await f.auth.refresh(login.token.refreshToken)).user.id).toBe(1);
    const claims = jwt.decode(login.token.accessToken) as jwt.JwtPayload;
    for (const change of [{ appid: 'wxaaaaaaaaaaaaaaaa' }, { iss: 'old-backend' }, { aud: 'old-mini-program' }, { purpose: 'v2-user' }, { appid: undefined, identityDomain: 'v2-user' }]) {
      const forged = jwt.sign({ ...claims, ...change }, key, { algorithm: 'HS256' });
      await expect(f.auth.authenticate(f.context(forged))).rejects.toMatchObject({ status: 401 });
    }
    f.advance(7200000);
    await expect(f.auth.authenticate(f.context(login.token.accessToken))).rejects.toMatchObject({ status: 401 });
  });
  it('reads current roles and account presence on every request, including refresh', async () => {
    const f = fixture(), login = await f.auth.login('code');
    await bootstrapRoot(f.db as unknown as Database, 1, appId);
    expect((await f.auth.authenticate(f.context(login.token.accessToken))).user.role).toBe('root');
    await f.db.execute("UPDATE ar_user SET role='user' WHERE id=1");
    expect((await f.auth.refresh(login.token.refreshToken)).user.role).toBe('user');
    await f.db.execute('DELETE FROM ar_user WHERE id=1');
    await expect(f.auth.authenticate(f.context(login.token.accessToken))).rejects.toMatchObject({ status: 401 });
  });
  it('requires explicit console bootstrap, refuses repeated bootstrap and protects the final root', async () => {
    const f = fixture(), login = await f.auth.login('code');
    await expect(f.route('GET', '/v2/rental/admin/users')(f.context(login.token.accessToken))).rejects.toMatchObject({ status: 403 });
    await bootstrapRoot(f.db as unknown as Database, 1, appId);
    await expect(bootstrapRoot(f.db as unknown as Database, 1, appId)).rejects.toMatchObject({ status: 409 });
    await expect(f.route('PUT', '/v2/rental/admin/users/:id/role')(f.context(login.token.accessToken, { role: 'user' }, { id: '1' }))).rejects.toMatchObject({ status: 403 });
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toMatchObject([{ source: 'console-bootstrap', next_role: 'root' }]);
  });
  it('permits roots to grant manager with audit, excludes actor and rejects root promotion', async () => {
    const f = fixture(), root = await f.auth.login('code'); await bootstrapRoot(f.db as unknown as Database, 1, appId);
    f.client.codeSession.mockResolvedValue({ openid: 'second-user' }); const second = await f.auth.login('code-2');
    const change = f.route('PUT', '/v2/rental/admin/users/:id/role');
    await expect(change(f.context(root.token.accessToken, { role: 'root' }, { id: String(second.user.id) }))).rejects.toMatchObject({ status: 422 });
    const grant: any = await change(f.context(root.token.accessToken, { role: 'manager' }, { id: String(second.user.id) }));
    expect(grant.role).toBe('manager');
    const list: any = await f.route('GET', '/v2/rental/admin/users')(f.context(root.token.accessToken));
    expect(list.items).toHaveLength(1); expect(list.items[0]).not.toHaveProperty('openid');
    expect(list.items[0].id).toBe(second.user.id);
    await change(f.context(root.token.accessToken, { role: 'user' }, { id: String(second.user.id) }));
    await expect(f.route('GET', '/v2/rental/admin/users')(f.context(second.token.accessToken))).rejects.toMatchObject({ status: 403 });
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(3);
  });
  it('rejects missing signing configuration without preventing route registration', async () => {
    const f = fixture(); vi.stubEnv('JWT_SECRET', ''); vi.stubEnv('JWT_SECRET_PATH', '');
    const auth = new RentalAuth(f.db as any, f.client as any), router = new ApiRouter(); auth.registerAuth(router);
    expect(router.routes).toHaveLength(4);
    await expect(auth.login('code')).rejects.toMatchObject({ status: 503 });
    expect(f.client.codeSession).not.toHaveBeenCalled();
  });
  it('searches verified phone ownership for root and exposes only a masked phone', async () => {
    const f = fixture(), root = await f.auth.login('root'); await bootstrapRoot(f.db as unknown as Database, root.user.id, appId);
    f.client.codeSession.mockResolvedValueOnce({ openid: 'verified-phone-owner' });
    const target = await f.auth.login('second');
    await f.db.execute('INSERT INTO ar_user_phone VALUES(?,?,?,?,?,?)', [target.user.id, appId, '+8613800138000', '86', Date.now(), 'a'.repeat(64)]);
    const response: any = await f.route('GET', '/v2/rental/admin/users')(f.context(root.token.accessToken, {}, {}, { search: '13800138000' }));
    expect(response).toMatchObject({ total: 1, items: [{ id: target.user.id, tel: '+86 138****8000', phoneVerified: true }] });
    expect(JSON.stringify(response)).not.toContain('+8613800138000');
    expect((await f.auth.refresh(target.token.refreshToken)).user.tel).toBeNull();
  });
  it('uses a valid secret file when Compose injects an empty inline secret', async () => {
    const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'ar-auth-test-')); temporary.push(directory);
    const path = join(directory, 'jwt-secret'); writeFileSync(path, key + '\n', { mode: 0o600 });
    vi.stubEnv('JWT_SECRET', ''); vi.stubEnv('JWT_SECRET_PATH', path);
    const auth = new RentalAuth(f.db as any, f.client as any, { now: f.options.now, jwtSecret: '  ' });
    const result = await auth.login('code');
    expect((await auth.authenticate(f.context(result.token.accessToken))).user.id).toBe(result.user.id);
  });
  it('returns a fixed configuration error for an empty inline secret and unreadable secret file', async () => {
    const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'ar-auth-test-')); temporary.push(directory);
    vi.stubEnv('JWT_SECRET', ''); vi.stubEnv('JWT_SECRET_PATH', join(directory, 'missing-private-secret'));
    const auth = new RentalAuth(f.db as any, f.client as any);
    await expect(auth.login('code')).rejects.toMatchObject({ status: 503, message: '登录签名密钥未配置或长度不足' });
    expect(f.client.codeSession).not.toHaveBeenCalled();
  });
});
