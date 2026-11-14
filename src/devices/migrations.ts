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
