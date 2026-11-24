import type { Database } from '../core/database';

/** Archive deprecated device money; venue pricing and order snapshots are untouched. */
export async function archiveDevicePricing(db: Database): Promise<void> {
  const use = await db.one("SHOW COLUMNS FROM ar_rental_config WHERE Field='use_fee_cents'");
  const deposit = await db.one("SHOW COLUMNS FROM ar_rental_config WHERE Field='deposit_cents'");
  if (use || deposit) {
    await db.execute(`INSERT IGNORE INTO ar_legacy_device_pricing_archive
      (device_id,merchant_id,use_fee_cents,deposit_cents,revision,archived_ms)
      SELECT device_id,merchant_id,${use ? 'use_fee_cents' : '0'},${deposit ? 'deposit_cents' : '0'},version,? FROM ar_rental_config`, [Date.now()]);
  }
  if (use) await db.execute('ALTER TABLE ar_rental_config DROP COLUMN use_fee_cents');
  if (deposit) await db.execute('ALTER TABLE ar_rental_config DROP COLUMN deposit_cents');
}

const canonicalUuid = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
const legacyUuid = "device.uuid IS NOT NULL AND (CHAR_LENGTH(device.uuid)<>36 OR NOT REGEXP_LIKE(device.uuid, ?, 'c'))";

/** Run with the migration journal in the same transaction. */
export async function backfillDeviceSerialNumbers(db: Database, sql: string): Promise<void> {
  const conflicts = await db.one(`SELECT COUNT(*) AS total FROM ar_device device
    WHERE ${legacyUuid} AND (
      (device.sn IS NOT NULL AND CAST(device.sn AS BINARY)<>CAST(device.uuid AS BINARY))
      OR EXISTS (SELECT 1 FROM ar_device other WHERE other.sn=device.uuid AND other.id<>device.id)
    )`, [canonicalUuid]);
  const count = Number(conflicts?.total || 0);
  if (count) throw new Error(`Device SN backfill found ${count} device(s) with conflicting SN assignments.`);

  try {
    await db.execute(sql);
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') throw new Error('Device SN backfill found a duplicate target SN.');
    throw error;
  }

  const remaining = await db.one(`SELECT device.id FROM ar_device device
    WHERE ${legacyUuid} LIMIT 1 FOR UPDATE`, [canonicalUuid]);
  if (remaining) throw new Error('Device SN backfill left legacy identifiers in the UUID column.');
}

export async function checkNormalizedDeviceUuids(db: Database): Promise<void> {
  const collision = await db.one(`SELECT LOWER(uuid) AS normalized FROM ar_device
    WHERE CHAR_LENGTH(uuid)=36 AND IS_UUID(uuid)
    GROUP BY LOWER(uuid) HAVING COUNT(*)>1 LIMIT 1`);
  if (collision) throw new Error('Device UUIDs differ only by case. Resolve the conflicting registrations before migrating.');
}
