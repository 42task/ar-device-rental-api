CREATE TABLE IF NOT EXISTS ar_device_retired_identifier (
  kind enum('uuid','sn') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  identifier varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  original_identifier varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  device_id int NOT NULL,
  legacy_i_uuid varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (CASE WHEN kind='sn' AND CHAR_LENGTH(identifier)=36 AND IS_UUID(identifier) THEN LOWER(identifier) END) VIRTUAL,
  PRIMARY KEY (kind,identifier),
  KEY ix_ar_device_retired_identifier_device (device_id),
  KEY ix_ar_device_retired_legacy_i_uuid (legacy_i_uuid),
  CONSTRAINT fk_ar_device_retired_identifier_device FOREIGN KEY (device_id) REFERENCES ar_device(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE ar_device
  ADD COLUMN superseded tinyint NOT NULL DEFAULT 0,
  ADD COLUMN current_uuid varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (CASE WHEN superseded=0 THEN CASE WHEN CHAR_LENGTH(uuid)=36 AND IS_UUID(uuid) THEN LOWER(uuid) ELSE uuid END END) VIRTUAL,
  ADD COLUMN current_sn varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (CASE WHEN superseded=0 THEN sn END) VIRTUAL,
  ADD COLUMN current_sn_uuid varchar(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (CASE WHEN superseded=0 AND CHAR_LENGTH(sn)=36 AND IS_UUID(sn) THEN LOWER(sn) END) VIRTUAL,
  ADD UNIQUE KEY uq_ar_device_current_uuid (current_uuid),
  ADD UNIQUE KEY uq_ar_device_current_sn (current_sn),
  ADD KEY ix_ar_device_current_sn_uuid (current_sn_uuid),
  DROP INDEX uuid,
  DROP INDEX uq_ar_device_sn;
