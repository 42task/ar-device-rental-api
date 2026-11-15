CREATE TABLE IF NOT EXISTS ar_merchant_branding (
  merchant_id int NOT NULL PRIMARY KEY,
  display_name varchar(64) NOT NULL,
  theme varchar(16) CHARACTER SET ascii NOT NULL DEFAULT 'aero',
  logo_url varchar(2048) NOT NULL DEFAULT '',
  logo_data mediumblob,
  logo_mime varchar(32) CHARACTER SET ascii,
  version int unsigned NOT NULL,
  updated_ms bigint NOT NULL,
  updated_by int NOT NULL,
  CONSTRAINT fk_ar_branding_merchant FOREIGN KEY (merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_branding_actor FOREIGN KEY (updated_by) REFERENCES ar_user(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
