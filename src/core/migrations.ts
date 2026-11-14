import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './database';

export const SCHEMA_VERSION = 8;
const CURRENT_ROLE_ENUM = "enum('user','manager','adminer','root')";
const LEGACY_ROLE_ENUM = "enum('user','manager','admin','root')";
const TRANSITIONAL_ROLE_ENUM = "enum('user','manager','admin','root','adminer')";
const TABLES = new Set(['ar_schema_meta', 'ar_device', 'ar_user', 'ar_role_audit', 'ar_admin_guard', 'ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job', 'ar_admin_login_challenge', 'ar_admin_session', 'ar_user_phone', 'ar_merchant', 'ar_merchant_wechat_config', 'ar_user_wechat_identity', 'ar_user_merchant_binding', 'ar_user_phone_history', 'ar_merchant_audit']);

/** Each DDL step can resume after interruption; MySQL DDL is not transactional. */
async function migrateMerchantColumns(db: Database): Promise<void> {
  const add = async (table: string, field: string, definition: string) => {
    if (!await db.one(`SHOW COLUMNS FROM ${table} WHERE Field=?`, [field])) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${field} ${definition}`);
  };
  await add('ar_user', 'merchant_id', 'int NULL DEFAULT 1');
  await add('ar_user', 'auth_version', 'int NOT NULL DEFAULT 0');
  for (const table of ['ar_device', 'ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job']) await add(table, 'merchant_id', 'int NOT NULL DEFAULT 1');
  await add('ar_rental_order', 'payment_config_id', 'int NULL DEFAULT 1');
  await add('ar_user_phone', 'identity_id', 'int NULL');
  await add('ar_admin_session', 'merchant_id', 'int NULL DEFAULT 1');
  await add('ar_admin_session', 'identity_id', 'int NULL');
  await add('ar_admin_session', 'auth_version', 'int NOT NULL DEFAULT 0');
  await add('ar_admin_session', 'origin', 'varchar(255) NULL');
  await add('ar_admin_login_challenge', 'merchant_id', 'int NOT NULL DEFAULT 1');
  await add('ar_admin_login_challenge', 'appid', 'varchar(32) NULL');
  await add('ar_admin_login_challenge', 'auth_version', 'int NULL');
  await add('ar_role_audit', 'merchant_id', 'int NULL');
  await add('ar_user_merchant_binding', 'source_confirmed_ms', 'bigint NULL');
  await db.execute("UPDATE ar_user SET merchant_id=NULL WHERE role='root'");
  await db.execute('INSERT IGNORE INTO ar_user_wechat_identity (user_id,appid,openid,unionid,status) SELECT id,appid,openid,unionid,\'active\' FROM ar_user');
  await db.execute('UPDATE ar_user_phone p JOIN ar_user_wechat_identity i ON i.user_id=p.user_id AND i.appid=p.appid SET p.identity_id=i.id WHERE p.identity_id IS NULL');
  for (const [table, index, columns] of [
    ['ar_user', 'ix_ar_user_merchant', 'merchant_id,id'],
    ['ar_device', 'ix_ar_device_merchant', 'merchant_id,id'],
    ['ar_rental_order', 'ix_ar_order_merchant', 'merchant_id,id'],
    ['ar_rental_job', 'ix_ar_job_merchant', 'merchant_id,finished,available_ms'],
  ]) if (!await db.one(`SHOW INDEX FROM ${table} WHERE Key_name=?`, [index])) await db.execute(`ALTER TABLE ${table} ADD INDEX ${index} (${columns})`);
  const invalid = await db.one("SELECT COUNT(*) AS total FROM ar_user u LEFT JOIN ar_merchant m ON m.id=u.merchant_id WHERE u.role<>'root' AND m.id IS NULL");
  if (Number(invalid?.total)) throw new Error('Merchant migration found accounts without a valid merchant.');
}
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
      for (const filename of ['001-core.sql', 'user-schema.sql', '002-rentals.sql', '003-admin.sql', '004-phone.sql', '005-device-type-default.sql', '006-device-type-canonical-default.sql', '007-role-levels.sql', '008-adminer-role.sql', '009-merchants.sql']) {
        const sql = (await readFile(resolve(root, 'database', filename), 'utf8')).replace(/^\s*--.*$/gm, '');
        for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
          if (filename === '007-role-levels.sql') {
            if (statement.includes('MODIFY COLUMN role')) {
              const column = await connection.one("SHOW COLUMNS FROM ar_user WHERE Field='role'");
              // Never narrow an enum after the rename has begun or completed.
              if ([LEGACY_ROLE_ENUM, TRANSITIONAL_ROLE_ENUM, CURRENT_ROLE_ENUM].includes(column?.Type)) continue;
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
          if (filename === '008-adminer-role.sql' && statement.includes('MODIFY COLUMN role')) {
            const column = await connection.one("SHOW COLUMNS FROM ar_user WHERE Field='role'");
            const target = statement.includes(TRANSITIONAL_ROLE_ENUM) ? TRANSITIONAL_ROLE_ENUM : CURRENT_ROLE_ENUM;
            // Fresh databases and completed runs already use the final enum.
            if (column?.Type === CURRENT_ROLE_ENUM || column?.Type === target) continue;
          }
          await connection.execute(statement);
        }
      }
      await migrateMerchantColumns(connection);
      await connection.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?) ON DUPLICATE KEY UPDATE version=?', ['ar-device-rental-api', SCHEMA_VERSION, SCHEMA_VERSION]);
    } finally { await connection.query("SELECT RELEASE_LOCK('ar-device-rental-schema')"); }
  });
}
