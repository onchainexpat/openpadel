-- Every Playtomic court the last sync saw, with its name, so staff see which court each link is.
ALTER TABLE connector_status ADD COLUMN IF NOT EXISTS courts jsonb NOT NULL DEFAULT '[]';
