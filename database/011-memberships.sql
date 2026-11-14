CREATE TABLE IF NOT EXISTS ar_merchant_membership (
  user_id int NOT NULL PRIMARY KEY,
  merchant_id int NOT NULL,
  role varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  authorization_version int unsigned NOT NULL DEFAULT 1,
  updated_ms bigint NOT NULL,
  KEY ix_ar_membership_merchant (merchant_id,status,user_id),
  CONSTRAINT fk_ar_membership_user FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_membership_merchant FOREIGN KEY (merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
