-- Read-only (read_only.ts): the host's switch for an account that isn't paid, `kumi read-only on|off`. Everyone
-- still signs in, sees everything and downloads their data, and the owner can download everything; nothing new
-- is sold or charged, and money still goes back to members.
ALTER TABLE club ADD COLUMN read_only_since timestamptz;
