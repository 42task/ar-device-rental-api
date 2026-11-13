import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/application';
import { RentalAuth } from '../../src/auth';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';

async function withTestDatabase(check: (db: Database) => Promise<void>): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
  const database = 'ar_device_default_test_' + randomBytes(10).toString('hex');
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings);
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
    db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 4 }));
    await check(db);
  } finally {
    await db?.close();
    if (created) await control.query(`DROP DATABASE ${database}`);
    await control.end();
  }
}

async function sqlDefault(db: Database): Promise<unknown> {
  return (await db.one("SELECT COLUMN_DEFAULT AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ar_device' AND COLUMN_NAME='device_type'"))?.value;
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL device type defaults', () => {
  it('upgrades schema 3 without changing existing device types and remains idempotent', async () => {
    await withTestDatabase(async db => {
      // Recreate the released schema's device table and version marker before upgrading.
      await db.execute(await readFile(resolve('database/001-core.sql'), 'utf8'));
      await db.execute('CREATE TABLE ar_schema_meta (name varchar(64) NOT NULL PRIMARY KEY, version int NOT NULL) ENGINE=InnoDB');
      await db.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,3)', ['ar-device-rental-api']);
      await db.execute('INSERT INTO ar_device (uuid,name,device_type) VALUES (?,?,?),(?,?,?)', ['legacy-ios', 'Synthetic iOS device', 'ios', 'legacy-rokid', 'Synthetic Rokid device', 'rokid']);
      expect(await sqlDefault(db)).toBe('ios');
      await migrate(db);
      expect(Number((await db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']))!.version)).toBe(SCHEMA_VERSION);
      expect(await sqlDefault(db)).toBe('rokid studio2');
      expect(await db.query('SELECT uuid,device_type FROM ar_device ORDER BY uuid')).toEqual([{ uuid: 'legacy-ios', device_type: 'ios' }, { uuid: 'legacy-rokid', device_type: 'rokid' }]);
      await db.execute('INSERT INTO ar_device (uuid,name) VALUES (?,?)', ['sql-default', 'Synthetic SQL default device']);
      await migrate(db);
      expect(await sqlDefault(db)).toBe('rokid studio2');
      expect(await db.query('SELECT uuid,device_type FROM ar_device ORDER BY uuid')).toEqual([{ uuid: 'legacy-ios', device_type: 'ios' }, { uuid: 'legacy-rokid', device_type: 'rokid' }, { uuid: 'sql-default', device_type: 'rokid studio2' }]);
    });
  });

  it('uses the default in fresh databases and actual HTTP creation while retaining explicit types', async () => {
    await withTestDatabase(async db => {
      await migrate(db); await migrate(db);
      expect(await sqlDefault(db)).toBe('rokid studio2');
      const appId = 'wx03dbf50c15cac06f', openid = 'synthetic-device-default-manager';
      await db.insert('ar_user', { appid: appId, openid, role: 'manager' });
      const client = { config: { appId }, codeSession: async () => ({ openid }), isPaymentReady: () => false };
      const auth = new RentalAuth(db, client as any, { jwtSecret: 'synthetic-default-type-signing-key-at-least-32-bytes', rootPhone: '' });
      const { app } = createApplication({ db, client: client as any, auth });
      const bearer = 'Bearer ' + (await auth.login('synthetic-login-code')).token.accessToken;
      for (const [uuid, type] of [['http-default', undefined], ['http-explicit-ios', 'ios'], ['http-explicit-rokid', 'rokid']] as const) {
        const result = await request(app).post('/api/v2/rental/devices').set('Authorization', bearer).send({ uuid, ...(type === undefined ? {} : { type }) });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ created: true, device: { uuid, type: type ?? 'rokid studio2' } });
      }
      await migrate(db);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_device'))!.total)).toBe(3);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_rental_config'))!.total)).toBe(0);
    });
  });
});
