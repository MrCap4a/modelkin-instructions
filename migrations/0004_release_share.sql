ALTER TABLE releases ADD COLUMN share_key text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;
