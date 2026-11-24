ALTER TABLE ar_rental_order
  MODIFY COLUMN device_uuid varchar(255) NULL,
  ADD COLUMN device_sn varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER device_uuid,
  ADD CONSTRAINT chk_ar_rental_order_identifier_present CHECK (device_uuid IS NOT NULL OR device_sn IS NOT NULL);
