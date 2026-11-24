import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import request from '../http-client';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/application';
import { RentalAuth } from '../../src/auth';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION } from '../../src/core/migrations';
import { WeChatClient } from '../../src/payments/wechat';
import { seedVenue } from './venue-fixtures';

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

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL device registration and migrations', () => {
  it.each([3, 4])('upgrades schema %i without changing existing device types and remains idempotent', async previousVersion => {
    await withTestDatabase(async db => {
      // Recreate the released schema's device table and version marker before upgrading.
      await db.execute(await readFile(resolve('database/001-core.sql'), 'utf8'));
      if (previousVersion === 4) await db.execute((await readFile(resolve('database/005-device-type-default.sql'), 'utf8')).replace(/^\s*--.*$/gm, ''));
      await db.execute('CREATE TABLE ar_schema_meta (name varchar(64) NOT NULL PRIMARY KEY, version int NOT NULL) ENGINE=InnoDB');
      await db.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?)', ['ar-device-rental-api', previousVersion]);
      await db.execute('INSERT INTO ar_device (uuid,name,device_type) VALUES (?,?,?),(?,?,?),(?,?,?)', ['00000000-0000-4000-8000-000000000001', 'Synthetic iOS device', 'ios', '00000000-0000-4000-8000-000000000002', 'Synthetic Rokid device', 'rokid', '00000000-0000-4000-8000-000000000003', 'Synthetic Studio device', 'rokid studio2']);
      expect(await sqlDefault(db)).toBe(previousVersion === 3 ? 'ios' : 'rokid studio2');
      await migrate(db);
      expect(Number((await db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']))!.version)).toBe(SCHEMA_VERSION);
      expect(await sqlDefault(db)).toBe('Rokid Studio2');
      expect(await db.query('SELECT uuid,device_type FROM ar_device ORDER BY uuid')).toEqual([{ uuid: '00000000-0000-4000-8000-000000000001', device_type: 'ios' }, { uuid: '00000000-0000-4000-8000-000000000002', device_type: 'rokid' }, { uuid: '00000000-0000-4000-8000-000000000003', device_type: 'rokid studio2' }]);
      const venue = await seedVenue(db);
      await db.execute('INSERT INTO ar_device (uuid,name,venue_id) VALUES (?,?,?)', ['00000000-0000-4000-8000-000000000004', 'Synthetic SQL default device', venue.id]);
      await migrate(db);
      expect(await sqlDefault(db)).toBe('Rokid Studio2');
      expect(await db.query('SELECT uuid,device_type FROM ar_device ORDER BY uuid')).toEqual([{ uuid: '00000000-0000-4000-8000-000000000001', device_type: 'ios' }, { uuid: '00000000-0000-4000-8000-000000000002', device_type: 'rokid' }, { uuid: '00000000-0000-4000-8000-000000000003', device_type: 'rokid studio2' }, { uuid: '00000000-0000-4000-8000-000000000004', device_type: 'Rokid Studio2' }]);
    });
  });

  it.each([false, true])('upgrades schema 16 and preserves device data (column already added: %s)', async columnAlreadyAdded => {
    await withTestDatabase(async db => {
      await migrate(db);
      await db.execute('ALTER TABLE ar_device DROP COLUMN remark_name');
      await db.execute('DELETE FROM ar_schema_migration WHERE version>=17');
      await db.execute('UPDATE ar_schema_meta SET version=16 WHERE name=?', ['ar-device-rental-api']);

      const venue = await seedVenue(db);
      const previous = { uuid: '00000000-0000-4000-8000-000000000005', name: '原设备名称', venue_id: venue.id };
      await db.insert('ar_device', previous);
      if (columnAlreadyAdded) {
        await db.execute(await readFile(resolve('database/017-device-remark-name.sql'), 'utf8'));
      }

      await migrate(db);
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: SCHEMA_VERSION });
      expect(await db.one('SELECT uuid,name,venue_id,remark_name FROM ar_device')).toEqual({ ...previous, remark_name: '' });
      const applied = await db.one('SELECT checksum,applied_ms FROM ar_schema_migration WHERE version=17');
      expect(applied?.checksum).toMatch(/^[a-f0-9]{64}$/);

      await db.execute('UPDATE ar_device SET remark_name=? WHERE uuid=?', ['一楼备用机', previous.uuid]);
      await migrate(db);
      expect(await db.one('SELECT uuid,name,venue_id,remark_name FROM ar_device')).toEqual({ ...previous, remark_name: '一楼备用机' });
      expect(await db.one('SELECT checksum,applied_ms FROM ar_schema_migration WHERE version=17')).toEqual(applied);
    });
  });

  it.each(['schema 17', 'schema 18', 'constraints already applied'])('enforces optional, separately unique device identifiers from %s', async startingPoint => {
    await withTestDatabase(async db => {
      await migrate(db);
      await db.execute(`ALTER TABLE ar_device DROP CHECK chk_ar_device_identifier_present, DROP INDEX uq_ar_device_sn,
        DROP COLUMN sn, MODIFY COLUMN uuid varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`);
      await db.execute('DELETE FROM ar_schema_migration WHERE version>=18');
      await db.execute('UPDATE ar_schema_meta SET version=17 WHERE name=?', ['ar-device-rental-api']);

      const venue = await seedVenue(db);
      const legacy = { uuid: '00000000-0000-4000-8000-000000000006', name: '原设备名称', venue_id: venue.id };
      await db.execute('INSERT INTO ar_device (uuid,name,venue_id) VALUES (?,?,?)', [legacy.uuid, legacy.name, legacy.venue_id]);
      if (startingPoint !== 'schema 17') {
        await db.execute(await readFile(resolve('database/018-device-sn.sql'), 'utf8'));
      }
      if (startingPoint === 'schema 18') {
        const checksum = createHash('sha256').update(await readFile(resolve('database/018-device-sn.sql'))).digest('hex');
        await db.execute('INSERT INTO ar_schema_migration (version,checksum,applied_ms) VALUES (?,?,?)', [18, checksum, Date.now()]);
        await db.execute('UPDATE ar_schema_meta SET version=18 WHERE name=?', ['ar-device-rental-api']);
      }
      if (startingPoint === 'constraints already applied') {
        await db.execute(await readFile(resolve('database/019-device-identifiers.sql'), 'utf8'));
      }

      await migrate(db);
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: SCHEMA_VERSION });
      expect(await db.one('SELECT uuid,name,venue_id,sn FROM ar_device')).toEqual({ ...legacy, sn: null });
      const applied = await db.one('SELECT checksum,applied_ms FROM ar_schema_migration WHERE version=19');
      expect(applied?.checksum).toMatch(/^[a-f0-9]{64}$/);

      await db.insert('ar_device', { uuid: 'shared-identifier', venue_id: venue.id });
      await db.insert('ar_device', { sn: 'shared-identifier', venue_id: venue.id });
      await db.insert('ar_device', { sn: '000AbC123', venue_id: venue.id });
      const both = await db.insert('ar_device', { uuid: 'both-uuid', sn: 'both-sn', venue_id: venue.id });
      await expect(db.insert('ar_device', { uuid: 'shared-identifier', sn: 'new-sn', venue_id: venue.id }))
        .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await expect(db.insert('ar_device', { uuid: 'new-uuid', sn: 'shared-identifier', venue_id: venue.id }))
        .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await expect(db.execute('INSERT INTO ar_device (uuid,sn,venue_id) VALUES (NULL,NULL,?)', [venue.id]))
        .rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      await expect(db.execute('UPDATE ar_device SET uuid=NULL,sn=? WHERE id=?', ['   ', both.id]))
        .rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });

      await migrate(db);
      expect(await db.one('SELECT uuid,sn FROM ar_device WHERE sn=?', ['000AbC123'])).toEqual({ uuid: null, sn: '000AbC123' });
      expect(await db.one('SELECT checksum,applied_ms FROM ar_schema_migration WHERE version=19')).toEqual(applied);
    });
  });

  it('rolls back an SN backfill with conflicting identifiers, then retries without changing device IDs', async () => {
    await withTestDatabase(async db => {
      await migrate(db);
      const venue = await seedVenue(db);
      const first = await db.insert('ar_device', { uuid: '000Conflict', sn: 'other-sn', venue_id: venue.id });
      const second = await db.insert('ar_device', { uuid: '000Safe', venue_id: venue.id });
      const owner = await db.insert('ar_device', { sn: '000Safe', venue_id: venue.id });
      await db.execute('DELETE FROM ar_schema_migration WHERE version>=20');
      await db.execute('UPDATE ar_schema_meta SET version=19 WHERE name=?', ['ar-device-rental-api']);

      await expect(migrate(db)).rejects.toThrow('2 device(s) with conflicting SN assignments');
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: 19 });
      expect(await db.one('SELECT uuid,sn FROM ar_device WHERE id=?', [first.id])).toEqual({ uuid: '000Conflict', sn: 'other-sn' });
      expect(await db.one('SELECT uuid,sn FROM ar_device WHERE id=?', [second.id])).toEqual({ uuid: '000Safe', sn: null });

      await db.execute('UPDATE ar_device SET sn=? WHERE id=?', ['000Conflict', first.id]);
      await db.execute('UPDATE ar_device SET sn=? WHERE id=?', ['000Other', owner.id]);
      await migrate(db);
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: SCHEMA_VERSION });
      expect(await db.one('SELECT uuid,sn FROM ar_device WHERE id=?', [first.id])).toEqual({ uuid: null, sn: '000Conflict' });
      expect(await db.one('SELECT uuid,sn FROM ar_device WHERE id=?', [second.id])).toEqual({ uuid: null, sn: '000Safe' });
    });
  });

  it('uses the default in fresh databases and actual HTTP creation while retaining explicit types', async () => {
    await withTestDatabase(async db => {
      await migrate(db); await migrate(db);
      expect(await sqlDefault(db)).toBe('Rokid Studio2');
      expect((await db.one("SELECT DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ar_device' AND COLUMN_NAME='device_type'"))!.type).toBe('varchar');
      const appId = 'wx03dbf50c15cac06f', openid = 'synthetic-device-default-manager';
      const manager = await db.insert('ar_user', { appid: appId, openid, role: 'manager', merchant_id: 1, auth_version: 1 });
      await db.insert('ar_merchant_membership', { user_id: manager.id, merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
      const client = new WeChatClient({ appId, appSecret: 'synthetic-device-default-secret', payEnabled: false, allowEnvironmentFallback: false,
        fetch: async () => { throw Error('Device default integration must not contact WeChat.'); } });
      client.codeSession = async () => ({ openid });
      const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-default-type-signing-key-at-least-32-bytes', rootPhone: '' });
      const { app } = createApplication({ db, client: client, auth });
      const login = await request(app).post('/api/v2/rental/auth/login').send({ code: 'synthetic-login-code' });
      expect(login.status).toBe(200);
      const bearer = 'Bearer ' + login.body.data.token.accessToken;
      const venue = await seedVenue(db);
      const cases = [
        [undefined, 'Rokid Studio2'],
        ['ios', 'ios'],
        ['rokid', 'rokid'],
        ['rs2', 'Rokid Studio2'],
        ['Rokid Studio', 'Rokid Studio'],
        ['rokid studio2', 'Rokid Studio2'],
        ['Rokid Studio3', 'Rokid Studio3'],
        ['RS', 'Rokid Studio'],
        ['rs3', 'Rokid Studio3'],
        ['Custom Glasses', 'Custom Glasses'],
      ] as const;
      const testUuid = (index: number) => '00000000-0000-4000-8000-' + String(index + 101).padStart(12, '0');
      for (const [index, [type, expected]] of cases.entries()) {
        const uuid = testUuid(index);
        const result = await request(app).post('/api/v2/rental/devices').set('Authorization', bearer).send({ uuid, venueId: venue.id, ...(type === undefined ? {} : { type }) });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ created: true, device: { uuid, type: expected } });
      }
      const duplicate = await request(app).post('/api/v2/rental/devices').set('Authorization', bearer).send({ uuid: testUuid(1), type: 'rs2', venueId: venue.id });
      expect(duplicate.status).toBe(200);
      expect(duplicate.body).toMatchObject({ created: false, device: { uuid: testUuid(1), type: 'ios' } });
      const remarks = ['一楼备用机', '二楼备用机'];
      const concurrent = await Promise.all(remarks.map(remarkName => request(app).post('/api/v2/rental/devices').set('Authorization', bearer)
        .send({ uuid: testUuid(cases.length), type: 'rs2', venueId: venue.id, remarkName })));
      expect(concurrent.map(result => result.status)).toEqual([200, 200]);
      expect(concurrent.map(result => result.body.created).sort()).toEqual([false, true]);
      expect(concurrent[0].body.device).toEqual(concurrent[1].body.device);
      expect(concurrent[0].body.device.type).toBe('Rokid Studio2');
      const savedRemark = remarks[concurrent.findIndex(result => result.body.created)];
      const device = concurrent[0].body.device;
      expect(device.remarkName).toBe(savedRemark);
      const change = await request(app).patch(`/api/v2/rental/devices/${device.id}/remark`).set('Authorization', bearer).send({ remarkName: '未经授权的备注' });
      expect(change.status).toBe(403);
      expect(await db.one('SELECT remark_name FROM ar_device WHERE id=?', [device.id])).toEqual({ remark_name: savedRemark });
      await migrate(db);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_device'))!.total)).toBe(cases.length + 1);
      expect(Number((await db.one('SELECT COUNT(*) AS total FROM ar_rental_config'))!.total)).toBe(0);
    });
  });

  it('edits UUID and SN independently by ID and reports changes to the QR identifier', async () => {
    await withTestDatabase(async db => {
      await migrate(db);
      const appId = 'wx03dbf50c15cac06f', openid = 'synthetic-device-editor';
      const manager = await db.insert('ar_user', { appid: appId, openid, role: 'manager', merchant_id: 1, auth_version: 1 });
      await db.insert('ar_merchant_membership', { user_id: manager.id, merchant_id: 1, role: 'manager', status: 'active', authorization_version: 1, updated_ms: Date.now() });
      const client = new WeChatClient({ appId, appSecret: 'synthetic-device-editor-secret', payEnabled: false, allowEnvironmentFallback: false,
        fetch: async () => { throw Error('Device editor integration must not contact WeChat.'); } });
      client.codeSession = async () => ({ openid });
      const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-device-editor-signing-key-at-least-32-bytes', rootPhone: '' });
      const { app } = createApplication({ db, client, auth });
      const login = await request(app).post('/api/v2/rental/auth/login').send({ code: 'synthetic-editor-login' });
      expect(login.status).toBe(200);
      const bearer = 'Bearer ' + login.body.data.token.accessToken;

      const venue = await seedVenue(db);
      const originalUuid = '00000000-0000-4000-8000-000000000007';
      const takenUuid = '00000000-0000-4000-8000-000000000008';
      const updatedUuid = '00000000-0000-4000-8000-000000000009';
      const serialNumber = '0000123456789012';
      const takenSn = '0000123456789013';
      const details = { name: '设备原名', device_type: 'ios', remark_name: '原备注', venue_id: venue.id };
      const device = await db.insert('ar_device', { ...details, uuid: originalUuid });
      await db.insert('ar_device', { uuid: takenUuid, sn: takenSn, venue_id: venue.id });
      const patch = (fields: Record<string, unknown>) => request(app).patch('/api/v2/rental/devices/' + device.id)
        .set('Authorization', bearer).set('X-Merchant-Id', '1').send(fields);
      const read = () => db.one('SELECT name,device_type,remark_name,venue_id,uuid,sn FROM ar_device WHERE id=?', [device.id]);

      const both = await patch({ sn: serialNumber });
      expect(both.status).toBe(200);
      expect(both.body).toMatchObject({ device: { id: device.id, registeredUuid: originalUuid, sn: serialNumber }, requiresNewQr: false });
      expect(await read()).toEqual({ ...details, uuid: originalUuid, sn: serialNumber });

      const snOnly = await patch({ uuid: null });
      expect(snOnly.status).toBe(200);
      expect(snOnly.body).toMatchObject({ device: { id: device.id, uuid: serialNumber, registeredUuid: null, sn: serialNumber }, requiresNewQr: true });
      const qr = await request(app).get('/api/v2/rental/admin/devices/' + device.id + '/qrcode').set('Authorization', bearer).set('X-Merchant-Id', '1');
      expect(qr.status).toBe(200);
      expect(new URL(qr.body.url).searchParams.get('i')).toBe(serialNumber);

      expect((await patch({ sn: null, name: '未生效的新名称' })).status).toBe(422);
      expect((await patch({ uuid: takenUuid, name: '未生效的新名称' })).status).toBe(409);
      expect((await patch({ sn: takenSn })).status).toBe(409);
      expect(await read()).toEqual({ ...details, uuid: null, sn: serialNumber });

      const restoredUuid = await patch({ uuid: updatedUuid });
      expect(restoredUuid.status).toBe(200);
      expect(restoredUuid.body).toMatchObject({ device: { id: device.id, registeredUuid: updatedUuid, sn: serialNumber }, requiresNewQr: true });
      const uuidOnly = await patch({ sn: null });
      expect(uuidOnly.status).toBe(200);
      expect(uuidOnly.body).toMatchObject({ device: { id: device.id, registeredUuid: updatedUuid, sn: null }, requiresNewQr: false });
      expect(await read()).toEqual({ ...details, uuid: updatedUuid, sn: null });

      const editDetails = await patch({ name: '设备新名称', type: 'rs3' });
      expect(editDetails.status).toBe(200);
      expect(editDetails.body).toMatchObject({ device: { name: '设备新名称', type: 'Rokid Studio3' }, requiresNewQr: true });
      expect(await read()).toEqual({ ...details, name: '设备新名称', device_type: 'Rokid Studio3', uuid: updatedUuid, sn: null });

      const legacySn = '000LegacyEditor';
      await db.execute('UPDATE ar_device SET uuid=NULL,sn=? WHERE id=?', [legacySn, device.id]);
      expect((await patch({ sn: '000OtherEditor' })).status).toBe(422);
      expect((await patch({ uuid: serialNumber })).status).toBe(422);
      expect((await patch({ uuid: updatedUuid })).status).toBe(200);
      expect(await read()).toMatchObject({ uuid: updatedUuid, sn: legacySn });
    });
  }, 30_000);
});
