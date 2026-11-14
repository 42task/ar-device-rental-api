import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalAuth } from '../src/auth';
import { PhoneBinding } from '../src/auth/phone';
import type { Database } from '../src/core/database';
import type { Row } from '../src/core/contracts';

const appId = 'wx03dbf50c15cac06f', number = '+8613800138000';
const opened: DatabaseSync[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture(rootPhone?: string) {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY AUTOINCREMENT,appid TEXT,openid TEXT,unionid TEXT,nickname TEXT,avatar TEXT,tel TEXT,role TEXT DEFAULT 'user',updated_at TEXT,UNIQUE(appid,openid));
    INSERT INTO ar_user(id,appid,openid,role) VALUES(1,'${appId}','one','user'),(2,'${appId}','two','manager');
    CREATE TABLE ar_user_phone(user_id INTEGER PRIMARY KEY,appid TEXT,phone_e164 TEXT,country_code TEXT,verified_ms INTEGER,code_hash TEXT UNIQUE,UNIQUE(appid,phone_e164));
    CREATE TABLE ar_admin_guard(id INTEGER PRIMARY KEY); INSERT INTO ar_admin_guard VALUES(1);
    CREATE TABLE ar_role_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id INTEGER,target_user_id INTEGER,previous_role TEXT,next_role TEXT,source TEXT,reason TEXT);
    CREATE UNIQUE INDEX uq_ar_user_single_root ON ar_user((CASE WHEN role='root' THEN 1 ELSE NULL END));`);
  const sql = (value: string) => value.replace(/ FOR UPDATE/g, '').replace(/CURRENT_TIMESTAMP\(3\)/g, 'CURRENT_TIMESTAMP');
  const db = {
    async query(query: string, values: any[] = []) { return sqlite.prepare(sql(query)).all(...values) as Row[]; },
    async one(query: string, values: any[] = []) { return (await this.query(query, values))[0] ?? null; },
    async execute(query: string, values: any[] = []) { const result = sqlite.prepare(sql(query)).run(...values); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async insert(table: string, row: Row) { const entries = Object.entries(row); const result = await this.execute(`INSERT INTO ${table} (${entries.map(([name]) => name)}) VALUES (${entries.map(() => '?')})`, entries.map(([, value]) => value)); return (await this.one(`SELECT * FROM ${table} WHERE id=?`, [result.insertId]))!; },
    async transaction<T>(operation: (tx: any) => Promise<T>): Promise<T> { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const client = { config: { appId }, codeSession: vi.fn(async (code: string) => ({ openid: code })), phoneNumber: vi.fn(async () => ({ phoneE164: number, countryCode: '86' })) };
  const auth = new RentalAuth(db as unknown as Database, client as any, { jwtSecret: 'synthetic-root-phone-secret-at-least-32-bytes', rootPhone });
  const phone = new PhoneBinding(db as unknown as Database, client as any, auth);
  const bind = (id = 1, phoneNumber = number, bindingAppId = appId, verifiedMs = Date.now()) => db.execute('INSERT INTO ar_user_phone VALUES(?,?,?,?,?,?)', [id, bindingAppId, phoneNumber, '86', verifiedMs, String(id).repeat(64)]);
  const context = (token: string) => ({ req: { headers: { authorization: 'Bearer ' + token } }, res: { setHeader: vi.fn() } } as any);
  return { db, client, auth, phone, bind, context };
}

describe('ROOT_PHONE verified initial root configuration', () => {
  it.each(['+86 138 0013 8000', '13800138000', ' 138 0013 8000 '])('normalizes %s and initializes the matching verified account on login only once', async rootPhone => {
    const f = fixture(rootPhone);
    expect((await f.auth.login('one')).user.role).toBe('user');
    await f.bind();
    expect((await f.auth.login('one')).user.role).toBe('root');
    expect((await f.auth.login('one')).user.role).toBe('root');
    const audit = await f.db.query('SELECT * FROM ar_role_audit');
    expect(audit).toMatchObject([{ actor_user_id: null, target_user_id: 1, previous_role: 'user', next_role: 'root', source: 'env-root-bootstrap' }]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/13800138000|138 0013 8000/);
  });
  it('activates after a new native-phone binding and also refreshes roles for pre-existing tokens', async () => {
    const f = fixture('13800138000'), login = await f.auth.login('one');
    const principal = await f.auth.authenticateBearer(f.context(login.token.accessToken));
    const status = await f.phone.bind(principal, 'native-server-phone-code');
    expect(status).toMatchObject({ verified: true, maskedNumber: '+86 138****8000' });
    expect((await f.db.one('SELECT role FROM ar_user WHERE id=1'))!.role).toBe('user');
    expect((await f.auth.refresh(login.token.refreshToken)).user.role).toBe('root');
    expect((await f.auth.authenticateBearer(f.context(login.token.accessToken))).user.role).toBe('root');
    expect(f.client.phoneNumber).toHaveBeenCalledTimes(1);
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(1);
  });
  it.each(['legacy-tel', 'different-phone', 'different-appid', 'unverified'])('does not initialize from %s', async scenario => {
    const f = fixture('13800138000');
    if (scenario === 'legacy-tel') await f.db.execute('UPDATE ar_user SET tel=? WHERE id=1', [number]);
    else await f.bind(1, scenario === 'different-phone' ? '+8613900139000' : number, scenario === 'different-appid' ? 'wx0000000000000000' : appId, scenario === 'unverified' ? 0 : Date.now());
    expect((await f.auth.login('one')).user.role).toBe('user');
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(0);
    expect((await f.db.one('SELECT role FROM ar_user WHERE id=2'))!.role).toBe('manager');
  });
  it('preserves an existing root even when another verified phone matches configuration', async () => {
    const f = fixture('13800138000'); await f.bind();
    await f.db.execute("UPDATE ar_user SET role='root' WHERE id=2");
    expect((await f.auth.login('one')).user.role).toBe('user');
    expect((await f.db.one('SELECT role FROM ar_user WHERE id=2'))!.role).toBe('root');
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(0);
  });
  it('rolls back a failed root audit and safely retries the verified initialization', async () => {
    const f = fixture('13800138000'); await f.bind();
    const insert = f.db.insert.bind(f.db);
    vi.spyOn(f.db, 'insert').mockImplementationOnce(async () => { throw new Error('Synthetic audit write failure'); });
    await expect(f.auth.login('one')).rejects.toThrow('Synthetic audit write failure');
    expect(await f.db.query("SELECT id FROM ar_user WHERE role='root'")).toEqual([]);
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toEqual([]);
    vi.mocked(f.db.insert).mockImplementation(insert);
    expect((await f.auth.login('one')).user.role).toBe('root');
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(1);
  });
  it('keeps admin on ordinary verified-phone login and does not infer elevated roles from client fields', async () => {
    const f = fixture(''); await f.db.execute("UPDATE ar_user SET role='admin' WHERE id=2");
    expect((await f.auth.login('two')).user.role).toBe('admin');
    f.client.codeSession.mockResolvedValueOnce({ openid: 'one', phone: number, role: 'root' } as any);
    expect((await f.auth.login('client-claims')).user.role).toBe('user');
    expect(await f.db.query("SELECT id FROM ar_user WHERE role='root'")).toEqual([]);
  });
  it.each([undefined, '', ' \t '])('keeps automatic initialization disabled for an unset or blank setting (%s)', async rootPhone => {
    vi.stubEnv('ROOT_PHONE', rootPhone);
    const f = fixture(undefined); await f.bind();
    expect((await f.auth.login('one')).user.role).toBe('user');
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(0);
  });
  it('snapshots the environment setting and lets an explicit empty option disable it', async () => {
    vi.stubEnv('ROOT_PHONE', '+86 138 0013 8000');
    const configured = fixture(undefined), disabled = fixture('');
    vi.stubEnv('ROOT_PHONE', '13900139000');
    await configured.bind(); await disabled.bind();
    expect((await configured.auth.login('one')).user.role).toBe('root');
    expect((await disabled.auth.login('one')).user.role).toBe('user');
  });
  it.each(['138****8000', '+86 12800138000', 'invalid-13800138000'])('returns a safe configuration error for malformed ROOT_PHONE (%s)', async rootPhone => {
    const f = fixture(rootPhone);
    await expect(f.auth.login('one')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('ROOT_PHONE') });
    try { await f.auth.login('one'); } catch (error: any) { expect(error.message).not.toContain(rootPhone); expect(error.message).not.toContain('13800138000'); }
    expect(f.client.codeSession).not.toHaveBeenCalled();
    expect(await f.db.query('SELECT * FROM ar_role_audit')).toHaveLength(0);
  });
});
