-- Expand before rewriting values, then remove the misspelled role. Each step
-- can resume after interruption without dropping an existing adminer account.
ALTER TABLE ar_user MODIFY COLUMN role enum('user','manager','admin','root','adminer') NOT NULL DEFAULT 'user';
UPDATE ar_user SET role='adminer' WHERE role='admin';
UPDATE ar_role_audit SET previous_role='adminer' WHERE previous_role='admin';
UPDATE ar_role_audit SET next_role='adminer' WHERE next_role='admin';
ALTER TABLE ar_user MODIFY COLUMN role enum('user','manager','adminer','root') NOT NULL DEFAULT 'user';
