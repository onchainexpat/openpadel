-- Level tools (v1 scope, Levels): a player asks the club to review their level (free, once every 30 days),
-- or, while new, moves their own level once; staff answer reviews and check big moves from one queue, and
-- set levels for everyone in a clinic session in one go.
CREATE TABLE level_review (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,
  kind        text NOT NULL CHECK (kind IN ('request', 'move')),   -- the player asked; or staff checked a big move
  note        text,                                                -- the player's, when they asked
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'changed')),
  level_at    numeric(4,2),                                        -- the level once answered: the next big move counts from here
  answer      text,                                                -- what staff said
  answered_by uuid REFERENCES person,
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX level_review_one_open ON level_review (person_id) WHERE status = 'open';
CREATE INDEX level_review_person ON level_review (person_id, created_at);

-- A player's own move, while new: kept as how far they moved it, so a replay applies it to the replayed level.
ALTER TABLE rating_event DROP CONSTRAINT rating_event_kind_check;
ALTER TABLE rating_event ADD CONSTRAINT rating_event_kind_check CHECK (kind IN ('game', 'staff_set', 'floor', 'import_seed', 'recompute', 'self_adjust'));

-- Members ask for a review and move their own level; front desk answers the queue and levels a clinic
-- session (coaches can already change levels; other level changes still ask a manager).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000131', '00000000-0000-7000-8000-000000000006', 'level.request_review', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000132', '00000000-0000-7000-8000-000000000006', 'level.self_adjust', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000133', '00000000-0000-7000-8000-000000000003', 'level.answer_review', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000134', '00000000-0000-7000-8000-000000000003', 'level.set_session', 'allow', 'any');
