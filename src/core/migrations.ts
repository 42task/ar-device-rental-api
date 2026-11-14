import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from './database';
import { migrateMemberships } from '../auth/migrations';
import { migrateApplications } from '../applications/migrations';
import { archiveDevicePricing } from '../devices/migrations';

export const SCHEMA_VERSION = 13;
const CURRENT_ROLE_ENUM = "enum('user','manager','adminer','root')";
const LEGACY_ROLE_ENUM = "enum('user','manager','admin','root')";
const TRANSITIONAL_ROLE_ENUM = "enum('user','manager','admin','root','adminer')";
const TABLES = new Set(['ar_schema_meta', 'ar_schema_migration', 'ar_device', 'ar_user', 'ar_role_audit', 'ar_admin_guard', 'ar_rental_config', 'ar_rental_order', 'ar_rental_slot', 'ar_rental_event', 'ar_rental_job', 'ar_user_phone', 'ar_admin_login_challenge', 'ar_admin_session', 'ar_merchant', 'ar_merchant_wechat_config', 'ar_user_wechat_identity', 'ar_user_merchant_binding', 'ar_user_phone_history', 'ar_merchant_audit', 'ar_venue', 'ar_merchant_membership', 'ar_application', 'ar_application_merchant', 'ar_legacy_device_pricing_archive']);

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

/** An entry owns login credentials; several business merchants may share it. */
async function migrateSharedMiniapp(db: Database): Promise<void> {
  if (!await db.one("SHOW COLUMNS FROM ar_merchant WHERE Field='miniapp_owner_id'")) {
    await db.execute('ALTER TABLE ar_merchant ADD COLUMN miniapp_owner_id int NULL');
  }
  // Keep independent entries unique while permitting their merchants to reuse
  // the same public AppID/domain. The old inline UNIQUE indexes are replaced.
  for (const [column, definition] of [
    ['entry_hostname', 'varchar(253) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN miniapp_owner_id IS NULL THEN hostname ELSE NULL END) STORED'],
    ['entry_app_id', 'varchar(32) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN miniapp_owner_id IS NULL THEN app_id ELSE NULL END) STORED'],
  ]) {
    if (!await db.one('SHOW COLUMNS FROM ar_merchant WHERE Field=?', [column])) await db.execute(`ALTER TABLE ar_merchant ADD COLUMN ${column} ${definition}`);
    const index = 'uq_ar_merchant_' + column;
    if (!await db.one('SHOW INDEX FROM ar_merchant WHERE Key_name=?', [index])) await db.execute(`ALTER TABLE ar_merchant ADD UNIQUE INDEX ${index} (${column})`);
  }
  for (const index of ['origin', 'hostname', 'app_id']) {
    if (await db.one('SHOW INDEX FROM ar_merchant WHERE Key_name=?', [index])) await db.execute(`ALTER TABLE ar_merchant DROP INDEX ${index}`);
  }
  const invalid = await db.one('SELECT COUNT(*) AS total FROM ar_device d LEFT JOIN ar_merchant m ON m.id=d.merchant_id WHERE m.id IS NULL');
  if (Number(invalid?.total)) throw new Error('Devices without a valid merchant were found; assign their owners before migration.');
  if (!await db.one("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='ar_device' AND CONSTRAINT_NAME='fk_ar_device_merchant'")) {
    await db.execute('ALTER TABLE ar_device ADD CONSTRAINT fk_ar_device_merchant FOREIGN KEY (merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT');
  }
  if (!await db.one("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='ar_merchant' AND CONSTRAINT_NAME='fk_ar_merchant_miniapp_owner'")) {
    await db.execute('ALTER TABLE ar_merchant ADD CONSTRAINT fk_ar_merchant_miniapp_owner FOREIGN KEY (miniapp_owner_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT');
  }
}

/** Every historical device keeps its exact pricing in an explicit migration venue. */
async function migrateVenues(db: Database): Promise<void> {
  const add = async (table: string, field: string, definition: string) => {
    if (!await db.one(`SHOW COLUMNS FROM ${table} WHERE Field=?`, [field])) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${field} ${definition}`);
  };
  await add('ar_device', 'venue_id', 'int NULL');
  await add('ar_rental_order', 'venue_id', 'int NULL');
  await add('ar_rental_order', 'venue_name', 'varchar(128) NULL');
  await add('ar_rental_order', 'venue_price_version', 'int unsigned NULL');
  const now = Date.now();
  // The unique legacy_device_id resumes an interrupted backfill without
  // overwriting a venue that an administrator has subsequently edited.
  await db.execute(`INSERT IGNORE INTO ar_venue
    (merchant_id,name,address,contact_name,contact_phone,description,status,use_fee_cents,deposit_cents,version,created_ms,updated_ms,updated_by,legacy_device_id)
    SELECT d.merchant_id,CONCAT('历史配置迁移场地（设备 #',d.id,'）'),'','','',
      CONCAT('由设备 ',d.uuid,' 的历史配置单独迁移；请核实真实场地后调整，不代表已识别实际经营场地。'),
      CASE WHEN c.device_id IS NOT NULL AND c.enabled=1 THEN 'active' ELSE 'paused' END,
      COALESCE(c.use_fee_cents,0),COALESCE(c.deposit_cents,0),1,?,?,c.updated_by,d.id
    FROM ar_device d LEFT JOIN ar_rental_config c ON c.device_id=d.id WHERE d.venue_id IS NULL`, [now, now]);
  await db.execute('UPDATE ar_device d JOIN ar_venue v ON v.legacy_device_id=d.id AND v.merchant_id=d.merchant_id SET d.venue_id=v.id WHERE d.venue_id IS NULL');
  const invalid = await db.one('SELECT COUNT(*) AS total FROM ar_device d LEFT JOIN ar_venue v ON v.id=d.venue_id AND v.merchant_id=d.merchant_id WHERE v.id IS NULL');
  if (Number(invalid?.total)) throw new Error('Devices without a venue in their own merchant were found; verify venue ownership before migration.');
  const column = await db.one("SHOW COLUMNS FROM ar_device WHERE Field='venue_id'");
  if (column?.Null !== 'NO') await db.execute('ALTER TABLE ar_device MODIFY COLUMN venue_id int NOT NULL');
  if (!await db.one("SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='ar_device' AND CONSTRAINT_NAME='fk_ar_device_venue_merchant'")) {
    await db.execute('ALTER TABLE ar_device ADD CONSTRAINT fk_ar_device_venue_merchant FOREIGN KEY (venue_id,merchant_id) REFERENCES ar_venue(id,merchant_id) ON DELETE RESTRICT');
  }
  if (!await db.one("SHOW INDEX FROM ar_rental_order WHERE Key_name='ix_ar_order_venue'")) await db.execute('ALTER TABLE ar_rental_order ADD INDEX ix_ar_order_venue (venue_id,id)');
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
      await connection.execute('CREATE TABLE IF NOT EXISTS ar_schema_migration (version int NOT NULL PRIMARY KEY, checksum char(64) CHARACTER SET ascii NOT NULL, applied_ms bigint NOT NULL) ENGINE=InnoDB');
      let version = Number(current?.version || 0);
      if (version < 10) {
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
      await migrateSharedMiniapp(connection);
      const venueSql = (await readFile(resolve(root, 'database', '010-venues.sql'), 'utf8')).replace(/^\s*--.*$/gm, '');
      for (const statement of venueSql.split(';').map(value => value.trim()).filter(Boolean)) await connection.execute(statement);
      await migrateVenues(connection);
        version = 10;
        await connection.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?) ON DUPLICATE KEY UPDATE version=?', ['ar-device-rental-api', version, version]);
      }
      for (const step of [
        { version: 11, filename: '011-memberships.sql', run: migrateMemberships },
        { version: 12, filename: '012-applications.sql', run: migrateApplications },
        { version: 13, filename: '013-device-pricing-archive.sql', run: archiveDevicePricing },
      ]) {
        const source = await readFile(resolve(root, 'database', step.filename), 'utf8');
        const checksum = createHash('sha256').update(source).digest('hex');
        const recorded = await connection.one('SELECT checksum FROM ar_schema_migration WHERE version=?', [step.version]);
        if (recorded && recorded.checksum !== checksum) throw new Error(`Applied migration ${step.version} was modified; use a new migration instead.`);
        if (version < step.version) {
          for (const statement of source.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await connection.execute(statement);
          await step.run(connection);
          await connection.transaction(async tx => {
            await tx.execute('INSERT INTO ar_schema_migration (version,checksum,applied_ms) VALUES (?,?,?)', [step.version, checksum, Date.now()]);
            await tx.execute('INSERT INTO ar_schema_meta (name,version) VALUES (?,?) ON DUPLICATE KEY UPDATE version=?', ['ar-device-rental-api', step.version, step.version]);
          });
          version = step.version;
        }
      }
    } finally { await connection.query("SELECT RELEASE_LOCK('ar-device-rental-schema')"); }
  });
}
