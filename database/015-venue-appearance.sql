CREATE TABLE IF NOT EXISTS ar_venue_appearance (
  venue_id int NOT NULL PRIMARY KEY,
  merchant_id int NOT NULL,
  theme varchar(16) CHARACTER SET ascii NOT NULL DEFAULT 'aero',
  image_url varchar(2048) NOT NULL DEFAULT '',
  image_data mediumblob,
  image_mime varchar(32) CHARACTER SET ascii,
  version int unsigned NOT NULL,
  updated_ms bigint NOT NULL,
  updated_by int NOT NULL,
  CONSTRAINT fk_ar_appearance_venue_merchant FOREIGN KEY (venue_id,merchant_id) REFERENCES ar_venue(id,merchant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_appearance_actor FOREIGN KEY (updated_by) REFERENCES ar_user(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
