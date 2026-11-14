import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import request from '../http-client';
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/application';
import { PhoneBinding } from '../../src/auth/phone';
import { bootstrapRootByPhone, findUserByVerifiedPhone } from '../../src/auth/admin';
import { RentalAuth } from '../../src/auth';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import type { RentalPrincipal } from '../../src/auth';
import type { Row } from '../../src/core/contracts';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL verified phone binding and console identity', () => {
  it('serializes same-user authorization, protects unique phones and bootstraps only verified ownership', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const database = 'ar_phone_test_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 12 }));
      await migrate(db); await migrate(db);
      expect(Number((await db.one('SELECT version FROM ar_schema_meta'))!.version)).toBe(SCHEMA_VERSION);
      const appId = 'wx03dbf50c15cac06f';
      for (const id of [1, 2, 3, 4, 5]) await db.insert('ar_user', { id, appid: appId, openid: 'synthetic-phone-user-' + id, role: id === 3 ? 'manager' : 'user', tel: id === 5 ? '+8613700137000' : null });
      await db.insert('ar_merchant_membership', { user_id: 3, merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
      const principals = await Promise.all([1, 2, 3, 4, 5].map(async id => ({ user: (await db!.one('SELECT * FROM ar_user WHERE id=?', [id]))!, appid: appId, openid: 'synthetic-phone-user-' + id } as RentalPrincipal)));
      const providerCalls: string[] = [];
      const client = { config: { appId }, codeSession: async (code: string) => ({ openid: 'synthetic-phone-user-' + code }), isPaymentReady: () => false, phoneNumber: async (code: string) => {
        providerCalls.push(code);
        return { phoneE164: code === 'single-use-owner3' ? '+8613900139000' : '+8613800138000', countryCode: '86' };
      } };
      const auth = new RentalAuth(db, client as any, { jwtSecret: 'synthetic-phone-integration-signing-key-32-bytes' });
      const nodes = [new PhoneBinding(db, client as any, auth), new PhoneBinding(db, client as any, auth)];
      const competition = await Promise.allSettled([nodes[0].bind(principals[0], 'owner1-code'), nodes[1].bind(principals[1], 'owner2-code')]);
      expect(competition.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      expect((competition.find(value => value.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_user_phone'))!.total)).toBe(1);
      expect(await db.query("SELECT role FROM ar_user WHERE id IN (1,2) AND role<>'user'")).toHaveLength(0);
      const sameUser = await Promise.all(Array.from({ length: 8 }, (_, index) => nodes[index % 2].bind(principals[2], 'single-use-owner3')));
      expect(sameUser).toEqual(Array.from({ length: 8 }, () => sameUser[0]));
      expect(providerCalls.filter(code => code === 'single-use-owner3')).toHaveLength(1);
      expect((await db.one('SELECT role,tel FROM ar_user WHERE id=3'))!).toMatchObject({ role: 'manager', tel: null });
      const { app } = createApplication({ db, client: client as any, auth });
      const webAuthenticate = vi.fn(async () => principals[2]); auth.webAuthenticate = webAuthenticate;
      const phonePath = '/api/v2/rental/auth/phone', cookie = 'ar_admin_session=' + 'a'.repeat(64);
      expect((await request(app).get(phonePath)).status).toBe(401);
      expect((await request(app).get(phonePath).set('Cookie', cookie)).status).toBe(401);
      const callsBeforeHttp = providerCalls.length;
      expect((await request(app).post(phonePath).set('Cookie', cookie).send({ code: 'cookie-only-code' })).status).toBe(401);
      expect(webAuthenticate).not.toHaveBeenCalled();
      const bearer = 'Bearer ' + (await auth.login('3')).token.accessToken;
      for (const extra of [{ tel: '+8613900139000' }, { userId: 4 }, { role: 'root' }, { appid: appId }]) {
        expect((await request(app).post(phonePath).set('Authorization', bearer).send({ code: 'single-use-owner3', ...extra })).status).toBe(422);
      }
      const phoneHttp = await request(app).post(phonePath).set('Authorization', bearer).send({ code: 'single-use-owner3' });
      expect(phoneHttp.status).toBe(200); expect(phoneHttp.body).toEqual(sameUser[0]);
      expect(JSON.stringify(phoneHttp.body)).not.toContain('13900139000');
      expect(providerCalls).toHaveLength(callsBeforeHttp);
      const before = providerCalls.length;
      await expect(nodes[0].bind(principals[3], 'single-use-owner3')).rejects.toMatchObject({ status: 409 });
      expect(providerCalls).toHaveLength(before);
      await expect(findUserByVerifiedPhone(db, '+8613700137000', appId)).rejects.toMatchObject({ status: 404 });
      await expect(bootstrapRootByPhone(db, '+8613700137000', appId)).rejects.toMatchObject({ status: 404 });
      const runConsole = (command: string, phone: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
        const child = spawn(process.execPath, [resolve('dist/scripts/admin.js'), command, '--phone-stdin'], { cwd: process.cwd(), env: { ...process.env, MYSQL_DATABASE: database, WECHAT_APP_ID: appId }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
        child.on('error', reject); child.on('close', code => done({ code, stdout, stderr })); child.stdin.end(phone + '\n');
      });
      const found = await runConsole('find-user-by-phone', '13900139000');
      expect(found.code).toBe(0); expect(JSON.parse(found.stdout)).toEqual({ maskedNumber: '+86 139****9000', role: 'manager' });
      expect(found.stdout + found.stderr).not.toMatch(/13900139000|userId|synthetic-phone-user/);
      const initialized = await runConsole('bootstrap-root', '+8613900139000');
      expect(initialized.code).toBe(0); expect(JSON.parse(initialized.stdout)).toEqual({ maskedNumber: '+86 139****9000', role: 'root' });
      expect(initialized.stdout + initialized.stderr).not.toContain('13900139000');
      const repeated = await runConsole('bootstrap-root', '+8613900139000');
      expect(repeated.code).toBe(1); expect(repeated.stderr).toContain('系统已有 root');
      expect(repeated.stdout + repeated.stderr).not.toContain('13900139000');
      const failedLegacy = await runConsole('find-user-by-phone', '13700137000');
      expect(failedLegacy.code).toBe(1); expect(failedLegacy.stdout + failedLegacy.stderr).not.toContain('13700137000');
      const audits = await db.query('SELECT * FROM ar_role_audit');
      expect(audits).toMatchObject([{ target_user_id: 3, previous_role: 'manager', next_role: 'root', source: 'console-bootstrap' }]);
      expect(JSON.stringify(audits)).not.toContain('13900139000');
      expect(Number((await db.one("SELECT COUNT(*) AS total FROM ar_user WHERE role='root'"))!.total)).toBe(1);
      await migrate(db); expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_user_phone'))!.total)).toBe(2);
    } finally {
      await db?.close();
      if (created) await control.query(`DROP DATABASE ${database}`);
      await control.end();
    }
  });
});
