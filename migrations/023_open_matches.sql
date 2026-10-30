-- Open matches: a "pay my part" booking its organiser (the host) opens to other players, with a level band.
-- Players inside the band join and pay their place at once; outside it they ask the host. A seat taken
-- but not paid for is held a short while, then opens again. Places still empty at the club's deadline
-- go on the host's saved card, as for any "pay my part" booking.

CREATE TABLE open_match (
  booking_id   uuid PRIMARY KEY REFERENCES booking,
  level_min    numeric(4,2) NOT NULL,
  level_max    numeric(4,2) NOT NULL,
  outside_band text NOT NULL DEFAULT 'ask' CHECK (outside_band IN ('ask', 'closed')),   -- outside it: ask the host, or no
  rated        boolean NOT NULL DEFAULT true,     -- a friendly never moves levels
  listed       boolean NOT NULL DEFAULT true,     -- on the Play page, or only by its link
  note         text,
  version      int NOT NULL DEFAULT 1,
  CHECK (level_max >= level_min)
);

CREATE TABLE join_request (
  id          uuid PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES booking,
  person_id   uuid NOT NULL REFERENCES person,
  level       numeric(4,2),                       -- theirs when they asked; none: no level yet
  note        text,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'declined', 'withdrawn')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  version     int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX join_request_open ON join_request (booking_id, person_id) WHERE status = 'requested';
CREATE INDEX join_request_booking ON join_request (booking_id);

-- A seat taken but not paid for yet: held until then, and opened again after.
ALTER TABLE booking_player ADD COLUMN held_until timestamptz;

-- Members ask to join a match outside its band, take the request back, and (as its host) answer them.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000100', '00000000-0000-7000-8000-000000000006', 'booking.ask', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000101', '00000000-0000-7000-8000-000000000006', 'booking.withdraw_ask', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000102', '00000000-0000-7000-8000-000000000006', 'booking.answer_ask', 'allow', 'own');
