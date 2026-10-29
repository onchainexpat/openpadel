-- Games and the draws that make them (data_model.md 5 and 7). A format plugin (Americano first)
-- writes rounds as games; finished games keep their scores when the rest is re-paired.
CREATE TABLE rating (
  person_id        uuid NOT NULL REFERENCES person,
  sport            text NOT NULL DEFAULT 'padel',
  mu               double precision,
  sigma            double precision,
  level            numeric(4,2) NOT NULL,
  rated_games      int NOT NULL DEFAULT 0,
  provisional      boolean NOT NULL DEFAULT true,
  floor            numeric(4,2),
  floor_set_by     uuid REFERENCES person,
  floor_reason     text,
  self_adjust_used numeric(3,2) NOT NULL DEFAULT 0,
  version          int NOT NULL DEFAULT 1,
  PRIMARY KEY (person_id, sport)
);

CREATE TABLE draw (
  session_id      uuid PRIMARY KEY REFERENCES session,
  format          text NOT NULL CHECK (format IN ('americano', 'mexicano', 'king_of_court')),
  points_per_game int  NOT NULL DEFAULT 24 CHECK (points_per_game > 0),
  rounds          int  NOT NULL CHECK (rounds > 0),
  seed            text NOT NULL,
  status          text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'finished', 'void')),
  version         int  NOT NULL DEFAULT 1
);

CREATE TABLE game (
  id             uuid PRIMARY KEY,
  session_id     uuid REFERENCES session,
  round          int,
  court_id       uuid REFERENCES court,
  format         text NOT NULL DEFAULT 'doubles',
  rated          boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'awaiting_confirmation', 'confirmed', 'disputed', 'void')),
  predicted_a    numeric(4,3),
  played_at      timestamptz,
  entered_by     uuid REFERENCES person,
  editable_until timestamptz,
  version        int NOT NULL DEFAULT 1
);
CREATE INDEX game_session ON game (session_id, round);

CREATE TABLE game_side (
  game_id   uuid NOT NULL REFERENCES game,
  side      text NOT NULL CHECK (side IN ('a', 'b')),
  person_id uuid NOT NULL REFERENCES person,
  PRIMARY KEY (game_id, person_id)
);

CREATE TABLE game_set (
  game_id uuid NOT NULL REFERENCES game,
  set_no  int  NOT NULL,
  a       int  NOT NULL CHECK (a >= 0),
  b       int  NOT NULL CHECK (b >= 0),
  PRIMARY KEY (game_id, set_no)
);

-- Front desk runs the draw and enters scores on the night.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000040', '00000000-0000-7000-8000-000000000003', 'draw.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000041', '00000000-0000-7000-8000-000000000003', 'game.score', 'allow', 'any');
