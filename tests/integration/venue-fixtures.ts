import type { Database } from '../../src/core/database';
import type { Row } from '../../src/core/contracts';

/** Synthetic locations only; these helpers never load application credentials. */
export async function seedVenue(db: Database, merchantId = 1, useFeeCents = 100, depositCents = 5000): Promise<Row> {
  const now = Date.now();
  return db.insert('ar_venue', { merchant_id: merchantId, name: 'Synthetic venue', address: 'Synthetic test address',
    contact_name: '', contact_phone: '', description: 'Synthetic integration fixture', status: 'active',
    use_fee_cents: useFeeCents, deposit_cents: depositCents, version: 1, created_ms: now, updated_ms: now, updated_by: null });
}
