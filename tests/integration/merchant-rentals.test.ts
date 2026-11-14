import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database';
import type { Row, Services } from '../../src/core/contracts';
import { RentalService } from '../../src/rentals';
import type { RentalPrincipal } from '../../src/rentals/types';
import { runWithMerchant, type MerchantRuntime } from '../../src/merchants/context';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL merchant rental concurrency', () => {
  it('isolates competing reservations and recovers original-account refunds without releasing occupied devices early', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw Error('Use the dedicated localhost rental test instance.');
    const database = 'ar_merchant_rentals_' + randomBytes(8).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const admin = await mysql.createConnection(settings);
    let db: Database | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
      for (const file of ['001-core.sql', 'user-schema.sql', '002-rentals.sql']) {
        const sql = (await readFile('database/' + file, 'utf8')).replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
        for (const statement of sql) await db.execute(statement);
      }
      await db.execute('ALTER TABLE ar_user ADD COLUMN merchant_id int NULL DEFAULT 1, ADD COLUMN auth_version int NOT NULL DEFAULT 0');
      for (const table of ['ar_device', 'ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job']) await db.execute(`ALTER TABLE ${table} ADD COLUMN merchant_id int NOT NULL DEFAULT 1`);
      await db.execute('ALTER TABLE ar_rental_order ADD COLUMN payment_config_id int NULL DEFAULT 1');
      const appA = 'wx03dbf50c15cac06f', appB = 'wx1111111111111111';
      for (const [id, role, merchantId, appid] of [[1, 'user', 1, appA], [2, 'user', 1, appA], [3, 'manager', 1, appA], [11, 'user', 2, appB], [13, 'manager', 2, appB], [20, 'root', null, appA]] as const) {
        await db.insert('ar_user', { id, role, appid, merchant_id: merchantId, openid: 'synthetic-payer-' + id });
      }
      const deviceA = await db.insert('ar_device', { uuid: 'first-merchant-device', merchant_id: 1 });
      const deviceB = await db.insert('ar_device', { uuid: 'second-merchant-device', merchant_id: 2 });
      const provider = (appId: string, mchId: string) => {
        const orders = new Map<string, Row>(), refunds = new Map<string, Row>();
        let failRefund = false;
        const client = {
          config: { appId, mchId }, isPaymentReady: () => true, assertPaymentApplication() {},
          async order(input: Row) {
            orders.set(input.out_trade_no, { appid: appId, mchid: mchId, out_trade_no: input.out_trade_no, payer: { openid: input.openid }, amount: { total: input.amount, currency: 'CNY' }, trade_state: 'SUCCESS', transaction_id: 'synthetic-' + input.out_trade_no });
            return { appId, package: 'prepay_id=synthetic', timeStamp: '1794542400', nonceStr: 'synthetic', paySign: 'synthetic', signType: 'RSA' };
          },
          async payment(method: string, path: string, input?: Row): Promise<Row> {
            if (path.startsWith('/v3/pay/transactions/')) {
              const number = decodeURIComponent(path.split('/')[5].split('?')[0]);
              const row = orders.get(number);
              if (!row) throw Object.assign(Error('verified missing'), { providerCode: 'ORDER_NOT_EXIST' });
              return structuredClone(row);
            }
            if (method === 'POST' && path === '/v3/refund/domestic/refunds') {
              if (!refunds.has(input!.out_refund_no)) refunds.set(input!.out_refund_no, { out_trade_no: input!.out_trade_no, out_refund_no: input!.out_refund_no, refund_id: 'synthetic-' + input!.out_refund_no, amount: input!.amount, status: 'PROCESSING' });
              if (failRefund) { failRefund = false; throw Error('synthetic refund timeout after provider acceptance'); }
              return structuredClone(refunds.get(input!.out_refund_no)!);
            }
            const number = decodeURIComponent(path.split('/').at(-1)!);
            const row = refunds.get(number);
            if (!row) throw Object.assign(Error('verified missing'), { providerCode: 'RESOURCE_NOT_EXISTS' });
            return structuredClone(row);
          },
        };
        return { client, orders, refunds, timeoutNextRefund: () => { failRefund = true; } };
      };
      const first = provider(appA, 'synthetic-merchant-a'), second = provider(appB, 'synthetic-merchant-b');
      const merchantA: MerchantRuntime = { id: 1, code: 'a', name: 'A', status: 'active', origin: 'https://a.example', appId: appA, client: first.client as any, configId: 1 };
      const merchantB: MerchantRuntime = { id: 2, code: 'b', name: 'B', status: 'active', origin: 'https://b.example', appId: appB, client: second.client as any, configId: 2 };
      const principal = (id: number, role: string, merchant: MerchantRuntime): RentalPrincipal => ({ user: { id, role, merchant_id: role === 'root' ? null : merchant.id, auth_version: 0 }, appid: role === 'root' ? appA : merchant.appId, openid: 'synthetic-payer-' + id, merchantId: merchant.id, authVersion: 0 });
      const managerA = principal(3, 'manager', merchantA), managerB = principal(13, 'manager', merchantB), payerB = principal(11, 'user', merchantB);
      let now = Date.now();
      const options = { appId: appA, payment: first.client as any, authenticate: async () => managerA, now: () => now,
        resolvePaymentForOrder: async (row: Row) => {
          if (Number(row.payment_config_id) === 1 && Number(row.merchant_id) === 1) return first.client as any;
          if (Number(row.payment_config_id) === 2 && Number(row.merchant_id) === 2) return second.client as any;
          throw Error('wrong original merchant');
        } };
      const service = new RentalService({ db } as Services, options);
      await runWithMerchant(merchantA, () => service.configure(managerA, deviceA.id, { enabled: true, useFeeCents: 2000, depositCents: 8000, version: 0 }));
      await runWithMerchant(merchantB, () => service.configure(managerB, deviceB.id, { enabled: true, useFeeCents: 3000, depositCents: 9000, version: 0 }));
      const competing = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => runWithMerchant(merchantA, () => service.create(principal(index % 2 + 1, 'user', merchantA), { deviceId: deviceA.id, priceVersion: 1, idempotencyKey: 'merchant-concurrent-' + index }))));
      expect(competing.some(result => result.status === 'fulfilled')).toBe(true);
      expect(competing.some(result => result.status === 'rejected')).toBe(true);
      for (const result of competing) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
      const orderA = (await db.one('SELECT * FROM ar_rental_order WHERE merchant_id=1'))!;
      const payerA = principal(Number(orderA.user_id), 'user', merchantA);
      const createdB = await runWithMerchant(merchantB, () => service.create(payerB, { deviceId: deviceB.id, priceVersion: 1, idempotencyKey: 'independent-merchant-b' }));
      const orderB = (await db.one('SELECT * FROM ar_rental_order WHERE id=?', [createdB.rental.id]))!;
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_rental_slot'))!.total)).toBe(2);
      await expect(runWithMerchant(merchantB, () => service.get(managerB, orderA.id))).rejects.toMatchObject({ status: 404 });
      await expect(runWithMerchant(merchantB, () => service.create(payerB, { deviceId: deviceA.id, priceVersion: 1, idempotencyKey: 'wrong-merchant-reserve' }))).rejects.toMatchObject({ status: 409, code: 'MERCHANT_MISMATCH' });
      await runWithMerchant(merchantA, () => service.payment(payerA, orderA.id));
      await runWithMerchant(merchantB, () => service.payment(payerB, orderB.id));
      await Promise.all([runWithMerchant(merchantA, () => service.syncPayment(payerA, orderA.id)), runWithMerchant(merchantB, () => service.syncPayment(payerB, orderB.id))]);
      first.timeoutNextRefund();
      const settlement = { refundMode: 'deposit', reason: '合成并发归还', idempotencyKey: 'merchant-a-settlement' };
      const endings = await Promise.allSettled([
        runWithMerchant(merchantA, () => service.end(managerA, orderA.id, settlement)),
        runWithMerchant(merchantA, () => service.end(principal(20, 'root', merchantA), orderA.id, { ...settlement, refundMode: 'full', idempotencyKey: 'merchant-a-other-choice' })),
      ]);
      expect(endings.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of endings) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
      expect((await db.one('SELECT refund_status FROM ar_rental_order WHERE id=?', [orderA.id]))!.refund_status).toBe('PENDING');
      expect((await db.one('SELECT state FROM ar_rental_slot WHERE device_id=?', [deviceA.id]))!.state).toBe('SETTLING');
      await runWithMerchant(merchantA, () => service.retryRefund(managerA, orderA.id));
      expect(first.refunds.size).toBe(1);
      await runWithMerchant(merchantB, () => service.end(managerB, orderB.id, { ...settlement, idempotencyKey: 'merchant-b-settlement' }));
      expect(second.refunds.size).toBe(1);
      expect([...second.refunds.values()][0].amount).toEqual({ refund: 9000, total: 12000, currency: 'CNY' });
      merchantA.status = 'paused'; merchantB.status = 'paused';
      for (const refund of [...first.refunds.values(), ...second.refunds.values()]) refund.status = 'SUCCESS';
      const anotherWorker = new RentalService({ db } as Services, options);
      for (let pass = 0; pass < 2; pass++) { now += 60001; await Promise.all([service.processJobs(), anotherWorker.processJobs()]); }
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_rental_slot'))!.total)).toBe(0);
      expect(Number((await db.one("SELECT COUNT(*) AS total FROM ar_rental_event WHERE event='REFUND_SUCCESS'"))!.total)).toBe(2);
      expect((await db.query('SELECT merchant_id,refund_status FROM ar_rental_order ORDER BY merchant_id')).map(row => ({ merchantId: Number(row.merchant_id), refund: row.refund_status }))).toEqual([{ merchantId: 1, refund: 'SUCCESS' }, { merchantId: 2, refund: 'SUCCESS' }]);
    } finally {
      await db?.close();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  }, 30_000);
});
