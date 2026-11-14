import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Database } from '../../src/core/database';
import type { Row, Services } from '../../src/core/contracts';
import { RentalService } from '../../src/rentals';
import type { RentalPrincipal } from '../../src/rentals/types';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL rental occupancy and financial concurrency', () => {
  it('allows one device occupant and locks a single settlement choice for concurrent admins', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Rental concurrency requires the dedicated localhost test database configuration');
    const database = 'ar_rentals_test_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, dateStrings: true as const };
    const admin = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
      for (const file of ['001-core.sql', 'user-schema.sql', '002-rentals.sql']) {
        const schema = (await readFile('database/' + file, 'utf8')).replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
        for (const statement of schema) await db.execute(statement);
      }
      for (const [userId, role] of [[1, 'user'], [2, 'user'], [10, 'manager'], [11, 'root']] as const) {
        await db.insert('ar_user', { id: userId, role, appid: 'wx-rental-test', openid: 'payer-' + userId });
      }
      const device = await db.insert('ar_device', { uuid: 'rental-concurrent-device', name: '并发设备' });
      const refunds = new Map<string, Row>();
      let paidOrder: Row | null = null;
      const payment = {
        config: { appId: 'wx-rental-test', mchId: 'rental-merchant', serialNo: 'test-serial', privateKey: 'test-private', apiV3Key: 'test-api-key', platformKeys: { test: 'test-public' } },
        assertPaymentApplication() {},
        isPaymentReady() { return true; },
        async order(input: Row) {
          paidOrder = { out_trade_no: input.out_trade_no, appid: 'wx-rental-test', mchid: 'rental-merchant', payer: { openid: input.openid }, amount: { total: input.amount, currency: 'CNY' }, trade_state: 'SUCCESS', transaction_id: 'test-transaction-' + input.out_trade_no };
          return { appId: 'wx-rental-test', package: 'prepay_id=test', timeStamp: '1794542400', nonceStr: 'test-nonce', paySign: 'test-signature', signType: 'RSA' };
        },
        async payment(method: string, path: string, input?: Row) {
          if (path.startsWith('/v3/pay/transactions/')) return structuredClone(paidOrder!);
          if (method === 'POST' && path === '/v3/refund/domestic/refunds') {
            const number = input!.out_refund_no;
            if (!refunds.has(number)) refunds.set(number, { out_trade_no: input!.out_trade_no, out_refund_no: number, refund_id: 'test-refund-' + number, status: 'PROCESSING', amount: input!.amount });
            return structuredClone(refunds.get(number)!);
          }
          const number = decodeURIComponent(path.split('/').at(-1)!);
          return structuredClone(refunds.get(number)!);
        },
      };
      const principal = (id: number, role: string): RentalPrincipal => ({ user: { id, role }, appid: 'wx-rental-test', openid: 'payer-' + id });
      const manager = principal(10, 'manager'), root = principal(11, 'root');
      const options = { appId: 'wx-rental-test', authenticate: async () => manager, payment: payment as any };
      const services = { db } as Services;
      const service = new RentalService(services, options);
      await service.configure(manager, device.id, { enabled: true, useFeeCents: 2000, depositCents: 20000, version: 0 });
      const contenders = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => service.create(principal(index % 2 + 1, 'user'), {
        deviceId: device.id, priceVersion: 1, idempotencyKey: 'parallel-rental-' + index,
      })));
      const successes = contenders.filter(result => result.status === 'fulfilled').map(result => (result as PromiseFulfilledResult<Row>).value.rental);
      const failures = contenders.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
      expect(successes.length).toBeGreaterThan(0);
      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) expect(failure.reason).toMatchObject({ status: 409 });
      expect(new Set(successes.map(rental => rental.id)).size).toBe(1);
      expect((await db.one('SELECT COUNT(*) AS total FROM ar_rental_order'))!.total).toBe(1);
      expect((await db.one('SELECT COUNT(*) AS total FROM ar_rental_slot'))!.total).toBe(1);
      const stored = (await db.one('SELECT * FROM ar_rental_order'))!;
      const owner = principal(Number(stored.user_id), 'user');
      await service.payment(owner, stored.id);
      await service.syncPayment(owner, stored.id);
      expect(await service.get(owner, stored.id)).toMatchObject({ actions: { canEndRental: false, canSyncRefund: false, canRetryRefund: false } });
      for (const refundMode of ['deposit', 'full']) {
        await expect(service.end(owner, stored.id, { refundMode, reason: '普通用户本人申请', idempotencyKey: 'owner-end-' + refundMode })).rejects.toMatchObject({ status: 403 });
      }
      await expect(service.syncRefund(owner, stored.id)).rejects.toMatchObject({ status: 403 });
      await expect(service.retryRefund(owner, stored.id)).rejects.toMatchObject({ status: 403 });
      expect(refunds.size).toBe(0);
      await db.execute("UPDATE ar_user SET role='user' WHERE id=?", [manager.user.id]);
      expect((await service.context(manager, device.uuid)).actions.canEndRental).toBe(false);
      await expect(service.end(manager, stored.id, { refundMode: 'deposit', reason: '权限已撤销', idempotencyKey: 'revoked-manager-end' })).rejects.toMatchObject({ status: 403 });
      await db.execute("UPDATE ar_user SET role='manager' WHERE id=?", [manager.user.id]);
      const endings = await Promise.allSettled([
        service.end(manager, stored.id, { refundMode: 'deposit', reason: '归还确认', idempotencyKey: 'manager-end-request' }),
        service.end(root, stored.id, { refundMode: 'full', reason: '全部退还', idempotencyKey: 'root-end-request' }),
      ]);
      expect(endings.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(endings.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect((endings.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(refunds.size).toBe(1);
      const ended = (await db.one('SELECT * FROM ar_rental_order'))!;
      expect(ended).toMatchObject({ status: 'ENDED', refund_status: 'PROCESSING' });
      expect(Number(ended.refund_amount_cents)).toBe(ended.refund_mode === 'deposit' ? 20000 : 22000);
      expect((await service.context(owner, device.uuid)).state).toBe('SETTLING');
      await expect(service.syncRefund(owner, stored.id)).rejects.toMatchObject({ status: 403 });
      await db.execute("UPDATE ar_user SET role='user' WHERE id=?", [manager.user.id]);
      await expect(service.syncRefund(manager, stored.id)).rejects.toMatchObject({ status: 403 });
      await expect(service.retryRefund(manager, stored.id)).rejects.toMatchObject({ status: 403 });
      [...refunds.values()][0].status = 'SUCCESS';
      await service.syncRefund(root, stored.id);
      expect((await service.context(owner, device.uuid)).state).toBe('AVAILABLE');
      expect((await db.one('SELECT COUNT(*) AS total FROM ar_rental_slot'))!.total).toBe(0);
      await expect(db.execute('DELETE FROM ar_user WHERE id=?', [owner.user.id])).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
      // A device cannot be deleted while a new rental occupies it.
      await service.create(owner, { deviceId: device.id, priceVersion: 1, idempotencyKey: 'post-settlement-rental' });
      await expect(db.execute('DELETE FROM ar_device WHERE id=?', [device.id])).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
      // Two workers compete for the same persistent job and cancel only once.
      await db.execute("UPDATE ar_rental_order SET expires_ms=0 WHERE status='PENDING_PAYMENT'");
      await db.execute('UPDATE ar_rental_job SET available_ms=0');
      const otherWorker = new RentalService(services, options);
      await Promise.all([service.processJobs(), otherWorker.processJobs()]);
      expect((await db.one("SELECT COUNT(*) AS total FROM ar_rental_event WHERE event='LOCAL_ORDER_CANCELLED'"))!.total).toBe(1);
      expect((await db.one('SELECT COUNT(*) AS total FROM ar_rental_slot'))!.total).toBe(0);
    } finally {
      await db?.close();
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });
});
