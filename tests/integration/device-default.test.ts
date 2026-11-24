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
import { MerchantRegistry } from '../../src/merchants/registry';
import { MerchantSecrets } from '../../src/merchants/secrets';
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

async function restoreSchema22(db: Database): Promise<void> {
  await db.execute(`ALTER TABLE ar_rental_order DROP CHECK chk_ar_rental_order_identifier_present,
    DROP COLUMN device_sn, MODIFY COLUMN device_uuid varchar(255) NOT NULL`);
  await db.execute('DELETE FROM ar_schema_migration WHERE version>=23');
  await db.execute('UPDATE ar_schema_meta SET version=22 WHERE name=?', ['ar-device-rental-api']);
}

async function restoreSchema21(db: Database): Promise<void> {
  await restoreSchema22(db);
  await db.execute('DROP TABLE ar_device_retired_identifier');
  await db.execute(`ALTER TABLE ar_device
    DROP INDEX uq_ar_device_current_uuid, DROP INDEX uq_ar_device_current_sn, DROP INDEX ix_ar_device_current_sn_uuid,
    DROP COLUMN current_uuid, DROP COLUMN current_sn, DROP COLUMN current_sn_uuid, DROP COLUMN superseded,
    ADD UNIQUE KEY uuid(uuid), ADD UNIQUE KEY uq_ar_device_sn(sn)`);
  await db.execute('DELETE FROM ar_schema_migration WHERE version=22');
  await db.execute('UPDATE ar_schema_meta SET version=21 WHERE name=?', ['ar-device-rental-api']);
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
      await restoreSchema21(db);
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
      await restoreSchema21(db);
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

  it('retains released migration checksums and stops before replacing indexes when UUID case conflicts exist', async () => {
    await withTestDatabase(async db => {
      await migrate(db);
      await restoreSchema21(db);
      const venue = await seedVenue(db);
      const uuid = '12345678-1234-4123-8123-abcdefabcdef';
      const upper = await db.insert('ar_device', { uuid: uuid.toUpperCase(), venue_id: venue.id });
      const lower = await db.insert('ar_device', { uuid, venue_id: venue.id });
      const journal = 'SELECT version,checksum FROM ar_schema_migration WHERE version BETWEEN 18 AND 21 ORDER BY version';
      const released = [
        '289d596d7b0085b9bb01d389e241bec112ac041c90b765e900ba197928f8e056',
        '150c1529e68a69585937a45024a2855e29800442f7e30f9466de9bef2a69ae9c',
        '3dd9dd8592d83ed4a1e85e7e105feea0311eb16a41ed04100385e35a59c4a3c3',
        '601302456e2998a1a1e22838c9bc4c534e3955d85c3f874f09aec9a7d90d43b0',
      ];
      expect((await db.query(journal)).map(row => row.checksum)).toEqual(released);
      await expect(migrate(db)).rejects.toThrow('Device UUIDs differ only by case');
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: 21 });
      expect(await db.one("SHOW INDEX FROM ar_device WHERE Key_name='uuid'")).toBeTruthy();

      await db.execute('UPDATE ar_device SET uuid=? WHERE id=?', ['12345678-1234-4123-8123-abcdefabcdee', lower.id]);
      await migrate(db);
      // Resume after a completed ALTER whose journal transaction did not commit.
      await restoreSchema22(db);
      await db.execute('DELETE FROM ar_schema_migration WHERE version=22');
      await db.execute('UPDATE ar_schema_meta SET version=21');
      await migrate(db);
      expect(await db.one('SELECT id,uuid,current_uuid FROM ar_device WHERE current_uuid=?', [uuid])).toEqual({ id: upper.id, uuid: uuid.toUpperCase(), current_uuid: uuid });
      expect((await db.query(journal)).map(row => row.checksum)).toEqual(released);
      await expect(db.insert('ar_device', { uuid, venue_id: venue.id })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });
  });

  it('reclassifies historical device and order identifiers while preserving their IDs and claim history', async () => {
    await withTestDatabase(async db => {
      await migrate(db);
      await restoreSchema22(db);
      const venue = await seedVenue(db);
      const sn = '0000000000000123';
      const uuid = '12345678-1234-4123-8123-abcdefabcdef';
      const uuidShapedSn = '12345678-1234-4123-8123-abcdefabcdee';
      const residual = await db.insert('ar_device', { uuid: sn, venue_id: venue.id });
      const archived = await db.insert('ar_device', { uuid: sn, deleted_ms: 1000, superseded: 1, venue_id: venue.id });
      const standard = await db.insert('ar_device', { uuid, venue_id: venue.id });
      const snOnly = await db.insert('ar_device', { sn: uuidShapedSn, venue_id: venue.id });
      const ambiguous = await db.insert('ar_device', { sn: uuidShapedSn.toUpperCase(), venue_id: venue.id });
      await db.insert('ar_device_retired_identifier', { kind: 'uuid', identifier: uuidShapedSn, original_identifier: uuidShapedSn.toUpperCase(), device_id: ambiguous.id });
      const conflicting = await db.insert('ar_device', { uuid: 'old-identifier', sn: 'other-sn', venue_id: venue.id });
      const user = await db.insert('ar_user', { appid: 'wx03dbf50c15cac06f', openid: 'synthetic-order-identifier-user' });
      const seedHistoricalOrder = (deviceId: number, identifier: string) => db.insert('ar_rental_order', {
        device_id: deviceId, device_uuid: identifier, device_name: '历史设备名称', user_id: user.id, appid: 'wx03dbf50c15cac06f',
        payer_openid: 'synthetic-order-identifier-user', mch_id: 'synthetic-mch', use_fee_cents: 100, deposit_cents: 1000, total_cents: 1100,
        price_version: 1, status: 'ENDED', payment_status: 'SUCCESS', refund_amount_cents: 1000, refund_status: 'PROCESSING',
        out_trade_no: randomBytes(16).toString('hex'), idempotency_key: randomBytes(8).toString('hex'),
        created_ms: 1000, updated_ms: 2000, expires_ms: 2000, ended_ms: 2000,
      });
      const orders = await Promise.all([
        seedHistoricalOrder(residual.id, sn), seedHistoricalOrder(archived.id, sn), seedHistoricalOrder(standard.id, uuid),
        seedHistoricalOrder(snOnly.id, uuidShapedSn), seedHistoricalOrder(ambiguous.id, uuidShapedSn.toUpperCase()),
      ]);

      await expect(migrate(db)).rejects.toThrow('1 device(s) with conflicting SN assignments');
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: 23 });
      expect(await db.one('SELECT uuid,sn FROM ar_device WHERE id=?', [residual.id])).toEqual({ uuid: sn, sn: null });
      expect(await db.one('SELECT device_uuid,device_sn FROM ar_rental_order WHERE id=?', [orders[0].id])).toEqual({ device_uuid: sn, device_sn: null });

      await db.execute('UPDATE ar_device SET sn=NULL WHERE id=?', [conflicting.id]);
      // Resume when the SQL DDL already committed but the journal write did not.
      await db.execute('DELETE FROM ar_schema_migration WHERE version=23');
      await db.execute('UPDATE ar_schema_meta SET version=22');
      await migrate(db);
      await migrate(db);
      expect(await db.one('SELECT version FROM ar_schema_meta')).toEqual({ version: SCHEMA_VERSION });
      expect(await db.one('SELECT uuid,sn,current_sn FROM ar_device WHERE id=?', [residual.id])).toEqual({ uuid: null, sn, current_sn: sn });
      expect(await db.one('SELECT uuid,sn,current_sn,deleted_ms FROM ar_device WHERE id=?', [archived.id])).toEqual({ uuid: null, sn, current_sn: null, deleted_ms: 1000 });
      const snapshots = [[null, sn], [null, sn], [uuid, null], [null, uuidShapedSn], [uuidShapedSn.toUpperCase(), null]];
      for (const [index, order] of orders.entries()) {
        const [device_uuid, device_sn] = snapshots[index];
        expect(await db.one('SELECT device_id,device_uuid,device_sn,status,refund_status,updated_ms FROM ar_rental_order WHERE id=?', [order.id]))
          .toEqual({ device_id: order.device_id, device_uuid, device_sn, status: 'ENDED', refund_status: 'PROCESSING', updated_ms: 2000 });
      }
      await expect(db.execute('UPDATE ar_rental_order SET device_uuid=NULL,device_sn=NULL WHERE id=?', [orders[0].id]))
        .rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
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
        [undefined, 'Rokid Studio2'], ['ios', 'ios'], ['rokid', 'rokid'], ['rs2', 'Rokid Studio2'],
        ['Rokid Studio', 'Rokid Studio'], ['rokid studio2', 'Rokid Studio2'], ['Rokid Studio3', 'Rokid Studio3'],
        ['RS', 'Rokid Studio'], ['rs3', 'Rokid Studio3'], ['Custom Glasses', 'Custom Glasses'],
      ] as const;
      const uuidForCase = (index: number) => '00000000-0000-4000-8000-' + String(310 + index).padStart(12, '0');
      for (const [index, [type, expected]] of cases.entries()) {
        const uuid = uuidForCase(index);
        const result = await request(app).post('/api/v2/rental/devices').set('Authorization', bearer).send({ uuid, venueId: venue.id, ...(type === undefined ? {} : { type }) });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ created: true, device: { uuid, type: expected } });
      }
      const iosUuid = uuidForCase(1);
      const duplicate = await request(app).post('/api/v2/rental/devices').set('Authorization', bearer).send({ uuid: iosUuid, type: 'rs2', venueId: venue.id });
      expect(duplicate.status).toBe(200);
      expect(duplicate.body).toMatchObject({ created: false, device: { uuid: iosUuid, type: 'ios' } });
      const remarks = ['一楼备用机', '二楼备用机'];
      const concurrent = await Promise.all(remarks.map(remarkName => request(app).post('/api/v2/rental/devices').set('Authorization', bearer)
        .send({ sn: '0000000000000320', type: 'rs2', venueId: venue.id, remarkName })));
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

      const devicePath = `/api/v2/rental/devices/${device.id}`;
      const remove = () => request(app).delete(devicePath).set('Authorization', bearer);
      const removed = await remove();
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ deleted: true });
      expect((await request(app).get('/api/v2/rental/devices/context').set('Authorization', bearer).query({ sn: device.sn })).body)
        .toMatchObject({ state: 'UNREGISTERED', device: null, actions: { canCreate: true, canDelete: false } });
      const replacement = await request(app).post('/api/v2/rental/devices').set('Authorization', bearer).send({ sn: device.sn, venueId: venue.id });
      expect(replacement.status).toBe(200);
      expect(replacement.body).toMatchObject({ created: true, device: { uuid: null, sn: device.sn } });
      expect(replacement.body.device.id).not.toBe(device.id);
      expect((await remove()).body).toEqual({ deleted: true });
      expect(await db.one('SELECT id FROM ar_device WHERE current_sn=? AND deleted_ms IS NULL', [device.sn])).toEqual({ id: replacement.body.device.id });
    });
  });

  it('edits and archives devices by ID while preserving scoped access, unique identifiers and order snapshots', async () => {
    await withTestDatabase(async db => {
      await migrate(db);
      const appId = 'wx03dbf50c15cac06f';
      const client = new WeChatClient({ appId, appSecret: 'synthetic-device-editor-secret', payEnabled: false, allowEnvironmentFallback: false,
        fetch: async () => { throw Error('Device editor integration must not contact WeChat.'); } });
      client.codeSession = async code => ({ openid: 'synthetic-device-editor-' + code });
      const auth = new RentalAuth(db, client, { jwtSecret: 'synthetic-device-editor-signing-key-at-least-32-bytes', rootPhone: '' });
      const { app } = createApplication({ db, client, auth, merchants: new MerchantRegistry(db, client, new MerchantSecrets('e'.repeat(64))) });
      const login = async (role: 'root' | 'manager' | 'user') => {
        const user = await db.insert('ar_user', { appid: appId, openid: 'synthetic-device-editor-' + role, role, merchant_id: role === 'manager' ? 1 : null });
        if (role === 'manager') await db.insert('ar_merchant_membership', { user_id: user.id, merchant_id: 1, role, status: 'active', authorization_version: 1, updated_ms: Date.now() });
        const response = await request(app).post('/api/v2/rental/auth/login').send({ code: role });
        expect(response.status).toBe(200);
        return { id: user.id, bearer: 'Bearer ' + response.body.data.token.accessToken };
      };
      const root = await login('root'), manager = await login('manager'), viewer = await login('user');
      const venue = await seedVenue(db);
      const other = await request(app).post('/api/v2/rental/admin/merchants').set('Authorization', root.bearer)
        .send({ code: 'identifier-other', name: 'Synthetic other merchant', miniappOwnerId: 1, status: 'active', payEnabled: false });
      expect(other.status).toBe(200);
      const otherMerchantId = String(other.body.merchant.id);
      const base = '/api/v2/rental/devices';
      const create = (fields: Record<string, unknown>) => request(app).post(base).set('Authorization', root.bearer)
        .set('X-Merchant-Id', '1').send({ venueId: venue.id, ...fields });
      const patch = (id: number, fields: Record<string, unknown>, bearer = root.bearer, merchantId = '1') => request(app).patch(`${base}/${id}`)
        .set('Authorization', bearer).set('X-Merchant-Id', merchantId).send(fields);
      const remove = (id: number, bearer = root.bearer, merchantId = '1') => request(app).delete(`${base}/${id}`)
        .set('Authorization', bearer).set('X-Merchant-Id', merchantId);
      const generateQr = (id: number, identifier?: 'uuid' | 'sn') => request(app).get(`/api/v2/rental/admin/devices/${id}/qrcode`)
        .set('Authorization', root.bearer).set('X-Merchant-Id', '1').query(identifier === undefined ? {} : { identifier });
      const firstSn = '0000000000000321', secondSn = '0000000000000322';
      const usedUuid = '22222222-2222-4222-8222-222222222222';
      const newUuid = '11111111-1111-4111-8111-111111111111';
      const first = await create({ sn: firstSn, name: '设备原名' });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ created: true, device: { uuid: null, sn: firstSn } });
      const deviceId = Number(first.body.device.id);
      const second = await create({ uuid: usedUuid, sn: secondSn });
      expect(second.status).toBe(200);
      expect(second.body.device).toMatchObject({ uuid: usedUuid, sn: secondSn });
      const snQr = await generateQr(deviceId);
      expect(snQr.status).toBe(200);
      expect(snQr.body.url).toBe(`https://d.4mr.cn/d?s=${firstSn}&t=rs2`);
      const snLookup = await request(app).get(`${base}/context`).set('Authorization', root.bearer)
        .query({ sn: new URL(snQr.body.url).searchParams.get('s') });
      expect(snLookup.status).toBe(200);
      expect(snLookup.body.device.id).toBe(deviceId);
      expect((await request(app).get(`${base}/context`).set('Authorization', root.bearer).query({ uuid: firstSn })).status).toBe(422);
      const dualQr = await generateQr(second.body.device.id);
      expect(dualQr.status).toBe(200);
      expect(dualQr.body.url).toBe(`https://d.4mr.cn/d?i=${usedUuid}&t=rs2`);
      expect((await generateQr(second.body.device.id, 'sn')).body.url).toBe(`https://d.4mr.cn/d?s=${secondSn}&t=rs2`);
      for (const invalid of [{}, { uuid: 'legacy-text-uuid' }, { sn: '000000000000032' }, { sn: '000000000000032A' }, { sn: '０００００００００００００３２３' }]) {
        expect((await create(invalid)).status).toBe(422);
      }
      const read = () => db.one('SELECT name,device_type,uuid,sn FROM ar_device WHERE id=?', [deviceId]);

      expect((await patch(deviceId, { name: '错误商户' }, root.bearer, otherMerchantId)).status).toBe(404);
      expect((await remove(deviceId, root.bearer, otherMerchantId)).status).toBe(404);
      expect((await patch(deviceId, { name: '无权限' }, viewer.bearer)).status).toBe(403);
      expect((await patch(deviceId, { name: '不能部分写入', remarkName: '无权限' }, manager.bearer)).status).toBe(403);
      expect((await patch(deviceId, { uuid: usedUuid, name: '重复 UUID 不得写入' })).status).toBe(409);
      expect((await patch(deviceId, { sn: secondSn })).status).toBe(409);
      expect((await patch(deviceId, { uuid: 'legacy-text-uuid' })).status).toBe(422);
      expect((await patch(deviceId, { sn: '000000000000032A' })).status).toBe(422);
      expect((await patch(deviceId, { uuid: null, sn: null })).status).toBe(422);
      expect(await read()).toEqual({ name: '设备原名', device_type: 'Rokid Studio2', uuid: null, sn: firstSn });

      const historical = await db.insert('ar_device', { name: '历史录入设备', sn: 'legacy-stored-sn', venue_id: venue.id });
      const updatedHistorical = await patch(historical.id, { name: '历史设备可改名' });
      expect(updatedHistorical.status).toBe(200);
      expect(updatedHistorical.body.device).toMatchObject({ name: '历史设备可改名', uuid: null, sn: 'legacy-stored-sn' });
      expect((await request(app).get(`${base}/context`).set('Authorization', root.bearer).query({ sn: 'legacy-stored-sn' })).body.device.id).toBe(historical.id);

      const now = Date.now();
      const order = await db.insert('ar_rental_order', { device_id: deviceId, device_sn: firstSn, device_name: '订单历史设备名称', user_id: viewer.id,
        venue_id: venue.id, merchant_id: 1, payment_config_id: 1, appid: appId, mch_id: 'synthetic-mch', payer_openid: 'synthetic-device-editor-user',
        use_fee_cents: 100, deposit_cents: 1000, total_cents: 1100, price_version: 1, status: 'ENDED', payment_status: 'SUCCESS',
        refund_amount_cents: 1000, refund_status: 'PROCESSING', out_trade_no: 'synthetic-editor-order', idempotency_key: 'synthetic-editor-idempotency',
        created_ms: now, updated_ms: now, expires_ms: now, ended_ms: now });
      expect((await patch(deviceId, { uuid: newUuid })).status).toBe(409);
      expect((await remove(deviceId)).status).toBe(409);
      expect((await patch(deviceId, { name: '正常资料编辑' }, manager.bearer)).status).toBe(200);
      expect(await read()).toMatchObject({ name: '正常资料编辑', uuid: null, sn: firstSn });

      await db.execute("UPDATE ar_rental_order SET refund_status='SUCCESS',settled_ms=? WHERE id=?", [now, order.id]);
      const updated = await patch(deviceId, { name: '更新设备', type: 'rs3', uuid: newUuid, sn: null, remarkName: ' 换标识  ' });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ device: { id: deviceId, uuid: newUuid, sn: null, name: '更新设备', type: 'Rokid Studio3', remarkName: '换标识' }, requiresNewQr: true });
      expect(await read()).toEqual({ name: '更新设备', device_type: 'Rokid Studio3', uuid: newUuid, sn: null });
      const retiredSn = await request(app).get(`${base}/context`).set('Authorization', root.bearer).query({ sn: firstSn });
      expect(retiredSn.body).toMatchObject({ state: 'UNREGISTERED', device: null, actions: { canCreate: false } });
      expect((await create({ sn: firstSn })).status).toBe(409);
      const qr = await generateQr(deviceId);
      expect(qr.status).toBe(200);
      expect(new URL(qr.body.url).searchParams.get('i')).toBe(newUuid);
      expect((await patch(deviceId, { uuid: null })).status).toBe(422);
      const orderDevice = () => request(app).get(`/api/v2/rentals/${order.id}/device-context`).set('Authorization', viewer.bearer);
      expect((await orderDevice()).body).toMatchObject({ device: { id: deviceId, uuid: newUuid } });

      expect((await remove(deviceId)).body).toEqual({ deleted: true });
      expect((await remove(deviceId)).body).toEqual({ deleted: true });
      expect((await patch(deviceId, { name: '已删除不可编辑' })).status).toBe(404);
      expect((await orderDevice()).body).toMatchObject({ device: null, deviceUnavailable: true, actions: { canCreate: false, canRent: false } });
      const history = await request(app).get(`/api/v2/rentals/${order.id}`).set('Authorization', viewer.bearer);
      expect(history.status).toBe(200);
      expect(history.body.rental).toMatchObject({ id: order.id, deviceId, uuid: null, sn: firstSn, deviceName: '订单历史设备名称', refundStatus: 'SUCCESS' });
      expect(await db.one('SELECT device_id,device_uuid,device_sn,device_name FROM ar_rental_order WHERE id=?', [order.id]))
        .toEqual({ device_id: deviceId, device_uuid: null, device_sn: firstSn, device_name: '订单历史设备名称' });
    });
  }, 30_000);
});
