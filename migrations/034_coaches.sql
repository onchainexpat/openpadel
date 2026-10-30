-- Coaches (v1 scope, Coaches): a profile members see, the hours a coach gives private lessons, time off,
-- and a rate for each lesson length (court included). A private lesson is a court booking with a coach; a
-- program session can name the coach who runs it. Photos are small and few, so they live in the database
-- (there's no file store), checked when they're added and served only for a coach's profile.
CREATE TABLE photo (
  id           uuid PRIMARY KEY,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 160000),
  created_by   uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coach (
  person_id   uuid PRIMARY KEY REFERENCES person,
  bio         text CHECK (char_length(bio) <= 600),
  level_min   numeric(3,2),
  level_max   numeric(3,2),
  languages   text[] NOT NULL DEFAULT '{en}',
  rates       jsonb NOT NULL DEFAULT '{}',              -- cents by lesson length in minutes: {"60": 9000}
  photo_id    uuid REFERENCES photo,
  lessons     boolean NOT NULL DEFAULT true,            -- members can book private lessons with them
  max_players int NOT NULL DEFAULT 4 CHECK (max_players BETWEEN 1 AND 4),
  active      boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1,
  CHECK (level_min IS NULL OR level_max IS NULL OR level_max >= level_min)
);

-- When a coach gives lessons, week by week, at a location (more than one stretch a day is fine).
CREATE TABLE coach_hours (
  id          uuid PRIMARY KEY,
  coach_id    uuid NOT NULL REFERENCES coach,
  location_id uuid NOT NULL REFERENCES location,
  weekday     int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts      time NOT NULL,
  ends        time NOT NULL CHECK (ends > starts),
  active      boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1
);
CREATE INDEX coach_hours_coach ON coach_hours (coach_id) WHERE active;

CREATE TABLE coach_time_off (
  id       uuid PRIMARY KEY,
  coach_id uuid NOT NULL REFERENCES coach,
  during   tstzrange NOT NULL CHECK (NOT isempty(during)),
  note     text,
  active   boolean NOT NULL DEFAULT true,
  version  int NOT NULL DEFAULT 1
);
CREATE INDEX coach_time_off_coach ON coach_time_off USING gist (coach_id, during) WHERE active;

-- A lesson is a booking with a coach; a session can say who runs it.
ALTER TABLE booking DROP CONSTRAINT booking_kind_check;
ALTER TABLE booking ADD CONSTRAINT booking_kind_check CHECK (kind IN ('court', 'lesson'));
ALTER TABLE booking ADD COLUMN coach_id uuid REFERENCES person;
ALTER TABLE booking ADD CONSTRAINT booking_lesson_coach CHECK ((kind = 'lesson') = (coach_id IS NOT NULL));
CREATE INDEX booking_coach ON booking (coach_id) WHERE coach_id IS NOT NULL;
ALTER TABLE session ADD COLUMN coach_id uuid REFERENCES person;
CREATE INDEX session_coach ON session (coach_id, starts_at) WHERE coach_id IS NOT NULL;

-- Coaches keep their own profile, hours and time off, cancel their own lessons (players get everything
-- back), and set levels only after sessions they run. Front desk keeps any coach's profile, and books
-- lessons for members like courts (booking.*). Members book lessons for themselves.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000135', '00000000-0000-7000-8000-000000000004', 'coach.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000136', '00000000-0000-7000-8000-000000000003', 'coach.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000137', '00000000-0000-7000-8000-000000000004', 'booking.cancel', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000138', '00000000-0000-7000-8000-000000000004', 'level.set_session', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000139', '00000000-0000-7000-8000-000000000006', 'lesson.request', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000140', '00000000-0000-7000-8000-000000000003', 'lesson.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000141', '00000000-0000-7000-8000-000000000003', 'session.set_coach', 'allow', 'any');
