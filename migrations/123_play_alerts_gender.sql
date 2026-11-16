-- "Tell me when" (the boards' priority alerts): a member asks to hear when a court frees up on a day, in a window of
-- start times they pick at one location, or when an open match opens whose level band fits theirs. One message per
-- freed time or match, through the usual messages (consent, quiet hours, push and email; never a text), and a cap
-- in messages.ts. A court alert lasts for its day; a match alert until it's turned off.
CREATE TABLE play_alert (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,
  kind        text NOT NULL CHECK (kind IN ('court', 'match')),
  location_id uuid REFERENCES location,          -- a match alert without one: any of the club's locations
  on_date     date,                              -- a court alert's day and window, in the location's time
  from_time   time,
  until_time  time,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  version     int NOT NULL DEFAULT 1,
  CHECK (kind = 'match' OR (location_id IS NOT NULL AND on_date IS NOT NULL AND from_time IS NOT NULL AND until_time IS NOT NULL AND from_time < until_time))
);
CREATE UNIQUE INDEX play_alert_match_one ON play_alert (person_id) WHERE kind = 'match' AND ended_at IS NULL;
CREATE UNIQUE INDEX play_alert_court_one ON play_alert (person_id, location_id, on_date) WHERE kind = 'court' AND ended_at IS NULL;
CREATE INDEX play_alert_court_day ON play_alert (on_date) WHERE kind = 'court' AND ended_at IS NULL;

-- Members (and parents, for their juniors) turn their own alerts on and off; owners and managers have '*'.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000012301', '00000000-0000-7000-8000-000000000006', 'play_alert.set', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000012302', '00000000-0000-7000-8000-000000000006', 'play_alert.end', 'allow', 'own');

-- Who a match or event is meant for, as the club or host says: a label people choose by, and Play filters by. Nobody
-- is checked against it (the club doesn't keep anyone's gender). Empty: open to all.
ALTER TABLE open_match ADD COLUMN gender text CHECK (gender IN ('mixed', 'women', 'men'));
ALTER TABLE program ADD COLUMN gender text CHECK (gender IN ('mixed', 'women', 'men', 'mixed_pairs'));
