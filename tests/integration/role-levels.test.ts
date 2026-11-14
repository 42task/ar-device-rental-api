import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database';
import { migrate, SCHEMA_VERSION, validRootUniquenessExpression } from '../../src/core/migrations';

async function withLegacyDatabase(check: (db: Database) => Promise<void>): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'ar_rental_test') throw new Error('Use the dedicated localhost AR rental test environment.');
  const database = 'ar_role_levels_test_' + randomBytes(10).toString('hex');
  const settings = { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD };
  const control = await mysql.createConnection(settings);
  let db: Database | undefined, created = false;
  try {
    await control.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`); created = true;
    db = new Database(mysql.createPool({ ...settings, database, connectionLimit: 6 }));
    const legacy = (await readFile('database/user-schema.sql', 'utf8'))
      .replace("enum('user','manager','admin','root')", "enum('user','manager','root')")
      .replace(/^.*root_singleton.*\n/gm, '').replace(/^\s*--.*$/gm, '');
    for (const sql of legacy.split(';').map(value => value.trim()).filter(Boolean)) await db.execute(sql);
    await db.execute('CREATE TABLE ar_schema_meta (name varchar(64) NOT NULL PRIMARY KEY, version int NOT NULL) ENGINE=InnoDB');
    await db.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?)', ['ar-device-rental-api', 5]);
    await check(db);
  } finally {
    await db?.close();
    if (created) await control.query(`DROP DATABASE ${database}`);
    await control.end();
  }
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('real MySQL four-level roles and global root uniqueness', () => {
  it('upgrades the old enum, preserves its root and enforces a single root even across AppIDs and direct concurrent SQL', async () => {
    await withLegacyDatabase(async db => {
      for (const [id, appid, role] of [[1, 'wx03dbf50c15cac06f', 'root'], [2, 'wx03dbf50c15cac06f', 'manager'], [3, 'wx1111111111111111', 'user']] as const) {
        await db.insert('ar_user', { id, appid, openid: 'synthetic-role-level-' + id, role });
      }
      await migrate(db); await migrate(db);
      const generated = await db.one("SELECT GENERATION_EXPRESSION AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ar_user' AND COLUMN_NAME='root_singleton'");
      expect(validRootUniquenessExpression(generated!.expression)).toBe(true);
      expect(Number((await db.one('SELECT version FROM ar_schema_meta'))!.version)).toBe(SCHEMA_VERSION);
      expect((await db.one("SHOW COLUMNS FROM ar_user WHERE Field='role'"))!.Type).toBe("enum('user','manager','admin','root')");
      expect(await db.query('SELECT id,role FROM ar_user ORDER BY id')).toEqual([{ id: 1, role: 'root' }, { id: 2, role: 'manager' }, { id: 3, role: 'user' }]);
      await db.execute("UPDATE ar_user SET role='admin' WHERE id=2");
      await expect(db.execute("UPDATE ar_user SET role='root' WHERE id=3")).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await expect(db.insert('ar_user', { appid: 'wx2222222222222222', openid: 'synthetic-forbidden-root', role: 'root' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      // Reset only synthetic test roles to let two AppIDs compete directly,
      // independently of the application's guard-row bootstrap protocol.
      await db.execute("UPDATE ar_user SET role='user' WHERE id=1");
      const competing = await Promise.allSettled([db.execute("UPDATE ar_user SET role='root' WHERE id=2"), db.execute("UPDATE ar_user SET role='root' WHERE id=3")]);
      expect(competing.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      expect((competing.find(value => value.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'ER_DUP_ENTRY' });
      expect(Number((await db.one("SELECT COUNT(*) AS total FROM ar_user WHERE role='root'"))!.total)).toBe(1);
    });
  });

  it('refuses duplicate legacy roots without changing roles, enum or schema version', async () => {
    await withLegacyDatabase(async db => {
      await db.insert('ar_user', { id: 1, appid: 'wx03dbf50c15cac06f', openid: 'synthetic-root-one', role: 'root' });
      await db.insert('ar_user', { id: 2, appid: 'wx1111111111111111', openid: 'synthetic-root-two', role: 'root' });
      await expect(migrate(db)).rejects.toThrow('Multiple root accounts');
      expect(await db.query('SELECT id,role FROM ar_user ORDER BY id')).toEqual([{ id: 1, role: 'root' }, { id: 2, role: 'root' }]);
      expect((await db.one("SHOW COLUMNS FROM ar_user WHERE Field='role'"))!.Type).toBe("enum('user','manager','root')");
      expect(await db.one("SHOW COLUMNS FROM ar_user WHERE Field='root_singleton'")).toBeNull();
      expect(Number((await db.one('SELECT version FROM ar_schema_meta'))!.version)).toBe(5);
    });
  });

  it('retries an interrupted migration with the enum and generated column already installed', async () => {
    await withLegacyDatabase(async db => {
      await db.insert('ar_user', { id: 1, appid: 'wx03dbf50c15cac06f', openid: 'synthetic-existing-root', role: 'root' });
      await db.execute("ALTER TABLE ar_user MODIFY COLUMN role enum('user','manager','admin','root') NOT NULL DEFAULT 'user'");
      await db.execute("ALTER TABLE ar_user ADD COLUMN root_singleton tinyint GENERATED ALWAYS AS (CASE WHEN role='root' THEN 1 ELSE NULL END) STORED");
      await migrate(db); await migrate(db);
      expect((await db.one('SELECT role FROM ar_user WHERE id=1'))!.role).toBe('root');
      expect(Number((await db.one('SELECT version FROM ar_schema_meta'))!.version)).toBe(SCHEMA_VERSION);
      await expect(db.insert('ar_user', { appid: 'wx1111111111111111', openid: 'synthetic-retry-forbidden-root', role: 'root' })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });
  });
});
