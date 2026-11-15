import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { RentalAuth } from '../../src/auth';
import { Database } from '../../src/core/database';
import { ApiRouter } from '../../src/core/router';
import { migrate } from '../../src/core/migrations';
import type { Row } from '../../src/core/contracts';
import { runWithMerchant, type MerchantRuntime } from '../../src/merchants/context';
import { seedVenue } from './venue-fixtures';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL explicit merchant account assignment', () => {
  it('consumes a transfer once across nodes and checks unfinished orders without locking their rows', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const database = 'ar_merchant_auth_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 16 }));
      await migrate(db);
      const appA = 'wx03dbf50c15cac06f', appB = 'wx0123456789abcdef';
      await db.insert('ar_merchant', { id: 2, code: 'second', name: 'Synthetic second merchant', status: 'active', origin: 'https://d1.example.test', hostname: 'd1.example.test', app_id: appB, created_ms: Date.now(), updated_ms: Date.now() });
      await db.insert('ar_user', { id: 1, appid: appA, openid: 'root', role: 'root', merchant_id: null });
      for (const id of [2, 3]) await db.insert('ar_user', { id, appid: appA, openid: 'target-' + id, role: 'manager', merchant_id: 1 });
      for (const id of [2, 3]) await db.insert('ar_merchant_membership', { user_id: id, merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
      const client = (appId: string) => ({ config: { appId }, codeSession: async (code: string) => ({ openid: code }) });
      const a = client(appA), b = client(appB);
      const runtime = (id: number, appId: string, payment: any): MerchantRuntime => ({ id, code: id === 1 ? 'default' : 'second', name: '商户' + id, origin: id === 1 ? 'https://d.4mr.cn' : 'https://d1.example.test', appId, status: 'active', configId: id, client: payment });
      const first = runtime(1, appA, a), second = runtime(2, appB, b);
      const nodes = [0, 1].map(() => new RentalAuth(db!, a as any, { jwtSecret: 'synthetic-merchant-auth-integration-key-32-bytes' }));
      const router = new ApiRouter(); nodes[0].registerAuth(router);
      const root = await runWithMerchant(first, () => nodes[0].login('root'));
      const oldTarget = await runWithMerchant(first, () => nodes[0].login('target-2'));
      const context = (id: number) => ({ req: { headers: { authorization: 'Bearer ' + root.token.accessToken } }, res: { setHeader: vi.fn() }, body: { merchantId: 2, role: 'adminer', reason: 'Synthetic explicit assignment' }, query: {}, params: { id: String(id) } } as any);
      const assign = (id: number) => runWithMerchant(first, () => router.routes.find(row => row.method === 'POST' && row.path === '/v2/rental/admin/users/:id/merchant')!.handler(context(id))) as Promise<Row>;
      const confirm = async (id: number, request: Row) => {
        const login = await runWithMerchant(first, () => nodes[0].login('target-' + id));
        const ctx = context(id); ctx.req.headers.authorization = 'Bearer ' + login.token.accessToken; ctx.body = { bindToken: request.binding.token };
        return runWithMerchant(first, () => router.routes.find(row => row.method === 'POST' && row.path === '/v2/rental/auth/merchant-binding/confirm')!.handler(ctx));
      };
      const request = await assign(2);
      await confirm(2, request);
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => runWithMerchant(second, () => nodes[index % 2].login('new-target-2', request.binding.token))));
      const successes = results.filter(value => value.status === 'fulfilled');
      expect(successes).toHaveLength(1);
      expect((successes[0] as PromiseFulfilledResult<Row>).value.user).toMatchObject({ id: 2, merchantId: 2, role: 'adminer' });
      for (const result of results.filter(value => value.status === 'rejected') as PromiseRejectedResult[]) expect(result.reason).toMatchObject({ status: 409 });
      expect((await db.one('SELECT merchant_id,auth_version,appid,openid FROM ar_user WHERE id=2'))!).toMatchObject({ merchant_id: 2, auth_version: 1, appid: appA, openid: 'target-2' });
      expect(await db.query("SELECT * FROM ar_user_wechat_identity WHERE user_id=2 AND status='active'")).toHaveLength(1);
      expect(await db.query("SELECT * FROM ar_role_audit WHERE source='merchant-transfer' AND target_user_id=2")).toHaveLength(1);
      await expect(runWithMerchant(first, () => nodes[0].refresh(oldTarget.token.refreshToken))).rejects.toMatchObject({ status: 401 });

      // An order return can hold order -> user locks. Assignment holds the user
      // lock, so its conservative unfinished-business read must not lock order.
      await runWithMerchant(first, () => nodes[0].login('target-3'));
      const blocked = await assign(3);
      await confirm(3, blocked);
      const venue = await seedVenue(db);
      const device = await db.insert('ar_device', { uuid: 'synthetic-merchant-auth-device', name: 'Synthetic device', device_type: 'ios', merchant_id: 1, venue_id: venue.id });
      const now = Date.now();
      const order = await db.insert('ar_rental_order', { device_id: device.id, device_uuid: device.uuid, device_name: device.name, user_id: 3, appid: appA, payer_openid: 'target-3', mch_id: '1234567890',
        use_fee_cents: 20, deposit_cents: 80, total_cents: 100, price_version: 1, status: 'ACTIVE', payment_status: 'SUCCESS', out_trade_no: randomBytes(16).toString('hex'), idempotency_key: 'synthetic-integration', expires_ms: now + 60000, created_ms: now, updated_ms: now, merchant_id: 1, payment_config_id: 1 });
      let release!: () => void, locked!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const holding = db.transaction(async tx => { await tx.one('SELECT id FROM ar_rental_order WHERE id=? FOR UPDATE', [order.id]); locked(); await released; });
      await ready;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Assignment waited for a locked order')), 2000); });
        await expect(Promise.race([runWithMerchant(second, () => nodes[1].login('new-target-3', blocked.binding.token)), deadline])).rejects.toMatchObject({ status: 409 });
      } finally { clearTimeout(timeout); release(); await holding; }
      expect((await db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=3'))!).toMatchObject({ merchant_id: 1, auth_version: 0 });
      expect((await db.one('SELECT consumed_ms FROM ar_user_merchant_binding WHERE user_id=3'))!.consumed_ms).toBeNull();
    } finally {
      await db?.close();
      if (created) await control.query(`DROP DATABASE ${database}`);
      await control.end();
    }
  });
});
