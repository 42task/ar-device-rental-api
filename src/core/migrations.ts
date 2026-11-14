import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './database';

export const SCHEMA_VERSION = 6;
const TABLES = new Set(['ar_schema_meta', 'ar_device', 'ar_user', 'ar_role_audit', 'ar_admin_guard', 'ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job', 'ar_admin_login_challenge', 'ar_admin_session', 'ar_user_phone']);
/** MySQL serializes generated expressions with connection-charset introducers
 * and backslash-escaped literal quotes, even though the input DDL has neither. */
export function validRootUniquenessExpression(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 512) return false;
  // Match formatting only outside the exact root literal. Globally removing
  // charset names or whitespace would also rewrite 'root_ascii' or 'r o o t'.
  const template = /^\s*(?:\(\s*)*case\s+when\s+(?:\(\s*)*(?:role|`role`)\s*=\s*(?:_[a-z0-9]+\s*)?(?:'([^']*)'|\\'([^']*)\\')\s*(?:\)\s*)*then\s+(?:\(\s*)*1\s*(?:\)\s*)*else\s+(?:\(\s*)*null\s*(?:\)\s*)*end\s*(?:\)\s*)*$/i;
  const match = template.exec(value);
  if (!match || (match[1] ?? match[2]) !== 'root') return false;
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth++;
    if (character === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
export async function migrate(db: Database, root = process.cwd()): Promise<void> {
  await db.withConnection(async connection => {
    const lease = await connection.one("SELECT GET_LOCK('ar-device-rental-schema',30) AS acquired");
    if (Number(lease?.acquired) !== 1) throw new Error('Could not acquire schema migration lock.');
    try {
      const tables = await connection.query('SHOW TABLES');
      if (tables.some(row => !TABLES.has(String(Object.values(row)[0])))) throw new Error('Use a dedicated AR rental database. Existing unrelated tables were found; no schema changes were made.');
      if (tables.some(row => Object.values(row)[0] === 'ar_user')) {
        const roots = await connection.one("SELECT COUNT(*) AS total FROM ar_user WHERE role='root'");
        if (Number(roots?.total) > 1) throw new Error('Multiple root accounts exist. Resolve the conflict explicitly before migration; no roles were changed.');
      }
      await connection.execute('CREATE TABLE IF NOT EXISTS ar_schema_meta (name varchar(64) NOT NULL PRIMARY KEY, version int NOT NULL) ENGINE=InnoDB');
      const current = await connection.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']);
      if (Number(current?.version || 0) > SCHEMA_VERSION) throw new Error('Database schema is newer than this application.');
      for (const filename of ['001-core.sql', 'user-schema.sql', '002-rentals.sql', '003-admin.sql', '004-phone.sql', '005-device-type-default.sql', '006-device-type-canonical-default.sql', '007-role-levels.sql']) {
        const sql = (await readFile(resolve(root, 'database', filename), 'utf8')).replace(/^\s*--.*$/gm, '');
        for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
          if (filename === '007-role-levels.sql') {
            if (statement.includes('MODIFY COLUMN role')) {
              const column = await connection.one("SHOW COLUMNS FROM ar_user WHERE Field='role'");
              if (column?.Type === "enum('user','manager','admin','root')") continue;
            } else if (statement.includes('ADD COLUMN root_singleton')) {
              const column = await connection.one("SELECT GENERATION_EXPRESSION AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ar_user' AND COLUMN_NAME='root_singleton'");
              if (column) {
                if (!validRootUniquenessExpression(column.expression)) throw new Error('Unexpected root uniqueness column; inspect the dedicated schema before migration.');
                continue;
              }
            } else if (statement.includes('ADD UNIQUE KEY uq_ar_user_single_root')) {
              const indexes = await connection.query("SHOW INDEX FROM ar_user WHERE Key_name='uq_ar_user_single_root'");
              if (indexes.length) {
                if (indexes.length !== 1 || Number(indexes[0].Non_unique) !== 0 || indexes[0].Column_name !== 'root_singleton') throw new Error('Unexpected root uniqueness index; inspect the dedicated schema before migration.');
                continue;
              }
            }
          }
          await connection.execute(statement);
        }
      }
      await connection.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?) ON DUPLICATE KEY UPDATE version=?', ['ar-device-rental-api', SCHEMA_VERSION, SCHEMA_VERSION]);
    } finally { await connection.query("SELECT RELEASE_LOCK('ar-device-rental-schema')"); }
  });
}
