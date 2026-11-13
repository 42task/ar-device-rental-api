-- Only newly inserted rows use the canonical model name; existing rows are untouched.
ALTER TABLE ar_device ALTER COLUMN device_type SET DEFAULT 'Rokid Studio2';
