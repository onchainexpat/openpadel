-- Coach tools (v1 scope, Coaches): who came to a program date or a lesson, and a private calendar link per
-- coach. A mark is "came" or "didn't come"; cleared (null) is the same as never marked. "Didn't come" counts
-- in a player's no-show record like an open match's, and setting a clinic's levels leaves out whoever didn't
-- come. Marking runs from the start until 48 hours after, like open-match no-shows.
CREATE TABLE attendance (
  id         uuid PRIMARY KEY,
  session_id uuid REFERENCES session,
  booking_id uuid REFERENCES booking,
  person_id  uuid NOT NULL REFERENCES person,
  came       boolean,                              -- null: cleared, as if never marked
  marked_by  uuid REFERENCES person,
  marked_at  timestamptz NOT NULL,
  version    int NOT NULL DEFAULT 1,
  CHECK ((session_id IS NULL) <> (booking_id IS NULL))
);
CREATE UNIQUE INDEX attendance_session_one ON attendance (session_id, person_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX attendance_booking_one ON attendance (booking_id, person_id) WHERE booking_id IS NOT NULL;
CREATE INDEX attendance_person ON attendance (person_id, marked_at);

-- A coach's calendar link: a long random token in the address, one live at a time. A new one ends the old.
-- It isn't an action: the token is a secret, and the change log would keep it (like push devices).
CREATE TABLE calendar_feed (
  id         uuid PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES person,
  token      text NOT NULL UNIQUE CHECK (char_length(token) >= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX calendar_feed_one ON calendar_feed (person_id) WHERE revoked_at IS NULL;

-- Coaches mark the sessions and lessons they run; front desk marks any (owners and managers have '*').
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000170', '00000000-0000-7000-8000-000000000004', 'attendance.mark', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000171', '00000000-0000-7000-8000-000000000003', 'attendance.mark', 'allow', 'any');
