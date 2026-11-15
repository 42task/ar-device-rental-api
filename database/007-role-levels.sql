-- Existing roots are retained. The migration runner refuses duplicate roots
-- before any DDL and resumes these statements safely after an interrupted run.
ALTER TABLE ar_user MODIFY COLUMN role enum('user','manager','admin','root') NOT NULL DEFAULT 'user';
ALTER TABLE ar_user ADD COLUMN root_singleton tinyint GENERATED ALWAYS AS (CASE WHEN role='root' THEN 1 ELSE NULL END) STORED;
ALTER TABLE ar_user ADD UNIQUE KEY uq_ar_user_single_root (root_singleton);
