CREATE TABLE IF NOT EXISTS ar_user_avatar (
  user_id int NOT NULL PRIMARY KEY,
  token char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  image_data mediumblob NOT NULL,
  image_mime varchar(32) CHARACTER SET ascii NOT NULL,
  UNIQUE KEY uq_ar_user_avatar_token (token),
  CONSTRAINT fk_ar_user_avatar_user FOREIGN KEY (user_id) REFERENCES ar_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
