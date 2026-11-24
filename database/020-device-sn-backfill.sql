UPDATE ar_device
SET sn=uuid, uuid=NULL, updated_at=updated_at
WHERE uuid IS NOT NULL
  AND (CHAR_LENGTH(uuid)<>36 OR NOT REGEXP_LIKE(uuid, '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$', 'c'))
  AND (sn IS NULL OR CAST(sn AS BINARY)=CAST(uuid AS BINARY));
