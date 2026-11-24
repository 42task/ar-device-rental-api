UPDATE ar_device
SET sn=uuid, uuid=NULL, updated_at=updated_at
WHERE uuid IS NOT NULL AND (CHAR_LENGTH(uuid)<>36 OR NOT IS_UUID(uuid));

UPDATE ar_rental_order o
SET device_sn=o.device_uuid, device_uuid=NULL
WHERE o.device_uuid IS NOT NULL AND o.device_sn IS NULL
  AND (
    CHAR_LENGTH(o.device_uuid)<>36 OR NOT IS_UUID(o.device_uuid)
    OR EXISTS (
      SELECT 1 FROM ar_device d WHERE d.id=o.device_id
        AND (CAST(d.sn AS BINARY)=CAST(o.device_uuid AS BINARY) OR EXISTS (
          SELECT 1 FROM ar_device_retired_identifier sn_history
          WHERE sn_history.device_id=d.id AND sn_history.kind='sn'
            AND sn_history.identifier=o.device_uuid COLLATE utf8mb4_bin
            AND CAST(sn_history.original_identifier AS BINARY)=CAST(o.device_uuid AS BINARY)
        ))
        AND NOT (LOWER(d.uuid) <=> LOWER(o.device_uuid COLLATE utf8mb4_bin))
        AND NOT EXISTS (
          SELECT 1 FROM ar_device_retired_identifier uuid_history
          WHERE uuid_history.device_id=d.id AND uuid_history.kind='uuid'
            AND uuid_history.identifier=LOWER(o.device_uuid) COLLATE utf8mb4_bin
        )
    )
  );
