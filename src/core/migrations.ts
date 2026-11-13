import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './database';

export const SCHEMA_VERSION = 3;
const TABLES = new Set(['ar_schema_meta', 'ar_device', 'ar_user', 'ar_role_audit', 'ar_admin_guard', 'ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job', 'ar_admin_login_challenge', 'ar_admin_session', 'ar_user_phone']);
export async function migrate(db: Database, root = process.cwd()): Promise<void> {
  await db.withConnection(async connection => {
    const lease = await connection.one("SELECT GET_LOCK('ar-device-rental-schema',30) AS acquired");
    if (Number(lease?.acquired) !== 1) throw new Error('Could not acquire schema migration lock.');
    try {
      const tables = await connection.query('SHOW TABLES');
      if (tables.some(row => !TABLES.has(String(Object.values(row)[0])))) throw new Error('Use a dedicated AR rental database. Existing unrelated tables were found; no schema changes were made.');
      await connection.execute('CREATE TABLE IF NOT EXISTS ar_schema_meta (name varchar(64) NOT NULL PRIMARY KEY, version int NOT NULL) ENGINE=InnoDB');
      const current = await connection.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']);
      if (Number(current?.version || 0) > SCHEMA_VERSION) throw new Error('Database schema is newer than this application.');
      for (const filename of ['001-core.sql', 'user-schema.sql', '002-rentals.sql', '003-admin.sql', '004-phone.sql']) {
        const sql = (await readFile(resolve(root, 'database', filename), 'utf8')).replace(/^\s*--.*$/gm, '');
        for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await connection.execute(statement);
      }
      await connection.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?) ON DUPLICATE KEY UPDATE version=?', ['ar-device-rental-api', SCHEMA_VERSION, SCHEMA_VERSION]);
    } finally { await connection.query("SELECT RELEASE_LOCK('ar-device-rental-schema')"); }
  });
}
