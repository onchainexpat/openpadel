-- Tournaments and leagues (competitions.ts, brackets.ts): pairs that enter together, the draw, and the
-- fixtures they play on the program's own courts. A fixture's score is a game (game.fixture_id), entered by
-- staff or by the players with the usual confirmation.
CREATE TABLE competition (
  program_id    uuid PRIMARY KEY REFERENCES program,
  format        text NOT NULL CHECK (format IN ('groups_knockout', 'knockout', 'league')),
  group_size    int CHECK (group_size IN (3, 4)),
  match_format  text NOT NULL DEFAULT 'one_set' CHECK (match_format IN ('one_set', 'pro_set', 'best_of_three')),
  match_minutes int NOT NULL DEFAULT 45 CHECK (match_minutes BETWEEN 15 AND 240),
  legs          int NOT NULL DEFAULT 1 CHECK (legs IN (1, 2)),
  status        text NOT NULL DEFAULT 'drawn' CHECK (status IN ('drawn', 'finished', 'void')),
  drawn_at      timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

CREATE TABLE pair_entry (
  id           uuid PRIMARY KEY,
  program_id   uuid NOT NULL REFERENCES program,
  person_a     uuid NOT NULL REFERENCES person,      -- who entered (or the first one staff named)
  person_b     uuid NOT NULL REFERENCES person,      -- their partner
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'entered', 'declined', 'withdrawn')),
  seed         int,
  group_no     int,
  level        numeric(4,2),                          -- the pair's average level when the draw was made
  created_by   uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  answered_at  timestamptz,
  version      int NOT NULL DEFAULT 1,
  CHECK (person_a <> person_b)
);
CREATE INDEX pair_entry_program ON pair_entry (program_id, status);

CREATE TABLE fixture (
  id            uuid PRIMARY KEY,
  program_id    uuid NOT NULL REFERENCES program,
  stage         text NOT NULL CHECK (stage IN ('group', 'knockout', 'league')),
  group_no      int,
  round         int NOT NULL,
  slot          int NOT NULL,
  entry_a       uuid REFERENCES pair_entry,
  entry_b       uuid REFERENCES pair_entry,
  from_a        text,                                 -- 'bye', 'g1:2' (group 1, 2nd) or 'w:<fixture>' (its winner)
  from_b        text,
  court_id      uuid REFERENCES court,
  starts_at     timestamptz,
  ends_at       timestamptz,
  status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'ready', 'played', 'walkover', 'bye', 'void')),
  winner        uuid REFERENCES pair_entry,
  walkover_by   uuid REFERENCES pair_entry,
  next_id       uuid REFERENCES fixture,
  next_side     text CHECK (next_side IN ('a', 'b')),
  move_asked    text,
  move_asked_by uuid REFERENCES person,
  move_asked_at timestamptz,
  version       int NOT NULL DEFAULT 1
);
CREATE INDEX fixture_program ON fixture (program_id, stage, round);
CREATE INDEX fixture_court ON fixture (court_id, starts_at) WHERE status <> 'void';

ALTER TABLE game ADD COLUMN fixture_id uuid REFERENCES fixture;
CREATE UNIQUE INDEX game_one_per_fixture ON game (fixture_id) WHERE fixture_id IS NOT NULL AND status <> 'void';

-- Members enter with a partner, answer, withdraw, enter their own scores and ask to move a match; the front desk
-- pairs people, makes the draw, places matches, enters scores and records walkovers.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000901', '00000000-0000-7000-8000-000000000006', 'entry.invite', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000902', '00000000-0000-7000-8000-000000000006', 'entry.accept', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000903', '00000000-0000-7000-8000-000000000006', 'entry.decline', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000904', '00000000-0000-7000-8000-000000000006', 'entry.withdraw', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000905', '00000000-0000-7000-8000-000000000006', 'fixture.enter', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000906', '00000000-0000-7000-8000-000000000006', 'fixture.ask_move', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000907', '00000000-0000-7000-8000-000000000003', 'entry.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000908', '00000000-0000-7000-8000-000000000003', 'competition.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000909', '00000000-0000-7000-8000-000000000003', 'fixture.*', 'allow', 'any');
