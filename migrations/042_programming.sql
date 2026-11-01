-- Programming: a minimum to run, and "tell me when a place opens" (data_model.md 7, action_catalogue.md
-- series.edit). Editing and cancelling a program's dates need no new columns: dates move in place and the
-- change log keeps what they were.

-- A minimum to run: at the decision time (this many hours before the first date, or the club's default),
-- a program short of its minimum is cancelled and everyone gets their money back. Staff hear first, once.
ALTER TABLE program ADD COLUMN min_players int CHECK (min_players IS NULL OR min_players > 0);
ALTER TABLE program ADD COLUMN decide_hours int CHECK (decide_hours IS NULL OR decide_hours BETWEEN 1 AND 336);
ALTER TABLE program ADD COLUMN min_heads_up_at timestamptz;   -- staff were told it's short (once)
ALTER TABLE program ADD COLUMN min_decided_at timestamptz;    -- decided (once): it runs, or it was cancelled
ALTER TABLE program ADD COLUMN cancelled_at timestamptz;
ALTER TABLE program ADD COLUMN cancel_reason text CHECK (cancel_reason IN ('club', 'below_minimum'));

ALTER TABLE club ADD COLUMN program_decide_hours int NOT NULL DEFAULT 24 CHECK (program_decide_hours BETWEEN 1 AND 336);
ALTER TABLE club ADD COLUMN program_heads_up_hours int NOT NULL DEFAULT 24 CHECK (program_heads_up_hours BETWEEN 0 AND 336);

-- "Tell me when a place opens": one message the first time a place is free to anyone (the waitlist's
-- offers come first). A watch is used once it's told, or ends when the person signs up.
CREATE TABLE program_watch (
  id         uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES program,
  person_id  uuid NOT NULL REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  told_at    timestamptz,
  ended_at   timestamptz,
  version    int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX program_watch_one ON program_watch (program_id, person_id) WHERE told_at IS NULL AND ended_at IS NULL;
CREATE INDEX program_watch_open ON program_watch (program_id) WHERE told_at IS NULL AND ended_at IS NULL;

-- Members (and parents, for their juniors) watch a full program; owners and managers edit, cancel and set
-- minimums through '*'.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000200', '00000000-0000-7000-8000-000000000006', 'program.watch', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000201', '00000000-0000-7000-8000-000000000006', 'program.unwatch', 'allow', 'own');
