-- Courts blocked on a repeating pattern (block_series.ts): "Courts 1 and 2 every Tuesday 18:00 to 20:00 for the
-- league". Each date is an ordinary block (a court_block and its court_time rows), so the database still refuses two
-- things on one court at once. The series keeps the pattern, the dates taken out of it, and how far ahead its dates
-- are made: one with no end is made a year ahead, and a job adds the dates as that year moves on.
CREATE TABLE block_series (
  id          uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES location,
  court_ids   uuid[] NOT NULL CHECK (cardinality(court_ids) > 0),
  weekdays    int[] NOT NULL CHECK (cardinality(weekdays) > 0 AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]),
  starts      time NOT NULL,                       -- club time
  ends        time NOT NULL,                       -- '24:00' is midnight at the end of the day
  from_date   date NOT NULL,
  until_date  date,                                -- no end: made a year ahead, and on
  skip_dates  date[] NOT NULL DEFAULT '{}',        -- dates opened again, or changed on their own
  made_until  date NOT NULL,                       -- its dates are made up to here
  reason      text NOT NULL CHECK (reason IN ('maintenance', 'fault', 'resurfacing', 'event', 'other')),
  note        text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  CHECK (ends > starts),
  CHECK (until_date IS NULL OR until_date >= from_date)
);
CREATE INDEX block_series_to_make ON block_series (made_until) WHERE active;

-- A block that is one date of a series says which, and which date.
ALTER TABLE court_block ADD COLUMN series_id uuid REFERENCES block_series;
ALTER TABLE court_block ADD COLUMN on_date date;
CREATE INDEX court_block_series ON court_block (series_id, on_date) WHERE active;

-- The front desk blocks courts already; repeating ones too.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000540', '00000000-0000-7000-8000-000000000003', 'court.block_repeat', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000541', '00000000-0000-7000-8000-000000000003', 'court.block_repeat_end', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000542', '00000000-0000-7000-8000-000000000003', 'court.block_repeat_edit', 'allow', 'any');
