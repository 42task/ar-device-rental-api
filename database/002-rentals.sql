-- Apply after 001-core.sql and user-schema.sql create ar_device and ar_user.
CREATE TABLE IF NOT EXISTS ar_rental_config (
  device_id int NOT NULL PRIMARY KEY,
  enabled tinyint NOT NULL DEFAULT 0,
  use_fee_cents int unsigned NOT NULL DEFAULT 0,
  deposit_cents int unsigned NOT NULL DEFAULT 0,
  version int unsigned NOT NULL DEFAULT 1,
  updated_ms bigint NOT NULL,
  updated_by int NOT NULL,
  CONSTRAINT fk_ar_rental_config_device FOREIGN KEY (device_id) REFERENCES ar_device(id) ON DELETE CASCADE
) ENGINE=InnoDB CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS ar_rental_order (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id int NOT NULL,
  device_uuid varchar(255) NOT NULL,
  device_name varchar(255) NOT NULL,
  user_id int NOT NULL,
  appid varchar(32) NOT NULL,
  payer_openid varchar(128) NOT NULL,
  mch_id varchar(32) NOT NULL,
  use_fee_cents int unsigned NOT NULL,
  deposit_cents int unsigned NOT NULL,
  total_cents int unsigned NOT NULL,
  price_version int unsigned NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY',
  status varchar(32) NOT NULL DEFAULT 'PENDING_PAYMENT',
  payment_status varchar(24) NOT NULL DEFAULT 'NOTPAY',
  out_trade_no varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  transaction_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  idempotency_key varchar(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pay_params json,
  prepay_attempted tinyint NOT NULL DEFAULT 0,
  prepay_pending_until_ms bigint,
  expires_ms bigint NOT NULL,
  created_ms bigint NOT NULL,
  updated_ms bigint NOT NULL,
  paid_ms bigint,
  started_ms bigint,
  ended_ms bigint,
  ended_by int,
  end_reason varchar(255),
  end_key varchar(80) CHARACTER SET ascii COLLATE ascii_bin,
  refund_mode varchar(16),
  refund_amount_cents int unsigned NOT NULL DEFAULT 0,
  refund_status varchar(24),
  out_refund_no varchar(32) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  refund_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin,
  settled_ms bigint,
  UNIQUE KEY uq_ar_rental_request (user_id,appid,idempotency_key),
  UNIQUE KEY uq_ar_rental_end (ended_by,end_key),
  KEY ix_ar_rental_owner (user_id,appid,id),
  KEY ix_ar_rental_device (device_id,id),
  KEY ix_ar_rental_pending (status,expires_ms),
  CONSTRAINT fk_ar_rental_order_device FOREIGN KEY (device_id) REFERENCES ar_device(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_rental_order_owner FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE RESTRICT
) ENGINE=InnoDB CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS ar_rental_slot (
  device_id int NOT NULL PRIMARY KEY,
  rental_id int NOT NULL UNIQUE,
  state varchar(24) NOT NULL,
  expires_ms bigint,
  CONSTRAINT fk_ar_rental_slot_device FOREIGN KEY (device_id) REFERENCES ar_device(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_rental_slot_order FOREIGN KEY (rental_id) REFERENCES ar_rental_order(id) ON DELETE RESTRICT
) ENGINE=InnoDB CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS ar_rental_event (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rental_id int NOT NULL,
  actor_user_id int,
  event varchar(40) NOT NULL,
  details json,
  created_ms bigint NOT NULL,
  KEY ix_ar_rental_event_order (rental_id,id),
  CONSTRAINT fk_ar_rental_event_order FOREIGN KEY (rental_id) REFERENCES ar_rental_order(id) ON DELETE RESTRICT
) ENGINE=InnoDB CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS ar_rental_job (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rental_id int NOT NULL,
  kind varchar(32) NOT NULL,
  available_ms bigint NOT NULL,
  locked_until_ms bigint,
  locked_by varchar(64),
  attempts int NOT NULL DEFAULT 0,
  finished tinyint NOT NULL DEFAULT 0,
  last_error varchar(255),
  UNIQUE KEY uq_ar_rental_job (rental_id,kind),
  KEY ix_ar_rental_job_due (finished,available_ms,locked_until_ms),
  CONSTRAINT fk_ar_rental_job_order FOREIGN KEY (rental_id) REFERENCES ar_rental_order(id) ON DELETE RESTRICT
) ENGINE=InnoDB CHARACTER SET utf8mb4;
