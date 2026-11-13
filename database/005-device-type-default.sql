-- Apply the new default to new rows only; existing device types are preserved.
ALTER TABLE ar_device ALTER COLUMN device_type SET DEFAULT 'rokid studio2';
