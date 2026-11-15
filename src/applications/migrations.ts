import type { Database } from '../core/database';

/** Copy only the active login snapshot; never load payment history for login. */
export async function migrateApplications(db: Database): Promise<void> {
  if (!await db.one("SHOW COLUMNS FROM ar_merchant_wechat_config WHERE Field='validated_ms'")) await db.execute('ALTER TABLE ar_merchant_wechat_config ADD COLUMN validated_ms bigint NULL');
  const now = Date.now();
  await db.execute(`INSERT IGNORE INTO ar_application
    (id,legacy_merchant_id,name,app_id,origin,hostname,status,credential_source,secret_ciphertext,secret_account,created_ms,updated_ms)
    SELECT m.id,m.id,m.name,m.app_id,m.origin,m.hostname,'active',
      CASE WHEN c.source='legacy' THEN 'legacy' ELSE 'legacy_config' END,c.secret_ciphertext,CAST(m.id AS CHAR),?,?
    FROM ar_merchant m LEFT JOIN ar_merchant_wechat_config c ON c.id=m.active_config_id AND c.merchant_id=m.id
    WHERE m.miniapp_owner_id IS NULL`, [now, now]);
  await db.execute(`INSERT IGNORE INTO ar_application_merchant (application_id,merchant_id)
    SELECT a.id,m.id FROM ar_merchant m INNER JOIN ar_application a ON a.legacy_merchant_id=COALESCE(m.miniapp_owner_id,m.id)`);
  const invalid = await db.one('SELECT COUNT(*) AS total FROM ar_merchant m LEFT JOIN ar_application_merchant am ON am.merchant_id=m.id WHERE am.merchant_id IS NULL');
  if (Number(invalid?.total)) throw new Error('Application migration found a merchant without a valid application entry.');
}
