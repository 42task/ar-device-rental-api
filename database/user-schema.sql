-- Fresh installation only: these tables never reference the previous backend.
CREATE TABLE IF NOT EXISTS ar_user (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  appid varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  unionid varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  nickname varchar(128),
  avatar varchar(1024),
  tel varchar(32),
  role enum('user','manager','admin','root') NOT NULL DEFAULT 'user',
  root_singleton tinyint GENERATED ALWAYS AS (CASE WHEN role='root' THEN 1 ELSE NULL END) STORED,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ar_user_identity (appid,openid),
  UNIQUE KEY uq_ar_user_single_root (root_singleton),
  KEY ix_ar_user_role (role,id)
) ENGINE=InnoDB CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS ar_role_audit (
  id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id int,
  target_user_id int NOT NULL,
  previous_role varchar(16) NOT NULL,
  next_role varchar(16) NOT NULL,
  source varchar(24) NOT NULL,
  reason varchar(255) NOT NULL,
  created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_ar_role_target (target_user_id,id)
) ENGINE=InnoDB CHARACTER SET utf8mb4;

-- Serialize bootstrap and role changes, including the initial empty root set.
CREATE TABLE IF NOT EXISTS ar_admin_guard (id tinyint NOT NULL PRIMARY KEY) ENGINE=InnoDB;
INSERT IGNORE INTO ar_admin_guard(id) VALUES(1);
