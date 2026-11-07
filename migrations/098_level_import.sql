-- A starting level from another app (level_import.ts): staff record what they saw in a player's app, a player
-- claims their own, and a club moving in brings its Playtomic levels. Each is a provisional start (rating_event
-- 'import_seed', which the schema always had), never a floor, and only while the player is new here.

-- A player can take an import away while new: the removal is its own event, and a replay leaves the import out.
ALTER TABLE rating_event DROP CONSTRAINT rating_event_kind_check;
ALTER TABLE rating_event ADD CONSTRAINT rating_event_kind_check
  CHECK (kind IN ('game', 'staff_set', 'floor', 'import_seed', 'import_removed', 'recompute', 'self_adjust'));

-- A claim above the club's line waits for staff in the level queue, with what the player said.
ALTER TABLE level_review DROP CONSTRAINT level_review_kind_check;
ALTER TABLE level_review ADD CONSTRAINT level_review_kind_check CHECK (kind IN ('request', 'move', 'import'));
ALTER TABLE level_review ADD COLUMN claim jsonb;

-- Claims of a starting level above this wait for staff; at or below it they start as the player's own say.
ALTER TABLE club ADD COLUMN level_import_line double precision NOT NULL DEFAULT 4.5
  CHECK (level_import_line >= 0 AND level_import_line <= 7);

-- Members claim and take back their own; front desk records what it saw (coaches and managers can already,
-- through level.*).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000990', '00000000-0000-7000-8000-000000000006', 'level.claim', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000991', '00000000-0000-7000-8000-000000000006', 'level.remove_import', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000992', '00000000-0000-7000-8000-000000000003', 'level.import', 'allow', 'any');
