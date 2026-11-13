CREATE TABLE IF NOT EXISTS ar_user_phone (
  user_id int NOT NULL PRIMARY KEY,
  appid varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phone_e164 varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  country_code varchar(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  verified_ms bigint NOT NULL,
  code_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  UNIQUE KEY uq_ar_user_phone_number (appid,phone_e164),
  CONSTRAINT fk_ar_user_phone_user FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4;
