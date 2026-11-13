-- The club's own logo (logo.ts), in place of the mark drawn from its name. What's kept is never the file the owner
-- gave: an SVG, PNG or JPEG is checked and drawn as a PNG on the server (at most 1024 px a side, transparent where
-- the logo is), and only images made from that PNG are ever served. Old ones stay, so undo can put one back.
CREATE TABLE club_logo (
  id          uuid PRIMARY KEY,
  png         bytea NOT NULL CHECK (octet_length(png) BETWEEN 1 AND 4000000),
  width       int NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height      int NOT NULL CHECK (height BETWEEN 1 AND 1024),
  -- What the logo looks like, worked out once: its main colour (what it's drawn in, weighted by how much of it shows),
  -- and, for a logo with its own background (no transparency, a JPEG), the colour round its edge.
  ink         text NOT NULL CHECK (ink ~ '^#[0-9a-f]{6}$'),
  backed      text CHECK (backed ~ '^#[0-9a-f]{6}$'),
  -- The background it looks made for, as read from it: the owner can say otherwise (club.logo_for).
  seems_for   text NOT NULL CHECK (seems_for IN ('light', 'dark')),
  -- The file it came from (sha256 of its bytes), so `openpadel setup` knows the same file is already the logo.
  source_sha256 text NOT NULL,
  created_by  uuid REFERENCES person,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- The club's logo, and the background it's made for: a light logo is for dark backgrounds.
ALTER TABLE club ADD COLUMN logo_id uuid REFERENCES club_logo, ADD COLUMN logo_for text CHECK (logo_for IN ('light', 'dark'));
-- club.set_logo forgets the file it was given once it's applied (the PNG is kept, the file isn't), so the hourly tidy
-- (forgetStaleInputs) reads its runs too.
DROP INDEX IF EXISTS action_run_forget;
CREATE INDEX action_run_forget ON action_run (action) WHERE action IN ('playtomic.upload', 'chat.report', 'chat.stop', 'club.set_logo');
