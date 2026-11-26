ALTER TABLE drafts ADD COLUMN deleted_at timestamptz;
CREATE INDEX drafts_trash_expiry ON drafts(deleted_at) WHERE deleted_at IS NOT NULL;
