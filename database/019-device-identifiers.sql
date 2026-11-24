ALTER TABLE ar_device
  MODIFY COLUMN uuid varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD UNIQUE KEY uq_ar_device_sn (sn),
  ADD CONSTRAINT chk_ar_device_identifier_present CHECK (
    (uuid IS NULL OR CHAR_LENGTH(TRIM(uuid)) > 0)
    AND (sn IS NULL OR CHAR_LENGTH(TRIM(sn)) > 0)
    AND (uuid IS NOT NULL OR sn IS NOT NULL)
  );
