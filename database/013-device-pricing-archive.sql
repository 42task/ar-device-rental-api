CREATE TABLE IF NOT EXISTS ar_legacy_device_pricing_archive (
  device_id int NOT NULL PRIMARY KEY,
  merchant_id int NOT NULL,
  use_fee_cents int unsigned NOT NULL,
  deposit_cents int unsigned NOT NULL,
  revision int unsigned NOT NULL,
  archived_ms bigint NOT NULL,
  KEY ix_ar_legacy_pricing_merchant (merchant_id,device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
