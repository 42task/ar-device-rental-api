import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RentalAuth } from '../src/auth';
import { PhoneBinding } from '../src/auth/phone';
import { AdminAuth } from '../src/admin/auth';
import { ApiRouter } from '../src/core/router';
import type { Database } from '../src/core/database';
import type { Row } from '../src/core/contracts';
import { runWithMerchant, withMerchant, type MerchantRuntime } from '../src/merchants/context';

const appA = 'wx03dbf50c15cac06f', appB = 'wx0123456789abcdef', key = 'merchant-auth-synthetic-signing-key-32-bytes';
const opened: DatabaseSync[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });

async function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY AUTOINCREMENT,appid TEXT,openid TEXT,unionid TEXT,nickname TEXT,avatar TEXT,tel TEXT,role TEXT DEFAULT 'user',merchant_id INTEGER DEFAULT 1,auth_version INTEGER DEFAULT 0,updated_at TEXT,UNIQUE(appid,openid));
    INSERT INTO ar_user(id,appid,openid,role,merchant_id) VALUES(1,'${appA}','root','root',NULL),(2,'${appA}','target','manager',1),(3,'${appB}','occupied','user',2);
    CREATE UNIQUE INDEX uq_root ON ar_user((CASE WHEN role='root' THEN 1 ELSE NULL END));
    CREATE TABLE ar_user_wechat_identity(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,appid TEXT,openid TEXT,unionid TEXT,status TEXT DEFAULT 'active',UNIQUE(appid,openid));
    INSERT INTO ar_user_wechat_identity(id,user_id,appid,openid) SELECT id,id,appid,openid FROM ar_user;
    CREATE TABLE ar_merchant(id INTEGER PRIMARY KEY,code TEXT,name TEXT,status TEXT,origin TEXT,app_id TEXT);
    INSERT INTO ar_merchant VALUES(1,'default','商户一','active','https://d.example.test','${appA}'),(2,'second','商户二','active','https://d1.example.test','${appB}');
    CREATE TABLE ar_admin_guard(id INTEGER PRIMARY KEY); INSERT INTO ar_admin_guard VALUES(1);
    CREATE TABLE ar_role_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id INTEGER,target_user_id INTEGER,previous_role TEXT,next_role TEXT,source TEXT,reason TEXT,merchant_id INTEGER);
    CREATE TABLE ar_merchant_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_user_id INTEGER,merchant_id INTEGER,previous_merchant_id INTEGER,target_id INTEGER,action TEXT,reason TEXT,created_ms INTEGER);
    CREATE TABLE ar_user_phone(user_id INTEGER PRIMARY KEY,appid TEXT,phone_e164 TEXT,country_code TEXT,verified_ms INTEGER,code_hash TEXT UNIQUE,identity_id INTEGER,UNIQUE(appid,phone_e164));
    INSERT INTO ar_user_phone VALUES(1,'${appA}','+8613700137000','86',1800000000000,'${'a'.repeat(64)}',1),(2,'${appA}','+8613800138000','86',1800000000000,'${'b'.repeat(64)}',2);
    CREATE TABLE ar_user_phone_history(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,identity_id INTEGER,appid TEXT,phone_e164 TEXT,country_code TEXT,verified_ms INTEGER,code_hash TEXT,archived_ms INTEGER);
    CREATE TABLE ar_user_merchant_binding(id TEXT PRIMARY KEY,user_id INTEGER,source_merchant_id INTEGER,target_merchant_id INTEGER,target_role TEXT,created_by INTEGER,reason TEXT,created_ms INTEGER,expires_ms INTEGER,consumed_ms INTEGER,source_confirmed_ms INTEGER);
    CREATE TABLE ar_rental_order(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,refund_amount_cents INTEGER DEFAULT 0,refund_status TEXT,merchant_id INTEGER,appid TEXT,payer_openid TEXT,mch_id TEXT);
    CREATE TABLE ar_admin_login_challenge(id TEXT PRIMARY KEY,browser_hash TEXT,origin TEXT,confirmation_code TEXT,status TEXT,scanned_user_id INTEGER,created_ms INTEGER,expires_ms INTEGER,consumed_ms INTEGER,qrcode_image BLOB,merchant_id INTEGER DEFAULT 1,appid TEXT,auth_version INTEGER);
    CREATE TABLE ar_admin_session(id TEXT PRIMARY KEY,user_id INTEGER,appid TEXT,created_ms INTEGER,expires_ms INTEGER,revoked_ms INTEGER,merchant_id INTEGER DEFAULT 1,identity_id INTEGER,auth_version INTEGER DEFAULT 0,origin TEXT);`);
  const sql = (value: string) => value.replace(/ FOR UPDATE/g, '').replace(/CURRENT_TIMESTAMP\(3\)/g, 'CURRENT_TIMESTAMP').replace(/CAST\((u\.)?id AS CHAR\)/g, 'CAST($1id AS TEXT)').replace(/^(DELETE FROM .*?) LIMIT 100$/, '$1');
  const db = {
    async query(query: string, values: any[] = []) { return sqlite.prepare(sql(query)).all(...values) as Row[]; },
    async one(query: string, values: any[] = []) { return (await this.query(query, values))[0] ?? null; },
    async execute(query: string, values: any[] = []) { const result = sqlite.prepare(sql(query)).run(...values); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async insert(table: string, data: Row) { const entries = Object.entries(data); const result = await this.execute(`INSERT INTO ${table} (${entries.map(([name]) => name)}) VALUES (${entries.map(() => '?')})`, entries.map(([, value]) => value)); return (await this.one(`SELECT * FROM ${table} WHERE id=?`, [data.id ?? result.insertId]))!; },
    async transaction<T>(operation: (tx: any) => Promise<T>): Promise<T> { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  let now = 1_800_000_000_000;
  const client = (appId: string) => ({ config: { appId }, codeSession: vi.fn(async (code: string) => ({ openid: code })), phoneNumber: vi.fn(async () => ({ phoneE164: '+8613800138000', countryCode: '86' })), unlimitedCode: vi.fn(async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])) });
  const a = client(appA), b = client(appB);
  const merchant = (id: number, appId: string, origin: string, payment: any): MerchantRuntime => ({ id, code: id === 1 ? 'default' : 'second', name: '商户' + id, status: 'active', appId, origin, client: payment, configId: id });
  const first = merchant(1, appA, 'https://d.example.test', a), second = merchant(2, appB, 'https://d1.example.test', b);
  const auth = new RentalAuth(db as unknown as Database, a as any, { jwtSecret: key, now: () => now });
  const admin = new AdminAuth(db as unknown as Database, a as any, auth, { now: () => now }); auth.webAuthenticate = admin.authenticate;
  const phone = new PhoneBinding(db as unknown as Database, a as any, auth, () => now), router = new ApiRouter(); auth.registerAuth(router); admin.register(router);
  const ctx = (runtime: MerchantRuntime, token?: string, body: Row = {}, params: Row = {}, cookie?: string) => ({ req: { method: 'POST', protocol: 'https', socket: { remoteAddress: '127.0.0.1' }, headers: { origin: runtime.origin, host: new URL(runtime.origin).host, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}) } }, res: { setHeader: vi.fn(), append: vi.fn(), type: vi.fn().mockReturnThis(), end: vi.fn() }, body, params, query: {} } as any);
  const route = (method: string, path: string) => router.routes.find(value => value.method === method && value.path === '/v2/rental/' + path)!.handler;
  const root = await runWithMerchant(first, () => auth.login('root'));
  const target = await runWithMerchant(first, () => auth.login('target'));
  let sourceToken = target.token.accessToken, sourceRuntime = first;
  const confirmBinding = (token: string, bearer = sourceToken, runtime = sourceRuntime) => runWithMerchant(runtime, () => route('POST', 'auth/merchant-binding/confirm')(ctx(runtime, bearer, { bindToken: token }))) as Promise<Row>;
  const assign = async (body: Row = { merchantId: 2, role: 'adminer', reason: '明确分配到第二商户' }, token = root.token.accessToken, confirm = true) => {
    const request = await runWithMerchant(first, () => route('POST', 'admin/users/:id/merchant')(ctx(first, token, body, { id: '2' }))) as Row;
    if (confirm) await confirmBinding(request.binding.token);
    return request;
  };
  const login = async (runtime: MerchantRuntime, code: string, bindToken?: unknown) => {
    const result = await runWithMerchant(runtime, () => auth.login(code, bindToken));
    if (result.user.id === 2) { sourceToken = result.token.accessToken; sourceRuntime = runtime; }
    return result;
  };
  const authenticate = (runtime: MerchantRuntime, token: string) => runWithMerchant(runtime, () => auth.authenticateBearer(ctx(runtime, token)));
  const cookie = (context: ReturnType<typeof ctx>, name: string) => context.res.append.mock.calls.find((value: string[]) => value[1].startsWith(name + '='))[1].split(';')[0];
  const adminLogin = async (token: string, runtime = first) => runWithMerchant(runtime, async () => {
    const createCtx = ctx(runtime), challenge = await route('POST', 'admin/auth/challenges')(createCtx) as Row;
    await route('POST', 'admin/auth/challenges/:id/scan')(ctx(runtime, token, {}, { id: challenge.id }));
    await route('POST', 'admin/auth/challenges/:id/confirm')(ctx(runtime, token, { approved: true }, { id: challenge.id }));
    const consumeCtx = ctx(runtime, undefined, {}, { id: challenge.id }, cookie(createCtx, 'ar_admin_browser'));
    const session = await route('POST', 'admin/auth/challenges/:id/consume')(consumeCtx) as Row;
    return { session, cookie: cookie(consumeCtx, 'ar_admin_session'), challenge };
  });
  return { db, auth, admin, phone, a, b, first, second, root, target, ctx, route, assign, confirmBinding, login, authenticate, adminLogin, advance(ms: number) { now += ms; } };
}

describe('merchant account identities and explicit assignment', () => {
  it('keeps independent AppID identities and never links equal OpenIDs or UnionIDs across merchants', async () => {
    const f = await fixture();
    f.a.codeSession.mockResolvedValueOnce({ openid: 'new-a', unionid: 'same-union' } as any);
    f.b.codeSession.mockResolvedValueOnce({ openid: 'new-a', unionid: 'same-union' } as any);
    const a = await f.login(f.first, 'a'), b = await f.login(f.second, 'b');
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.user).toMatchObject({ merchantId: 1, role: 'user' }); expect(b.user).toMatchObject({ merchantId: 2, role: 'user' });
    await expect(f.authenticate(f.second, a.token.accessToken)).rejects.toMatchObject({ status: 401 });
    expect(f.b.codeSession).toHaveBeenCalledWith('b');
  });
  it('accepts legacy credentials only for unchanged default-merchant accounts', async () => {
    const f = await fixture();
    const claims = jwt.decode(f.target.token.accessToken) as jwt.JwtPayload; delete claims.iid; delete claims.auth_version;
    const legacy = jwt.sign(claims, key, { algorithm: 'HS256' });
    await f.db.execute('DELETE FROM ar_user_wechat_identity WHERE user_id=2');
    expect((await f.authenticate(f.first, legacy)).user.id).toBe(2);
    expect(await f.db.query('SELECT * FROM ar_user_wechat_identity WHERE user_id=2')).toHaveLength(1);
    const b = await f.login(f.second, 'occupied');
    const otherClaims = jwt.decode(b.token.accessToken) as jwt.JwtPayload; delete otherClaims.iid; delete otherClaims.auth_version;
    await expect(f.authenticate(f.second, jwt.sign(otherClaims, key))).rejects.toMatchObject({ status: 401 });
    await f.db.execute('UPDATE ar_user SET auth_version=1 WHERE id=2');
    await expect(f.authenticate(f.first, legacy)).rejects.toMatchObject({ status: 401 });
  });
  it('completes a one-time assignment with stable account and historical order IDs, invalidating every old credential', async () => {
    const f = await fixture(), oldAdmin = await f.adminLogin(f.target.token.accessToken);
    await f.db.execute("INSERT INTO ar_rental_order(id,user_id,status,merchant_id,appid,payer_openid,mch_id) VALUES(1,2,'ENDED',1,?,'target','merchant-a')", [appA]);
    const request = await f.assign();
    expect(request.binding).toMatchObject({ merchantId: 2, appId: appB, origin: f.second.origin });
    expect((await f.db.one('SELECT merchant_id FROM ar_user WHERE id=2'))!.merchant_id).toBe(1);
    const moved = await f.login(f.second, 'new-target', request.binding.token);
    expect(moved.user).toMatchObject({ id: 2, role: 'adminer', merchantId: 2 });
    expect(moved.openid).toBe('new-target');
    expect((await f.db.one('SELECT * FROM ar_user WHERE id=2'))!).toMatchObject({ appid: appA, openid: 'target', merchant_id: 2, auth_version: 1 });
    expect((await f.db.one('SELECT * FROM ar_rental_order WHERE id=1'))!).toMatchObject({ user_id: 2, merchant_id: 1, appid: appA, payer_openid: 'target', mch_id: 'merchant-a' });
    expect(await f.db.query("SELECT * FROM ar_role_audit WHERE source='merchant-transfer'")).toMatchObject([{ merchant_id: 2, target_user_id: 2 }]);
    expect(await f.db.query('SELECT * FROM ar_merchant_audit')).toMatchObject([{ merchant_id: 2, previous_merchant_id: 1, target_id: 2, action: 'USER_TRANSFERRED' }]);
    await expect(f.authenticate(f.first, f.target.token.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(runWithMerchant(f.first, () => f.auth.refresh(f.target.token.refreshToken))).rejects.toMatchObject({ status: 401 });
    await expect(f.login(f.first, 'target')).rejects.toMatchObject({ status: 401 });
    await expect(runWithMerchant(f.first, () => f.route('GET', 'admin/auth/session')(f.ctx(f.first, undefined, {}, {}, oldAdmin.cookie)))).rejects.toMatchObject({ status: 401 });
    await expect(f.login(f.second, 'new-target', request.binding.token)).rejects.toMatchObject({ status: 409 });
    expect((await f.authenticate(f.second, moved.token.accessToken)).merchantId).toBe(2);
    const principal = await f.authenticate(f.second, moved.token.accessToken);
    expect(await runWithMerchant(f.second, () => f.phone.statusFor(principal))).toEqual({ verified: false });
    await runWithMerchant(f.second, () => f.phone.bind(principal, 'new-native-phone-code'));
    expect(await f.db.query('SELECT * FROM ar_user_phone_history')).toMatchObject([{ user_id: 2, appid: appA, identity_id: 2 }]);
    expect((await f.db.one('SELECT * FROM ar_user_phone WHERE user_id=2'))!).toMatchObject({ appid: appB, phone_e164: '+8613800138000' });
    expect((await f.adminLogin(moved.token.accessToken, f.second)).session).toMatchObject({ user: { id: 2, role: 'adminer' }, merchant: { id: 2 } });
  });
  it('requires root, explicit target login and an unoccupied target identity without automatic account merges', async () => {
    const f = await fixture();
    await expect(f.assign(undefined, f.target.token.accessToken)).rejects.toMatchObject({ status: 403 });
    const request = await f.assign();
    await expect(f.login(f.first, 'target', request.binding.token)).rejects.toMatchObject({ status: 403 });
    await expect(f.login(f.second, 'occupied', request.binding.token)).rejects.toMatchObject({ status: 409 });
    expect((await f.db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=2'))!).toEqual({ merchant_id: 1, auth_version: 0 });
    expect((await f.db.one('SELECT consumed_ms FROM ar_user_merchant_binding'))!.consumed_ms).toBeNull();
    f.advance(30 * 60_000);
    await expect(f.login(f.second, 'new', request.binding.token)).rejects.toMatchObject({ status: 409 });
  });
  it('requires the source account itself to confirm before any target identity can consume the invitation', async () => {
    const f = await fixture(), request = await f.assign(undefined, f.root.token.accessToken, false);
    await expect(f.login(f.second, 'new-target', request.binding.token)).rejects.toMatchObject({ status: 403 });
    await expect(f.confirmBinding(request.binding.token, f.root.token.accessToken)).rejects.toMatchObject({ status: 403 });
    const stranger = await f.login(f.first, 'stranger');
    await expect(f.confirmBinding(request.binding.token, stranger.token.accessToken)).rejects.toMatchObject({ status: 403 });
    const confirmed = await f.confirmBinding(request.binding.token);
    expect(confirmed.binding).toMatchObject({ merchantId: 2, appId: appB, origin: f.second.origin });
    expect(await f.confirmBinding(request.binding.token)).toEqual(confirmed);
    expect((await f.login(f.second, 'new-target', request.binding.token)).user.id).toBe(2);
  });
  it.each([
    { status: 'PENDING_PAYMENT', amount: 0, refund: null },
    { status: 'ACTIVE', amount: 0, refund: null },
    { status: 'COMPENSATING', amount: 100, refund: 'PROCESSING' },
    { status: 'ENDED', amount: 100, refund: 'ABNORMAL' },
  ])('rechecks unfinished business at assignment and final binding ($status/$refund)', async ({ status, amount, refund }) => {
    const f = await fixture(), request = await f.assign();
    await f.db.execute('INSERT INTO ar_rental_order(id,user_id,status,refund_amount_cents,refund_status) VALUES(1,2,?,?,?)', [status, amount, refund]);
    await expect(f.assign()).rejects.toMatchObject({ status: 409 });
    await expect(f.login(f.second, 'new', request.binding.token)).rejects.toMatchObject({ status: 409 });
    expect((await f.db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=2'))!).toEqual({ merchant_id: 1, auth_version: 0 });
    expect(await f.db.query("SELECT * FROM ar_user_wechat_identity WHERE user_id=2 AND status='active'")).toHaveLength(1);
  });
  it('lets root keep the original login session while selecting a different merchant and rejects non-root scope changes', async () => {
    const f = await fixture(), rootAdmin = await f.adminLogin(f.root.token.accessToken);
    const principal = await withMerchant({ entry: f.first, merchant: f.second }, () => f.auth.authenticate(f.ctx(f.first, undefined, {}, {}, rootAdmin.cookie)));
    expect(principal).toMatchObject({ appid: appA, openid: 'root', merchantId: 2, user: { id: 1, merchant_id: null } });
    const session = await withMerchant({ entry: f.first, merchant: f.second }, () => f.route('GET', 'admin/auth/session')(f.ctx(f.first, undefined, {}, {}, rootAdmin.cookie))) as Row;
    expect(session.merchant.id).toBe(2);
    await expect(withMerchant({ entry: f.first, merchant: f.second }, () => f.auth.authenticateBearer(f.ctx(f.first, f.target.token.accessToken)))).rejects.toMatchObject({ status: 403 });
    expect(rootAdmin.cookie).not.toContain('Domain=');
  });
  it('keeps disabled historical identities when moving back to an earlier merchant with a new OpenID', async () => {
    const f = await fixture(), firstRequest = await f.assign();
    await f.login(f.second, 'new-target-b', firstRequest.binding.token);
    const returnRequest = await f.assign({ merchantId: 1, role: 'manager', reason: '分配回第一商户并重新绑定微信身份' });
    const returned = await f.login(f.first, 'new-target-a', returnRequest.binding.token);
    expect(returned.user).toMatchObject({ id: 2, merchantId: 1, role: 'manager' });
    expect((await f.authenticate(f.first, returned.token.accessToken)).openid).toBe('new-target-a');
    await expect(f.login(f.first, 'target')).rejects.toMatchObject({ status: 401 });
    await expect(f.login(f.second, 'new-target-b')).rejects.toMatchObject({ status: 401 });
    expect(await f.db.query("SELECT * FROM ar_user_wechat_identity WHERE user_id=2 AND status='active'")).toHaveLength(1);
  });
  it('keeps existing paused-merchant identities and management sessions usable for historical business while refusing new registration', async () => {
    const f = await fixture(), session = await f.adminLogin(f.target.token.accessToken);
    f.first.status = 'paused';
    expect((await f.authenticate(f.first, f.target.token.accessToken)).user.role).toBe('manager');
    expect((await runWithMerchant(f.first, () => f.auth.refresh(f.target.token.refreshToken))).user.id).toBe(2);
    expect((await f.login(f.first, 'target')).user.id).toBe(2);
    const restored = await runWithMerchant(f.first, () => f.route('GET', 'admin/auth/session')(f.ctx(f.first, undefined, {}, {}, session.cookie))) as Row;
    expect(restored.user.role).toBe('manager');
    await expect(f.login(f.first, 'unregistered')).rejects.toMatchObject({ status: 403 });
    expect(await f.db.query("SELECT * FROM ar_user WHERE openid='unregistered'")).toHaveLength(0);
  });
  it('allows transfer after compensation has fully refunded while retaining the original order', async () => {
    const f = await fixture();
    await f.db.execute("INSERT INTO ar_rental_order(id,user_id,status,refund_amount_cents,refund_status,merchant_id) VALUES(1,2,'COMPENSATING',100,'SUCCESS',1)");
    const request = await f.assign();
    expect((await f.login(f.second, 'new-target', request.binding.token)).user.merchantId).toBe(2);
    expect((await f.db.one('SELECT merchant_id,status FROM ar_rental_order WHERE id=1'))!).toEqual({ merchant_id: 1, status: 'COMPENSATING' });
  });
  it('retains direct loopback admin development origins without trusting forwarded host or remote requests', async () => {
    const f = await fixture();
    const local = () => {
      const context = f.ctx(f.first);
      context.req.protocol = 'http'; context.req.headers.host = '127.0.0.1:3000'; context.req.headers.origin = 'http://127.0.0.1:3000';
      return context;
    };
    const context = local();
    const challenge = await runWithMerchant(f.first, () => f.route('POST', 'admin/auth/challenges')(context)) as Row;
    expect((await f.db.one('SELECT origin FROM ar_admin_login_challenge WHERE id=?', [challenge.id]))!.origin).toBe('http://127.0.0.1:3000');
    expect(context.res.append.mock.calls[0][1]).not.toContain('; Secure');
    const forwarded = local(); forwarded.req.headers['x-forwarded-host'] = 'evil.example.test';
    await expect(runWithMerchant(f.first, () => f.route('POST', 'admin/auth/challenges')(forwarded))).rejects.toMatchObject({ status: 403 });
    const remote = local(); remote.req.socket.remoteAddress = '192.0.2.1';
    await expect(runWithMerchant(f.first, () => f.route('POST', 'admin/auth/challenges')(remote))).rejects.toMatchObject({ status: 403 });
  });
  it('rolls back every transfer mutation on audit failure and allows a safe retry', async () => {
    const f = await fixture(), request = await f.assign();
    const insert = f.db.insert.bind(f.db);
    vi.spyOn(f.db, 'insert').mockImplementation(async (table, data) => {
      if (table === 'ar_role_audit') throw new Error('Synthetic transfer audit failure');
      return insert(table, data);
    });
    await expect(f.login(f.second, 'new-target', request.binding.token)).rejects.toThrow('Synthetic transfer audit failure');
    expect((await f.db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=2'))!).toEqual({ merchant_id: 1, auth_version: 0 });
    expect((await f.db.one('SELECT consumed_ms FROM ar_user_merchant_binding'))!.consumed_ms).toBeNull();
    expect((await f.authenticate(f.first, f.target.token.accessToken)).user.id).toBe(2);
    vi.mocked(f.db.insert).mockImplementation(insert);
    expect((await f.login(f.second, 'new-target', request.binding.token)).user.id).toBe(2);
  });
});
