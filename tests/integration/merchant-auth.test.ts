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
  it('assigns directly and retries once across nodes, rejecting unfinished orders without locking their rows', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const database = 'ar_merchant_auth_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 16 }));
      await migrate(db);
      const appA = 'wx03dbf50c15cac06f';
      await db.insert('ar_merchant', { id: 2, code: 'second', name: 'Synthetic second merchant', status: 'active', origin: 'https://d.4mr.cn', hostname: 'd.4mr.cn', app_id: appA, miniapp_owner_id: 1, created_ms: Date.now(), updated_ms: Date.now() });
      await db.insert('ar_user', { id: 1, appid: appA, openid: 'root', role: 'root', merchant_id: null });
      for (const id of [2, 3]) await db.insert('ar_user', { id, appid: appA, openid: 'target-' + id, role: 'manager', merchant_id: 1 });
      for (const id of [2, 3]) await db.insert('ar_merchant_membership', { user_id: id, merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
      const client = (appId: string) => ({ config: { appId }, codeSession: async (code: string) => ({ openid: code }) });
      const a = client(appA);
      const first: MerchantRuntime = { id: 1, code: 'default', name: 'Synthetic platform', origin: 'https://d.4mr.cn', appId: appA, status: 'active', configId: 1, client: a as any };
      const nodes = [0, 1].map(() => new RentalAuth(db!, a as any, { jwtSecret: 'synthetic-merchant-auth-integration-key-32-bytes' }));
      const routers = nodes.map(node => { const router = new ApiRouter(); node.registerAuth(router); return router; });
      const root = await runWithMerchant(first, () => nodes[0].login('root'));
      const oldTarget = await runWithMerchant(first, () => nodes[0].login('target-2'));
      const context = (id: number) => ({ req: { headers: { authorization: 'Bearer ' + root.token.accessToken } }, res: { setHeader: vi.fn() }, body: { merchantId: 2, role: 'adminer', reason: 'Synthetic explicit assignment' }, query: {}, params: { id: String(id) } } as any);
      const assign = (id: number, node = 0, changes: Row = {}) => {
        const ctx = context(id); ctx.body = { ...ctx.body, ...changes };
        return runWithMerchant(first, () => routers[node].routes.find(row => row.method === 'POST' && row.path === '/v2/rental/admin/users/:id/merchant')!.handler(ctx)) as Promise<Row>;
      };
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => assign(2, index % 2)));
      for (const result of results) {
        expect(result).toMatchObject({ user: { id: 2, merchantId: 2, role: 'adminer' }, merchant: { id: 2, appId: appA } });
        expect(result).not.toHaveProperty('binding');
      }
      expect((await db.one('SELECT merchant_id,auth_version,appid,openid FROM ar_user WHERE id=2'))!).toMatchObject({ merchant_id: 2, auth_version: 1, appid: appA, openid: 'target-2' });
      expect(await db.query("SELECT * FROM ar_user_wechat_identity WHERE user_id=2 AND status='active'")).toHaveLength(1);
      expect(await db.query("SELECT * FROM ar_role_audit WHERE source='merchant-transfer' AND target_user_id=2")).toHaveLength(1);
      expect(await db.query("SELECT * FROM ar_merchant_audit WHERE action='USER_TRANSFERRED' AND target_id=2")).toHaveLength(1);
      expect(await db.query('SELECT * FROM ar_user_merchant_binding')).toHaveLength(0);
      await expect(runWithMerchant(first, () => nodes[0].refresh(oldTarget.token.refreshToken))).rejects.toMatchObject({ status: 401 });
      expect((await runWithMerchant(first, () => nodes[1].login('target-2'))).user).toMatchObject({ id: 2, merchantId: 2, role: 'adminer' });

      // An order return can hold order -> user locks. Assignment holds the user
      // lock, so its conservative unfinished-business read must not lock order.
      await runWithMerchant(first, () => nodes[0].login('target-3'));
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
        await expect(Promise.race([assign(3, 1), deadline])).rejects.toMatchObject({ status: 409 });
      } finally { clearTimeout(timeout); release(); await holding; }
      expect((await db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=3'))!).toMatchObject({ merchant_id: 1, auth_version: 0 });
      expect((await db.one('SELECT merchant_id,role,status,authorization_version FROM ar_merchant_membership WHERE user_id=3'))!).toMatchObject({ merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1 });
      await db.execute("UPDATE ar_rental_order SET status='COMPENSATING',refund_amount_cents=100,refund_status='PROCESSING' WHERE id=?", [order.id]);
      await expect(assign(3)).rejects.toMatchObject({ status: 409 });
      await db.execute("UPDATE ar_rental_order SET refund_status='SUCCESS' WHERE id=?", [order.id]);
      await db.execute("CREATE TRIGGER synthetic_assignment_audit_failure BEFORE INSERT ON ar_role_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic assignment audit failure'");
      try { await expect(assign(3)).rejects.toThrow('Synthetic assignment audit failure'); }
      finally { await db.execute('DROP TRIGGER synthetic_assignment_audit_failure'); }
      expect(await db.one('SELECT merchant_id,auth_version FROM ar_user WHERE id=3')).toEqual({ merchant_id: 1, auth_version: 0 });
      expect(await db.one('SELECT merchant_id,authorization_version FROM ar_merchant_membership WHERE user_id=3')).toEqual({ merchant_id: 1, authorization_version: 1 });
      expect(await db.query("SELECT * FROM ar_role_audit WHERE target_user_id=3")).toHaveLength(0);
      expect((await assign(3, 1)).user).toMatchObject({ id: 3, role: 'adminer', merchantId: 2 });
      expect(await db.one('SELECT user_id,merchant_id,appid,payer_openid,status,refund_status FROM ar_rental_order WHERE id=?', [order.id])).toMatchObject({ user_id: 3, merchant_id: 1, appid: appA, payer_openid: 'target-3', status: 'COMPENSATING', refund_status: 'SUCCESS' });

      // Grants and revocations change authority without moving the person's
      // rental or releasing occupancy, even while payment/refund work remains.
      const consumer = await runWithMerchant(first, () => nodes[0].login('consumer-in-progress'));
      const occupiedDevice = await db.insert('ar_device', { uuid: 'synthetic-revoked-employee-device', name: 'Synthetic occupied device', device_type: 'ios', merchant_id: 1, venue_id: venue.id });
      const occupiedOrder = await db.insert('ar_rental_order', { device_id: occupiedDevice.id, device_uuid: occupiedDevice.uuid, device_name: occupiedDevice.name, user_id: consumer.user.id, appid: appA, payer_openid: 'consumer-in-progress', mch_id: '1234567890',
        use_fee_cents: 20, deposit_cents: 80, total_cents: 100, price_version: 1, status: 'ACTIVE', payment_status: 'SUCCESS', out_trade_no: randomBytes(16).toString('hex'), idempotency_key: 'synthetic-authority-change', expires_ms: now + 60000, created_ms: now, updated_ms: now, merchant_id: 1, payment_config_id: 1 });
      await db.insert('ar_rental_slot', { device_id: occupiedDevice.id, rental_id: occupiedOrder.id, state: 'ACTIVE', expires_ms: null });
      for (const [status, refundAmount, refundStatus, slotState] of [['ACTIVE', 0, null, 'ACTIVE'], ['COMPENSATING', 100, 'PROCESSING', 'REFUNDING']] as const) {
        await db.execute('UPDATE ar_rental_order SET status=?,refund_amount_cents=?,refund_status=? WHERE id=?', [status, refundAmount, refundStatus, occupiedOrder.id]);
        await db.execute('UPDATE ar_rental_slot SET state=? WHERE rental_id=?', [slotState, occupiedOrder.id]);
        const beforeOrder = await db.one('SELECT * FROM ar_rental_order WHERE id=?', [occupiedOrder.id]);
        const beforeSlot = await db.one('SELECT * FROM ar_rental_slot WHERE rental_id=?', [occupiedOrder.id]);
        const ordinary = await runWithMerchant(first, () => nodes[0].login('consumer-in-progress'));
        expect((await assign(consumer.user.id)).user).toMatchObject({ id: consumer.user.id, role: 'adminer', merchantId: 2 });
        await expect(runWithMerchant(first, () => nodes[1].refresh(ordinary.token.refreshToken))).rejects.toMatchObject({ status: 401 });
        expect(await db.one('SELECT * FROM ar_rental_order WHERE id=?', [occupiedOrder.id])).toEqual(beforeOrder);
        expect(await db.one('SELECT * FROM ar_rental_slot WHERE rental_id=?', [occupiedOrder.id])).toEqual(beforeSlot);
        const employee = await runWithMerchant(first, () => nodes[1].login('consumer-in-progress'));
        expect((await assign(consumer.user.id, 1, { role: 'user' })).user).toMatchObject({ id: consumer.user.id, role: 'user', merchantId: null });
        await expect(runWithMerchant(first, () => nodes[0].refresh(employee.token.refreshToken))).rejects.toMatchObject({ status: 401 });
        expect(await db.one('SELECT * FROM ar_rental_order WHERE id=?', [occupiedOrder.id])).toEqual(beforeOrder);
        expect(await db.one('SELECT * FROM ar_rental_slot WHERE rental_id=?', [occupiedOrder.id])).toEqual(beforeSlot);
        expect((await runWithMerchant(first, () => nodes[0].login('consumer-in-progress'))).user).toMatchObject({ role: 'user', merchantId: null });
      }
      expect(await db.one('SELECT auth_version FROM ar_user WHERE id=?', [consumer.user.id])).toEqual({ auth_version: 4 });
    } finally {
      await db?.close();
      if (created) await control.query(`DROP DATABASE ${database}`);
      await control.end();
    }
  }, 30_000);
});
