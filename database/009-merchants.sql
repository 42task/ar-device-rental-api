CREATE TABLE IF NOT EXISTS ar_merchant (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  name varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  origin varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  hostname varchar(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  app_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  active_config_id int,
  created_ms bigint NOT NULL,
  updated_ms bigint NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_merchant_wechat_config (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  merchant_id int NOT NULL,
  version int NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'managed',
  app_id varchar(32) NOT NULL,
  mch_id varchar(32),
  pay_enabled tinyint,
  secret_ciphertext mediumtext,
  created_ms bigint NOT NULL,
  UNIQUE KEY uq_ar_merchant_config_version (merchant_id,version),
  CONSTRAINT fk_ar_merchant_config_owner FOREIGN KEY (merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_user_wechat_identity (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id int NOT NULL,
  appid varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  unionid varchar(128),
  status varchar(16) NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_ar_wechat_identity (appid,openid),
  KEY ix_ar_wechat_identity_user (user_id,appid),
  CONSTRAINT fk_ar_wechat_identity_user FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_user_merchant_binding (
  id char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id int NOT NULL,
  source_merchant_id int,
  target_merchant_id int NOT NULL,
  target_role varchar(16) NOT NULL,
  created_by int NOT NULL,
  reason varchar(255) NOT NULL,
  created_ms bigint NOT NULL,
  expires_ms bigint NOT NULL,
  source_confirmed_ms bigint,
  consumed_ms bigint,
  KEY ix_ar_binding_user (user_id,expires_ms),
  CONSTRAINT fk_ar_binding_user FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_binding_target FOREIGN KEY (target_merchant_id) REFERENCES ar_merchant(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_user_phone_history (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id int NOT NULL,
  identity_id int,
  appid varchar(32) NOT NULL,
  phone_e164 varchar(16) NOT NULL,
  country_code varchar(3) NOT NULL,
  verified_ms bigint NOT NULL,
  code_hash char(64) NOT NULL,
  archived_ms bigint NOT NULL,
  KEY ix_ar_phone_history_user (user_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_merchant_audit (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id int NOT NULL,
  merchant_id int NOT NULL,
  action varchar(40) NOT NULL,
  target_id int,
  previous_merchant_id int,
  reason varchar(255) NOT NULL,
  created_ms bigint NOT NULL,
  KEY ix_ar_merchant_audit_owner (merchant_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO ar_merchant (id,code,name,status,origin,hostname,app_id,active_config_id,created_ms,updated_ms) VALUES (1,'default','默认商户','active','https://d.4mr.cn','d.4mr.cn','wx03dbf50c15cac06f',1,0,0);
INSERT IGNORE INTO ar_merchant_wechat_config (id,merchant_id,version,source,app_id,mch_id,pay_enabled,created_ms) VALUES (1,1,1,'legacy','wx03dbf50c15cac06f',NULL,NULL,0);
