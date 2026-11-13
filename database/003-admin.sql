CREATE TABLE IF NOT EXISTS ar_admin_login_challenge (
  id char(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  browser_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origin varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  confirmation_code char(6) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  scanned_user_id int,
  created_ms bigint NOT NULL,
  expires_ms bigint NOT NULL,
  consumed_ms bigint,
  qrcode_image mediumblob,
  KEY ix_ar_admin_challenge_expiry (expires_ms),
  CONSTRAINT fk_ar_admin_challenge_user FOREIGN KEY (scanned_user_id) REFERENCES ar_user(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS ar_admin_session (
  id char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id int NOT NULL,
  appid varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_ms bigint NOT NULL,
  expires_ms bigint NOT NULL,
  revoked_ms bigint,
  KEY ix_ar_admin_session_expiry (expires_ms),
  CONSTRAINT fk_ar_admin_session_user FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4;
