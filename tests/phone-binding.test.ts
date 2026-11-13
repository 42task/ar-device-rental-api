import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneBinding, normalizePhoneInput } from '../src/auth/phone';
import { bootstrapRootByPhone, findUserByVerifiedPhone } from '../src/auth/admin';
import { RentalAuth } from '../src/auth';
import { ApiRouter } from '../src/core/router';
import { ApiError } from '../src/core/errors';
import type { Database } from '../src/core/database';
import type { Row } from '../src/core/contracts';

const appId = 'wx03dbf50c15cac06f', number = '+8613800138000';
const opened: DatabaseSync[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
async function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY,appid TEXT,openid TEXT,role TEXT,nickname TEXT,avatar TEXT,tel TEXT,unionid TEXT,updated_at TEXT);
    INSERT INTO ar_user VALUES(1,'${appId}','one','user',NULL,NULL,'${number}',NULL,NULL),(2,'${appId}','two','manager',NULL,NULL,NULL,NULL,NULL);
    CREATE TABLE ar_user_phone(user_id INTEGER PRIMARY KEY,appid TEXT,phone_e164 TEXT,country_code TEXT,verified_ms INTEGER,code_hash TEXT UNIQUE,UNIQUE(appid,phone_e164));
    CREATE TABLE ar_admin_guard(id INTEGER PRIMARY KEY); INSERT INTO ar_admin_guard VALUES(1);
    CREATE TABLE ar_role_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id INTEGER,target_user_id INTEGER,previous_role TEXT,next_role TEXT,source TEXT,reason TEXT);`);
  const sql = (value: string) => value.replace(/ FOR UPDATE/g, '').replace(/CURRENT_TIMESTAMP\(3\)/g, 'CURRENT_TIMESTAMP');
  const db = {
    async query(query: string, values: any[] = []) { return sqlite.prepare(sql(query)).all(...values) as Row[]; },
    async one(query: string, values: any[] = []) { return (await this.query(query, values))[0] ?? null; },
    async execute(query: string, values: any[] = []) { const result = sqlite.prepare(sql(query)).run(...values); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async insert(table: string, row: Row) { const entries = Object.entries(row); const result = await this.execute(`INSERT INTO ${table} (${entries.map(([key]) => key)}) VALUES (${entries.map(() => '?')})`, entries.map(([, value]) => value)); return (await this.one(`SELECT * FROM ${table} WHERE id=?`, [result.insertId]))!; },
    async transaction<T>(operation: (tx: any) => Promise<T>): Promise<T> { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const client = { config: { appId }, codeSession: vi.fn(async (code: string) => ({ openid: code })), phoneNumber: vi.fn(async () => ({ phoneE164: number, countryCode: '86' })) };
  const auth = new RentalAuth(db as unknown as Database, client as any, { jwtSecret: 'synthetic-phone-binding-key-at-least-32-bytes' });
  const phone = new PhoneBinding(db as unknown as Database, client as any, auth, () => 1800000000000), router = new ApiRouter(); phone.register(router);
  const tokens = [(await auth.login('one')).token.accessToken, (await auth.login('two')).token.accessToken];
  const ctx = (index = 0, body: Row = {}, token: string | null = tokens[index]) => ({ req: { headers: token ? { authorization: 'Bearer ' + token } : {} }, res: { setHeader: vi.fn() }, body, params: {}, query: {} } as any);
  const route = (method: string) => router.routes.find(row => row.method === method)!.handler;
  const principal = async (index = 0) => auth.authenticateBearer(ctx(index));
  return { db, client, auth, phone, ctx, route, principal };
}

describe('verified phone ownership binding', () => {
  it('ignores legacy tel and rejects client-supplied phone numbers and browser-only identities', async () => {
    const f = await fixture();
    expect(await f.route('GET')(f.ctx())).toEqual({ verified: false });
    await expect(f.route('POST')(f.ctx(0, { tel: number }))).rejects.toMatchObject({ status: 422 });
    await expect(f.route('POST')(f.ctx(0, { code: 'valid', tel: number }))).rejects.toMatchObject({ status: 422 });
    await expect(f.route('GET')(f.ctx(0, {}, null))).rejects.toMatchObject({ status: 401 });
    await expect(f.route('POST')(f.ctx(0, {}, null))).rejects.toMatchObject({ status: 401 });
    expect(f.client.phoneNumber).not.toHaveBeenCalled();
    await expect(findUserByVerifiedPhone(f.db as any, number, appId)).rejects.toMatchObject({ status: 404 });
    await expect(bootstrapRootByPhone(f.db as any, number, appId)).rejects.toMatchObject({ status: 404 });
    expect((await f.db.one('SELECT role FROM ar_user WHERE id=1'))!.role).toBe('user');
  });
  it('stores provenance and a code hash, returns only a masked phone and keeps the role', async () => {
    const f = await fixture(), result = await f.route('POST')(f.ctx(0, { code: 'synthetic-phone-code' }));
    expect(result).toEqual({ verified: true, maskedNumber: '+86 138****8000', countryCode: '86', verifiedAt: '2027-01-15T08:00:00.000Z' });
    expect(JSON.stringify(result)).not.toContain(number);
    const stored = (await f.db.one('SELECT * FROM ar_user_phone'))!;
    expect(stored).toMatchObject({ user_id: 1, phone_e164: number, country_code: '86', appid: appId });
    expect(stored.code_hash).toMatch(/^[a-f0-9]{64}$/); expect(stored.code_hash).not.toBe('synthetic-phone-code');
    expect((await f.principal()).user.role).toBe('user');
    expect(await f.route('GET')(f.ctx())).toEqual(result);
  });
  it('returns a successful binding on retries without reconsuming or changing the phone', async () => {
    const f = await fixture(), first = await f.phone.bind(await f.principal(), 'code-once');
    f.client.phoneNumber.mockResolvedValue({ phoneE164: '+8613900139000', countryCode: '86' });
    expect(await f.phone.bind(await f.principal(), 'code-once')).toEqual(first);
    expect(await f.phone.bind(await f.principal(), 'new-code')).toEqual(first);
    expect(f.client.phoneNumber).toHaveBeenCalledTimes(1);
    expect((await f.db.one('SELECT phone_e164 FROM ar_user_phone'))!.phone_e164).toBe(number);
  });
  it('rejects another OpenID reusing a code or phone, without transferring identity or roles', async () => {
    const f = await fixture(); await f.phone.bind(await f.principal(), 'shared-code');
    await expect(f.phone.bind(await f.principal(1), 'shared-code')).rejects.toMatchObject({ status: 409 });
    expect(f.client.phoneNumber).toHaveBeenCalledTimes(1);
    await expect(f.phone.bind(await f.principal(1), 'different-code')).rejects.toMatchObject({ status: 409 });
    expect(await f.db.query('SELECT * FROM ar_user_phone')).toHaveLength(1);
    expect((await f.principal(1)).user).toMatchObject({ id: 2, role: 'manager', openid: 'two' });
  });
  it('reports denial, malformed codes and provider failure honestly without creating a binding', async () => {
    const f = await fixture();
    for (const code of [undefined, null, '', ' ', 'a'.repeat(1025)]) await expect(f.phone.bind(await f.principal(), code)).rejects.toMatchObject({ status: 422 });
    f.client.phoneNumber.mockRejectedValueOnce(new ApiError(400, '微信手机号授权已失效或未成功，请重新授权'));
    await expect(f.phone.bind(await f.principal(), 'used-code')).rejects.toMatchObject({ status: 400 });
    f.client.phoneNumber.mockRejectedValueOnce(new ApiError(503, '微信服务暂时不可用'));
    await expect(f.phone.bind(await f.principal(), 'network-code')).rejects.toMatchObject({ status: 503 });
    expect(await f.route('GET')(f.ctx())).toEqual({ verified: false });
    expect(await f.db.query('SELECT * FROM ar_user_phone')).toHaveLength(0);
    expect((await f.principal()).user.role).toBe('user');
  });
  it('bootstraps only an exact verified phone and protects the initial root with audit', async () => {
    const f = await fixture(); await f.phone.bind(await f.principal(), 'verified-code');
    expect(await findUserByVerifiedPhone(f.db as any, '13800138000', appId)).toEqual({ userId: 1, maskedNumber: '+86 138****8000', role: 'user' });
    await expect(findUserByVerifiedPhone(f.db as any, number, 'wx0000000000000000')).rejects.toMatchObject({ status: 404 });
    expect(await bootstrapRootByPhone(f.db as any, '13800138000', appId)).toEqual({ maskedNumber: '+86 138****8000', role: 'root' });
    expect((await f.principal()).user.role).toBe('root');
    await expect(bootstrapRootByPhone(f.db as any, number, appId)).rejects.toMatchObject({ status: 409 });
    const audit = await f.db.query('SELECT * FROM ar_role_audit');
    expect(audit).toMatchObject([{ target_user_id: 1, next_role: 'root', source: 'console-bootstrap' }]);
    expect(JSON.stringify(audit)).not.toContain(number);
  });
  it('accepts only complete E.164 or unambiguous mainland input', () => {
    expect(normalizePhoneInput('13800138000')).toBe(number);
    expect(normalizePhoneInput(number)).toBe(number);
    expect(normalizePhoneInput('+447700900123')).toBe('+447700900123');
    for (const value of ['138****8000', '138 0013 8000', '008613800138000', '8613800138000', '+8612800138000', '+123', '13800138000\n', null]) expect(() => normalizePhoneInput(value)).toThrow();
  });
});
