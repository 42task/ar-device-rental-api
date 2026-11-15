CREATE TABLE IF NOT EXISTS ar_application (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  legacy_merchant_id int NOT NULL UNIQUE,
  name varchar(128) NOT NULL,
  app_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  origin varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hostname varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  status varchar(16) NOT NULL DEFAULT 'active',
  credential_source varchar(24) NOT NULL DEFAULT 'managed',
  secret_ciphertext mediumtext,
  secret_account varchar(64) NOT NULL,
  secret_revision int NOT NULL DEFAULT 1,
  created_ms bigint NOT NULL,
  updated_ms bigint NOT NULL,
  CONSTRAINT fk_ar_application_legacy_owner FOREIGN KEY (legacy_merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_application_merchant (
  application_id int NOT NULL,
  merchant_id int NOT NULL UNIQUE,
  PRIMARY KEY (application_id,merchant_id),
  CONSTRAINT fk_ar_application_link_entry FOREIGN KEY (application_id) REFERENCES ar_application(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_application_link_merchant FOREIGN KEY (merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
