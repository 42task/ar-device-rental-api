import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/core/database';
import type { Row } from '../src/core/contracts';
import type { RentalPrincipal } from '../src/auth';
import { ProfileService, profileNickname, registerProfile } from '../src/auth/profile';
import { MAX_AVATAR_BYTES, parseAvatarDataUrl } from '../src/core/images';
import { ApiRouter } from '../src/core/router';
import { withMerchant, type MerchantRuntime } from '../src/merchants/context';

const appId = 'wx03dbf50c15cac06f';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aDHsAAAAASUVORK5CYII=';
const opened: DatabaseSync[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
function fixture() {
  const sqlite = new DatabaseSync(':memory:'); opened.push(sqlite);
  sqlite.exec(`CREATE TABLE ar_user(id INTEGER PRIMARY KEY,appid TEXT,openid TEXT,nickname TEXT,avatar TEXT,role TEXT,auth_version INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO ar_user VALUES(1,'${appId}','owner','旧昵称',NULL,'user',0,NULL),(2,'${appId}','other','其他账号',NULL,'manager',0,NULL);
    CREATE TABLE ar_user_avatar(user_id INTEGER PRIMARY KEY,token TEXT UNIQUE,image_data BLOB,image_mime TEXT);
    CREATE TABLE ar_user_wechat_identity(id INTEGER PRIMARY KEY,user_id INTEGER,appid TEXT,openid TEXT,unionid TEXT,status TEXT);
    INSERT INTO ar_user_wechat_identity VALUES(10,1,'${appId}','owner',NULL,'active');
    CREATE TABLE ar_merchant_membership(user_id INTEGER PRIMARY KEY,merchant_id INTEGER,role TEXT,status TEXT,authorization_version INTEGER);`);
  const clean = (sql: string) => sql.replace(/ FOR UPDATE/g, '').replace(/CURRENT_TIMESTAMP\(3\)/g, 'CURRENT_TIMESTAMP');
  const db = {
    async query(sql: string, params: any[] = []) { return sqlite.prepare(clean(sql)).all(...params) as Row[]; },
    async one(sql: string, params: any[] = []) { return (await this.query(sql, params))[0] ?? null; },
    async execute(sql: string, params: any[] = []) { const result = sqlite.prepare(clean(sql)).run(...params); return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }; },
    async transaction<T>(run: (db: any) => Promise<T>) { sqlite.exec('BEGIN'); try { const result = await run(this); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const service = new ProfileService(db as unknown as Database);
  const principal = async (): Promise<RentalPrincipal> => ({ user: (await db.one('SELECT * FROM ar_user WHERE id=1'))!, appid: appId, openid: 'owner' });
  return { db, service, principal };
}

describe('self-service profile persistence', () => {
  it('saves only the authenticated account and preserves its avatar on later nickname edits', async () => {
    const f = fixture(), owner = await f.principal();
    const saved = await f.service.save(owner, { nickname: '  小明 👋  ', avatarDataUrl: png });
    expect(saved.user).toMatchObject({ id: 1, nickname: '小明 👋', role: 'user', avatar: expect.stringMatching(/^\/api\/v2\/rental\/profile\/avatars\/[a-f0-9]{64}$/) });
    const token = saved.user.avatar.split('/').at(-1);
    expect(await f.service.avatar(token)).toEqual(parseAvatarDataUrl(png));
    expect((await f.service.save(owner, { nickname: '新名字' })).user).toMatchObject({ nickname: '新名字', avatar: saved.user.avatar });
    expect(await f.db.one('SELECT nickname,avatar,role FROM ar_user WHERE id=2')).toEqual({ nickname: '其他账号', avatar: null, role: 'manager' });
    expect(await f.db.query('SELECT user_id FROM ar_user_avatar')).toEqual([{ user_id: 1 }]);
  });
  it('rejects identity, role and arbitrary URL injection without partially saving a nickname', async () => {
    const f = fixture(), owner = await f.principal();
    for (const fields of [{ id: 2 }, { userId: 2 }, { role: 'root' }, { avatar: 'https://example.test/a.png' }, { avatarUrl: 'https://example.test/a.png' }, { appid: appId }, { merchantId: 1 }]) {
      await expect(f.service.save(owner, { nickname: '注入', ...fields })).rejects.toMatchObject({ status: 422 });
    }
    await expect(f.service.save(owner, { nickname: '不能保存', avatarDataUrl: png.replace('image/png', 'image/jpeg') })).rejects.toMatchObject({ status: 422 });
    expect(await f.db.one('SELECT nickname,role FROM ar_user WHERE id=1')).toEqual({ nickname: '旧昵称', role: 'user' });
    expect(await f.db.query('SELECT * FROM ar_user_avatar')).toHaveLength(0);
  });
  it('invalidates replaced image URLs and rolls back avatar replacement when account persistence fails', async () => {
    const f = fixture(), owner = await f.principal();
    const first = await f.service.save(owner, { nickname: '第一次', avatarDataUrl: png });
    const firstToken = first.user.avatar.split('/').at(-1);
    const second = await f.service.save(owner, { nickname: '第二次', avatarDataUrl: png });
    const secondToken = second.user.avatar.split('/').at(-1);
    expect(secondToken).not.toBe(firstToken);
    await expect(f.service.avatar(firstToken)).rejects.toMatchObject({ status: 404 });
    const execute = f.db.execute.bind(f.db);
    vi.spyOn(f.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE ar_user SET')) throw Error('Synthetic database failure');
      return execute(sql, params);
    });
    await expect(f.service.save(owner, { nickname: '失败修改', avatarDataUrl: png })).rejects.toThrow('Synthetic database failure');
    expect(await f.db.one('SELECT nickname,avatar FROM ar_user WHERE id=1')).toEqual({ nickname: '第二次', avatar: second.user.avatar });
    expect((await f.service.avatar(secondToken)).data).toEqual(parseAvatarDataUrl(png).data);
  });
  it('rechecks authentication version, identity status and OpenID while the owner row is locked', async () => {
    const f = fixture(), owner = { ...await f.principal(), identityId: 10, authVersion: 0 };
    const entry = { id: 1, appId, status: 'active' } as MerchantRuntime;
    const save = () => withMerchant({ entry, merchant: entry }, () => f.service.save(owner, { nickname: '不能写入' }));
    await f.db.execute('UPDATE ar_user SET auth_version=1 WHERE id=1');
    await expect(save()).rejects.toMatchObject({ status: 401 });
    await f.db.execute('UPDATE ar_user SET auth_version=0 WHERE id=1');
    await f.db.execute("UPDATE ar_user_wechat_identity SET status='revoked' WHERE id=10");
    await expect(save()).rejects.toMatchObject({ status: 401 });
    await f.db.execute("UPDATE ar_user_wechat_identity SET status='active',openid='changed' WHERE id=10");
    await expect(save()).rejects.toMatchObject({ status: 401 });
    expect((await f.db.one('SELECT nickname FROM ar_user WHERE id=1'))!.nickname).toBe('旧昵称');
  });
  it('authenticates before profile writes and serves images without exposing account data', async () => {
    const f = fixture(), router = new ApiRouter();
    const authenticate = vi.fn(async () => { throw Object.assign(Error('请先登录'), { status: 401 }); });
    registerProfile(router, f.db as unknown as Database, { authenticate } as any);
    const write = router.routes.find(route => route.method === 'PATCH')!;
    await expect(write.handler({ body: { nickname: '匿名' } } as any)).rejects.toMatchObject({ status: 401 });
    expect(authenticate).toHaveBeenCalledOnce();
    const saved = await f.service.save(await f.principal(), { nickname: '展示', avatarDataUrl: png });
    const headers: Record<string, string> = {}, send = vi.fn();
    await router.routes.find(route => route.method === 'GET')!.handler({ params: { token: saved.user.avatar.split('/').at(-1) }, res: { setHeader: (name: string, value: string) => { headers[name] = value; }, send } } as any);
    expect(headers).toMatchObject({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    expect(send).toHaveBeenCalledWith(parseAvatarDataUrl(png).data);
  });
});

it('validates Unicode nickname length, image bytes and opaque image tokens', async () => {
  expect(profileNickname(' 😀 '.repeat(1))).toBe('😀');
  expect(profileNickname('😀'.repeat(32))).toBe('😀'.repeat(32));
  for (const value of ['', '   ', '😀'.repeat(33), 'bad\nname', '\u0085', null, 12]) expect(() => profileNickname(value)).toThrow();
  for (const value of [null, 'https://example.test/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', png.slice(0, -1), 'data:image/png;base64,' + Buffer.alloc(MAX_AVATAR_BYTES + 1).toString('base64')]) expect(() => parseAvatarDataUrl(value)).toThrow();
  const f = fixture();
  for (const token of ['1', '../private', 'A'.repeat(64), 'a'.repeat(64)]) await expect(f.service.avatar(token)).rejects.toMatchObject({ status: 404 });
});
