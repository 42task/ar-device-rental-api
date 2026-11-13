import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAuth } from '../src/admin/auth';
import { RentalAuth } from '../src/auth';
import { ApiRouter } from '../src/core/router';
import type { Database } from '../src/core/database';
import type { Row } from '../src/core/contracts';
import { WeChatClient } from '../src/payments/wechat';

const appId = 'wx03dbf50c15cac06f', origin = 'https://admin.example.test';
const opened: DatabaseSync[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });

async function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY,appid TEXT,openid TEXT,role TEXT,nickname TEXT,avatar TEXT,tel TEXT,unionid TEXT);
    INSERT INTO ar_user VALUES(1,'${appId}','manager-openid','manager',NULL,NULL,NULL,NULL),(2,'${appId}','ordinary-openid','user',NULL,NULL,NULL,NULL),(3,'${appId}','other-openid','manager',NULL,NULL,NULL,NULL);
    CREATE TABLE ar_user_phone(user_id INTEGER PRIMARY KEY,appid TEXT,phone_e164 TEXT,country_code TEXT,verified_ms INTEGER,code_hash TEXT UNIQUE,UNIQUE(appid,phone_e164));
    INSERT INTO ar_user_phone VALUES(1,'${appId}','+8613800138000','86',1800000000000,'${'a'.repeat(64)}'),(3,'${appId}','+8613900139000','86',1800000000000,'${'b'.repeat(64)}');
    CREATE TABLE ar_admin_login_challenge(id TEXT PRIMARY KEY,browser_hash TEXT,origin TEXT,confirmation_code TEXT,status TEXT,scanned_user_id INTEGER,created_ms INTEGER,expires_ms INTEGER,consumed_ms INTEGER,qrcode_image BLOB);
    CREATE TABLE ar_admin_session(id TEXT PRIMARY KEY,user_id INTEGER,appid TEXT,created_ms INTEGER,expires_ms INTEGER,revoked_ms INTEGER);`);
  const sql = (value: string) => value.replace(/ FOR UPDATE/g, '').replace(/^(DELETE FROM .*?) LIMIT 100$/, '$1');
  const db = {
    async query(query: string, values: any[] = []) { return sqlite.prepare(sql(query)).all(...values) as Row[]; },
    async one(query: string, values: any[] = []) { return (await this.query(query, values))[0] ?? null; },
    async execute(query: string, values: any[] = []) { const result = sqlite.prepare(sql(query)).run(...values); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async transaction<T>(operation: (tx: any) => Promise<T>): Promise<T> { sqlite.exec('BEGIN'); try { const result = await operation(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  let now = 1_800_000_000_000;
  const client = { config: { appId }, codeSession: vi.fn(async (code: string): Promise<Row> => ({ openid: code + '-openid' })), unlimitedCode: vi.fn(async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])) };
  const auth = new RentalAuth(db as unknown as Database, client as any, { jwtSecret: 'admin-test-signing-key-at-least-32-bytes', now: () => now });
  const admin = new AdminAuth(db as unknown as Database, client as any, auth, { publicOrigin: origin, now: () => now });
  auth.webAuthenticate = admin.authenticate;
  const router = new ApiRouter(); admin.register(router);
  const tokens: Record<string, string> = {};
  for (const name of ['manager', 'ordinary', 'other']) tokens[name] = (await auth.login(name)).token.accessToken;
  const ctx = (input: { cookie?: string; token?: string; source?: string | null; body?: Row; id?: string; method?: string } = {}) => ({
    req: { method: input.method || 'POST', protocol: 'https', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'admin.example.test', ...(input.source === null ? {} : { origin: input.source ?? origin }), ...(input.cookie ? { cookie: input.cookie } : {}), ...(input.token ? { authorization: 'Bearer ' + input.token } : {}) } },
    res: { setHeader: vi.fn(), append: vi.fn(), type: vi.fn().mockReturnThis(), end: vi.fn() }, body: input.body || {}, params: { id: input.id }, query: {},
  } as any);
  const route = (method: string, path: string) => router.routes.find(item => item.method === method && item.path === '/v2/rental/admin/auth' + path)!.handler;
  const invoke = (method: string, path: string, input: Parameters<typeof ctx>[0] = {}) => route(method, path)(ctx({ ...input, method })) as Promise<Row>;
  const cookieFrom = (context: ReturnType<typeof ctx>, name: string) => context.res.append.mock.calls.find((call: string[]) => call[1].startsWith(name + '='))[1].split(';')[0];
  const create = async () => {
    const context = ctx(); const challenge = await route('POST', '/challenges')(context) as Row;
    return { ...challenge, cookie: cookieFrom(context, 'ar_admin_browser'), context };
  };
  const approve = async (challenge: Row, name = 'manager') => {
    await invoke('POST', '/challenges/:id/scan', { id: challenge.id, token: tokens[name] });
    return invoke('POST', '/challenges/:id/confirm', { id: challenge.id, token: tokens[name], body: { approved: true } });
  };
  const consume = async (challenge: Row) => {
    const context = ctx({ id: challenge.id, cookie: challenge.cookie });
    const result = await route('POST', '/challenges/:id/consume')(context) as Row;
    return { result, context, cookie: cookieFrom(context, 'ar_admin_session') };
  };
  return { db, client, auth, admin, tokens, ctx, route, invoke, create, approve, consume, advance: (ms: number) => { now += ms; } };
}

describe('durable admin scan login', () => {
  it('requires browser Origin and binds status, image and consumption to an HttpOnly browser secret', async () => {
    const f = await fixture();
    for (const source of [null, 'https://evil.example.test', 'null']) await expect(f.invoke('POST', '/challenges', { source })).rejects.toMatchObject({ status: 403 });
    const c = await f.create();
    expect(c.id).toMatch(/^[a-f0-9]{32}$/); expect(c.confirmationCode).toMatch(/^\d{6}$/);
    expect(c.qrcodeUrl).toBe('/api/v2/rental/admin/auth/challenges/' + c.id + '/qrcode');
    expect(c.context.res.append.mock.calls[0][1]).toContain('HttpOnly; SameSite=Strict; Max-Age=300; Secure');
    expect((await f.db.one('SELECT * FROM ar_admin_login_challenge'))!.browser_hash).not.toBe(c.cookie.split('=')[1]);
    for (const path of ['/challenges/:id', '/challenges/:id/qrcode']) await expect(f.invoke('GET', path, { id: c.id })).rejects.toMatchObject({ status: 401 });
    await expect(f.invoke('GET', '/challenges/:id', { id: c.id, cookie: 'ar_admin_browser=' + 'a'.repeat(64) })).rejects.toMatchObject({ status: 401 });
    await f.invoke('GET', '/challenges/:id/qrcode', { id: c.id, cookie: c.cookie });
    await f.invoke('GET', '/challenges/:id/qrcode', { id: c.id, cookie: c.cookie });
    expect(f.client.unlimitedCode).toHaveBeenCalledTimes(1);
    expect(f.client.unlimitedCode).toHaveBeenCalledWith(c.id, 'release');
    await f.approve(c);
    await expect(f.invoke('POST', '/challenges/:id/consume', { id: c.id, cookie: c.cookie, source: null })).rejects.toMatchObject({ status: 403 });
    await expect(f.invoke('POST', '/challenges/:id/consume', { id: c.id })).rejects.toMatchObject({ status: 401 });
    const consumed = await f.consume(c);
    expect(consumed.result).toMatchObject({ user: { id: 1, role: 'manager' } });
    expect(JSON.stringify(consumed.result)).not.toMatch(/openid|token|secret/i);
    expect(consumed.context.res.append.mock.calls[0][1]).toContain('Max-Age=28800; Secure');
    expect(await f.invoke('GET', '/session', { cookie: consumed.cookie })).toEqual(consumed.result);
    await expect(f.consume(c)).rejects.toMatchObject({ status: 409 });
    expect(await f.db.query('SELECT * FROM ar_admin_session')).toHaveLength(1);
  });
  it('requires a manager Bearer, binds the scanner and requires explicit confirmation', async () => {
    const f = await fixture(), c = await f.create();
    await expect(f.invoke('POST', '/challenges/:id/scan', { id: c.id, token: f.tokens.ordinary })).rejects.toMatchObject({ status: 403 });
    await expect(f.invoke('POST', '/challenges/:id/confirm', { id: c.id, token: f.tokens.manager, body: { approved: true } })).rejects.toMatchObject({ status: 403 });
    const scanned = await f.invoke('POST', '/challenges/:id/scan', { id: c.id, token: f.tokens.manager });
    expect(scanned).toMatchObject({ status: 'scanned', origin, confirmationCode: c.confirmationCode });
    await expect(f.consume(c)).rejects.toMatchObject({ status: 409 });
    await expect(f.invoke('POST', '/challenges/:id/scan', { id: c.id, token: f.tokens.other })).rejects.toMatchObject({ status: 409 });
    await expect(f.invoke('POST', '/challenges/:id/confirm', { id: c.id, token: f.tokens.other, body: { approved: true } })).rejects.toMatchObject({ status: 403 });
    await expect(f.invoke('POST', '/challenges/:id/confirm', { id: c.id, token: f.tokens.manager, body: { approved: 'true' } })).rejects.toMatchObject({ status: 422 });
    await f.approve(c);
    expect(await f.approve(c)).toMatchObject({ status: 'confirmed' });
    const session = await f.consume(c);
    await expect(f.invoke('POST', '/challenges/:id/scan', { id: c.id, cookie: session.cookie })).rejects.toMatchObject({ status: 401 });
    expect(await f.invoke('POST', '/challenges/:id/scan', { id: c.id, token: f.tokens.manager })).toMatchObject({ status: 'consumed' });
    await expect(f.auth.authenticate(f.ctx({ cookie: session.cookie, token: 'invalid', method: 'GET' }))).rejects.toMatchObject({ status: 401 });
  });
  it('never grants a session for cancelled, expired or revoked-role challenges', async () => {
    const f = await fixture(), cancelled = await f.create();
    await f.invoke('POST', '/challenges/:id/scan', { id: cancelled.id, token: f.tokens.manager });
    await f.invoke('POST', '/challenges/:id/confirm', { id: cancelled.id, token: f.tokens.manager, body: { approved: false } });
    await expect(f.consume(cancelled)).rejects.toMatchObject({ status: 409 });
    const expired = await f.create(); await f.approve(expired); f.advance(300_000);
    expect(await f.invoke('GET', '/challenges/:id', { id: expired.id, cookie: expired.cookie })).toMatchObject({ status: 'expired' });
    await expect(f.consume(expired)).rejects.toMatchObject({ status: 410 });
    const revoked = await f.create(); await f.approve(revoked);
    await f.db.execute("UPDATE ar_user SET role='user' WHERE id=1");
    await expect(f.consume(revoked)).rejects.toMatchObject({ status: 403 });
    expect(await f.db.query('SELECT * FROM ar_admin_session')).toHaveLength(0);
  });
  it('rechecks roles on each session request and protects writes and logout with Origin', async () => {
    const f = await fixture(), c = await f.create(); await f.approve(c); const session = await f.consume(c);
    expect((await f.auth.authenticate(f.ctx({ cookie: session.cookie, method: 'GET', source: null }))).user.role).toBe('manager');
    await expect(f.auth.authenticate(f.ctx({ cookie: session.cookie, source: 'https://evil.example.test' }))).rejects.toMatchObject({ status: 403 });
    await expect(f.invoke('POST', '/logout', { cookie: session.cookie, source: null })).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_user SET role='user' WHERE id=1");
    await expect(f.invoke('GET', '/session', { cookie: session.cookie })).rejects.toMatchObject({ status: 403 });
    await f.db.execute("UPDATE ar_user SET role='root' WHERE id=1");
    expect((await f.invoke('GET', '/session', { cookie: session.cookie })).user.role).toBe('root');
    await f.invoke('POST', '/logout', { cookie: session.cookie });
    await expect(f.invoke('GET', '/session', { cookie: session.cookie })).rejects.toMatchObject({ status: 401 });
    const c2 = await f.create(); await f.approve(c2); const s2 = await f.consume(c2); f.advance(28_800_000);
    await expect(f.invoke('GET', '/session', { cookie: s2.cookie })).rejects.toMatchObject({ status: 401 });
  });
  it('allows only direct loopback origins when PUBLIC_ORIGIN is absent', async () => {
    const f = await fixture(); vi.stubEnv('PUBLIC_ORIGIN', '');
    const router = new ApiRouter(); new AdminAuth(f.db as any, f.client as any, f.auth).register(router);
    const create = router.routes.find(row => row.method === 'POST' && row.path.endsWith('/challenges'))!.handler;
    const local = f.ctx(); local.req.protocol = 'http'; local.req.headers.host = 'localhost:3200'; local.req.headers.origin = 'http://localhost:3200';
    expect(await create(local)).toHaveProperty('id');
    local.req.socket.remoteAddress = '192.0.2.1';
    await expect(create(local)).rejects.toMatchObject({ status: 503 });
  });
  it('cleans up old persisted image challenges and sessions while keeping recent status', async () => {
    const f = await fixture(), recent = await f.create(); await f.approve(recent); await f.consume(recent);
    await f.db.execute('UPDATE ar_admin_login_challenge SET expires_ms=? WHERE id=?', [1, recent.id]);
    await f.db.execute('UPDATE ar_admin_session SET expires_ms=?', [1]);
    const current = await f.create();
    expect(await f.db.query('SELECT * FROM ar_admin_login_challenge')).toMatchObject([{ id: current.id }]);
    expect(await f.db.query('SELECT * FROM ar_admin_session')).toHaveLength(0);
  });
  it('serves and persists the actual JPEG content type from the provider', async () => {
    const f = await fixture(), c = await f.create(), jpeg = Buffer.from([255, 216, 255, 224, 0, 255, 217]);
    f.client.unlimitedCode.mockResolvedValueOnce(jpeg);
    for (let attempt = 0; attempt < 2; attempt++) {
      const context = f.ctx({ id: c.id, cookie: c.cookie, method: 'GET' });
      await f.route('GET', '/challenges/:id/qrcode')(context);
      expect(context.res.type).toHaveBeenCalledWith('image/jpeg');
      expect(context.res.end).toHaveBeenCalledWith(jpeg);
    }
    expect(f.client.unlimitedCode).toHaveBeenCalledTimes(1);
  });
  it('requires verified phone provenance for scan, confirmation, consumption and existing sessions', async () => {
    const f = await fixture(), c = await f.create();
    await f.db.execute('DELETE FROM ar_user_phone WHERE user_id=1');
    await expect(f.invoke('POST', '/challenges/:id/scan', { id: c.id, token: f.tokens.manager })).rejects.toMatchObject({ status: 403, code: 'PHONE_VERIFICATION_REQUIRED' });
    await f.db.execute('INSERT INTO ar_user_phone VALUES(?,?,?,?,?,?)', [1, appId, '+8613800138000', '86', 1800000000000, 'a'.repeat(64)]);
    await f.invoke('POST', '/challenges/:id/scan', { id: c.id, token: f.tokens.manager });
    await f.db.execute('DELETE FROM ar_user_phone WHERE user_id=1');
    await expect(f.invoke('POST', '/challenges/:id/confirm', { id: c.id, token: f.tokens.manager, body: { approved: true } })).rejects.toMatchObject({ status: 403, code: 'PHONE_VERIFICATION_REQUIRED' });
    await f.db.execute('INSERT INTO ar_user_phone VALUES(?,?,?,?,?,?)', [1, appId, '+8613800138000', '86', 1800000000000, 'a'.repeat(64)]);
    await f.approve(c); await f.db.execute('DELETE FROM ar_user_phone WHERE user_id=1');
    await expect(f.consume(c)).rejects.toMatchObject({ status: 403, code: 'PHONE_VERIFICATION_REQUIRED' });
    await f.db.execute('INSERT INTO ar_user_phone VALUES(?,?,?,?,?,?)', [1, appId, '+8613800138000', '86', 1800000000000, 'a'.repeat(64)]);
    const session = await f.consume(c); await f.db.execute('DELETE FROM ar_user_phone WHERE user_id=1');
    await expect(f.invoke('GET', '/session', { cookie: session.cookie })).rejects.toMatchObject({ status: 403, code: 'PHONE_VERIFICATION_REQUIRED' });
  });
});

describe('WeChat admin login codes', () => {
  it('caches stable_token, shares concurrent requests and fixes page/version/check_path parameters', async () => {
    const calls: { url: string; body: Row }[] = [], png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const client = new WeChatClient({ appId, appSecret: 'synthetic-test-secret', fetch: async (input, init) => {
      const url = String(input), body = JSON.parse(init!.body as string); calls.push({ url, body });
      return url.endsWith('/stable_token') ? new Response(JSON.stringify({ access_token: 'synthetic-token-at-least-16-characters', expires_in: 7200 })) : new Response(png, { headers: { 'Content-Type': 'image/png' } });
    } });
    await Promise.all([client.unlimitedCode('a'.repeat(32)), client.unlimitedCode('b'.repeat(32), 'trial')]);
    expect(calls.filter(row => row.url.endsWith('/stable_token'))).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ appid: appId, grant_type: 'client_credential', force_refresh: false });
    expect(calls.filter(row => row.url.includes('/wxa/')).map(row => row.body)).toMatchObject([
      { scene: 'a'.repeat(32), page: 'pages/admin/login', check_path: true, env_version: 'release' },
      { scene: 'b'.repeat(32), page: 'pages/admin/login', check_path: false, env_version: 'trial' },
    ]);
    await expect(client.unlimitedCode('../bad')).rejects.toMatchObject({ status: 422 });
  });
  it('refreshes an invalid cached token once and never forwards provider errors', async () => {
    let tokens = 0, codes = 0;
    const client = new WeChatClient({ appId, appSecret: 'synthetic-test-secret', fetch: async input => {
      if (String(input).endsWith('/stable_token')) return new Response(JSON.stringify({ access_token: 'synthetic-test-token-' + ++tokens, expires_in: 7200 }));
      codes++; return new Response(JSON.stringify({ errcode: codes === 1 ? 40001 : 41030, errmsg: 'secret-provider-content' }));
    } });
    await expect(client.unlimitedCode('a'.repeat(32))).rejects.toMatchObject({ status: 503, message: '微信登录二维码生成失败，请确认小程序确认页已发布及版本配置' });
    expect(tokens).toBe(2); expect(codes).toBe(2);
  });
  it('accepts JPEG image bytes from WeChat as well as PNG bytes', async () => {
    const jpeg = Buffer.from([255, 216, 255, 224, 0, 255, 217]);
    const client = new WeChatClient({ appId, appSecret: 'synthetic-test-secret', fetch: async input => String(input).endsWith('/stable_token')
      ? new Response(JSON.stringify({ access_token: 'synthetic-test-token-12345', expires_in: 7200 }))
      : new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }) });
    expect(await client.unlimitedCode('a'.repeat(32), 'develop')).toEqual(jpeg);
  });
});
