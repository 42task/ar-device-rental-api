import type { Database } from '../core/database';

/** Resumable compatibility projection; existing authoritative memberships win. */
export async function migrateMemberships(db: Database): Promise<void> {
  const add = async (field: string, definition: string) => {
    if (!await db.one('SHOW COLUMNS FROM ar_user_merchant_binding WHERE Field=?', [field])) await db.execute(`ALTER TABLE ar_user_merchant_binding ADD COLUMN ${field} ${definition}`);
  };
  const schema = await db.one('SELECT version FROM ar_schema_meta WHERE name=?', ['ar-device-rental-api']);
  const upgrading = Number(schema?.version ?? 0) < 11;
  await add('source_auth_version', 'int unsigned NULL');
  await add('source_appid', 'varchar(32) CHARACTER SET ascii COLLATE ascii_bin NULL');
  for (const table of ['ar_admin_session', 'ar_admin_login_challenge']) {
    if (!await db.one(`SHOW COLUMNS FROM ${table} WHERE Field='application_id'`)) await db.execute(`ALTER TABLE ${table} ADD COLUMN application_id int NULL`);
  }
  if (upgrading) await db.execute(`INSERT IGNORE INTO ar_merchant_membership(user_id,merchant_id,role,status,authorization_version,updated_ms)
    SELECT u.id,u.merchant_id,u.role,'active',1,? FROM ar_user u
    INNER JOIN ar_merchant m ON m.id=u.merchant_id WHERE u.role IN ('manager','adminer')`, [Date.now()]);
  // Old invitations did not bind a source authorization version. Expire them
  // before clearing consumer ownership; completed invitations remain history.
  if (upgrading) await db.execute('UPDATE ar_user_merchant_binding SET expires_ms=? WHERE consumed_ms IS NULL', [Date.now()]);
  await db.execute("UPDATE ar_merchant_membership m JOIN ar_user u ON u.id=m.user_id SET m.status='revoked',m.authorization_version=m.authorization_version+1,m.updated_ms=? WHERE u.role='root' AND m.status='active'", [Date.now()]);
  await db.execute(`UPDATE ar_user u LEFT JOIN ar_merchant_membership m ON m.user_id=u.id AND m.status='active'
    SET u.role=CASE WHEN m.role IN ('manager','adminer') THEN m.role ELSE 'user' END,
      u.merchant_id=CASE WHEN m.role IN ('manager','adminer') THEN m.merchant_id ELSE NULL END
    WHERE u.role<>'root'`);
  await db.execute("UPDATE ar_user SET merchant_id=NULL WHERE role='root'");
}
