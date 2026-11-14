import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { RentalAuth } from '../../src/auth';
import { bootstrapRootByPhone } from '../../src/auth/admin';
import { PhoneBinding } from '../../src/auth/phone';
import { Database } from '../../src/core/database';
import { migrate } from '../../src/core/migrations';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL ROOT_PHONE initial root concurrency', () => {
  it('initializes after verified binding and permits only one audited root across nodes and console competition', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
    const database = 'ar_root_phone_test_' + randomBytes(10).toString('hex');
    const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
    const control = await mysql.createConnection(settings);
    let db: Database | undefined, created = false;
    try {
      await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
      db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 16 }));
      await migrate(db);
      const appId = 'wx03dbf50c15cac06f', phone1 = '+8613800138000', phone2 = '+8613900139000';
      for (const id of [1, 2]) await db.insert('ar_user', { id, appid: appId, openid: 'synthetic-root-phone-' + id, role: 'user' });
      let phoneCalls = 0;
      const client = { config: { appId }, codeSession: async (code: string) => ({ openid: 'synthetic-root-phone-' + code }), phoneNumber: async () => { phoneCalls++; return { phoneE164: phone1, countryCode: '86' }; } };
      const makeAuth = (rootPhone: string) => new RentalAuth(db!, client as any, { jwtSecret: 'synthetic-root-phone-concurrency-signing-key-32-bytes', rootPhone });
      const first = makeAuth('+86 138 0013 8000'), login = await first.login('1');
      expect(login.user.role).toBe('user');
      const phone = new PhoneBinding(db, client as any, first);
      await phone.bind({ user: login.user, appid: appId, openid: login.openid }, 'synthetic-native-phone-code');
      expect((await first.login('1')).user.role).toBe('root');
      expect(phoneCalls).toBe(1);
      await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [2, appId, phone2, '86', Date.now(), '2'.repeat(64)]);
      const assertSingleAudit = async () => {
        const roots = await db!.query("SELECT id FROM ar_user WHERE role='root'");
        const audits = await db!.query('SELECT * FROM ar_role_audit');
        expect(roots).toHaveLength(1); expect(audits).toHaveLength(1);
        expect(Number(audits[0].target_user_id)).toBe(Number(roots[0].id));
        expect(JSON.stringify(audits)).not.toMatch(/13800138000|13900139000/);
        return audits[0];
      };
      expect(await assertSingleAudit()).toMatchObject({ source: 'env-root-bootstrap', previous_role: 'user', next_role: 'root' });
      const resetSyntheticRoles = async () => { await db!.execute("UPDATE ar_user SET role='user'"); await db!.execute('DELETE FROM ar_role_audit'); };

      await resetSyntheticRoles();
      const nodes = [makeAuth(phone1), makeAuth('13800138000')];
      const sameAccount = await Promise.all(Array.from({ length: 12 }, (_, index) => nodes[index % 2].login('1')));
      expect(sameAccount.map(value => value.user.role)).toEqual(Array(12).fill('root'));
      expect(await assertSingleAudit()).toMatchObject({ source: 'env-root-bootstrap', target_user_id: 1 });

      await resetSyntheticRoles();
      const competition = await Promise.allSettled([nodes[0].login('1'), bootstrapRootByPhone(db, phone2, appId)]);
      expect(competition[0].status).toBe('fulfilled');
      if (competition[1].status === 'rejected') expect(competition[1].reason).toMatchObject({ status: 409 });
      expect(['env-root-bootstrap', 'console-bootstrap']).toContain((await assertSingleAudit()).source);

      await resetSyntheticRoles();
      await Promise.all([makeAuth(phone1).login('1'), makeAuth(phone2).login('2')]);
      expect(await assertSingleAudit()).toMatchObject({ source: 'env-root-bootstrap' });

      await resetSyntheticRoles();
      const otherAppId = 'wx1111111111111111';
      await db.insert('ar_user', { id: 3, appid: otherAppId, openid: 'synthetic-cross-app-root', role: 'user' });
      await db.execute('INSERT INTO ar_user_phone (user_id,appid,phone_e164,country_code,verified_ms,code_hash) VALUES (?,?,?,?,?,?)', [3, otherAppId, phone1, '86', Date.now(), '3'.repeat(64)]);
      const otherClient = { config: { appId: otherAppId }, codeSession: async () => ({ openid: 'synthetic-cross-app-root' }) };
      const otherAuth = new RentalAuth(db, otherClient as any, { jwtSecret: 'synthetic-cross-app-root-signing-key-32-bytes', rootPhone: phone1 });
      await Promise.all([makeAuth(phone1).login('1'), otherAuth.login('cross-app')]);
      expect(await assertSingleAudit()).toMatchObject({ source: 'env-root-bootstrap' });

      await resetSyntheticRoles();
      await db.execute("CREATE TRIGGER synthetic_root_audit_failure BEFORE INSERT ON ar_role_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic audit failure'");
      await expect(makeAuth(phone1).login('1')).rejects.toMatchObject({ code: 'ER_SIGNAL_EXCEPTION' });
      expect(await db.query("SELECT id FROM ar_user WHERE role='root'")).toEqual([]);
      expect(await db.query('SELECT * FROM ar_role_audit')).toEqual([]);
      await db.execute('DROP TRIGGER synthetic_root_audit_failure');
      expect((await makeAuth(phone1).login('1')).user.role).toBe('root');
      expect(await assertSingleAudit()).toMatchObject({ source: 'env-root-bootstrap', target_user_id: 1 });
    } finally {
      await db?.close();
      if (created) await control.query(`DROP DATABASE ${database}`);
      await control.end();
    }
  });
});
