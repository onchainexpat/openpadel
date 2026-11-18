-- Moving in from CourtReserve or Playbypoint (move_files.ts, docs/setup/moving-from-courtreserve.md): the files the
-- club exports there, read by the server and kept 30 days, then brought in step by step: members, memberships, club
-- credit, upcoming bookings and program sign-ups. Each step is a previewed change of its own.

-- A file as the server read it: the steps apply only rows the server parsed itself, never rows a request carries.
-- What kind of file it is decides which steps read it: people (a members list, a membership report, a credit list),
-- bookings, or program sign-ups. The change log keeps its hash and counts, never the people in it (actions.ts).
CREATE TABLE move_upload (
  id            uuid PRIMARY KEY,
  system        text NOT NULL CHECK (system IN ('courtreserve', 'playbypoint')),
  kind          text NOT NULL CHECK (kind IN ('people', 'bookings', 'programs')),
  sha256        text NOT NULL,
  file_name     text,
  rows          jsonb NOT NULL,
  row_count     int NOT NULL DEFAULT 0,
  -- Which column was read as what ({"what": "email", "name": "Email Address"}), for the preview and the staff app.
  columns       jsonb NOT NULL DEFAULT '[]',
  problems      jsonb NOT NULL DEFAULT '[]',
  uploaded_by   uuid REFERENCES person(id),
  action_run_id uuid NOT NULL,
  at            timestamptz NOT NULL,
  version       int NOT NULL DEFAULT 1
);
CREATE INDEX move_upload_at ON move_upload (system, kind, at);

-- Credit and memberships brought from either, beside Playtomic's: one total per person and system.
ALTER TABLE brought_credit DROP CONSTRAINT brought_credit_system_check;
ALTER TABLE brought_credit ADD CONSTRAINT brought_credit_system_check CHECK (system IN ('playtomic', 'courtreserve', 'playbypoint'));
ALTER TABLE membership DROP CONSTRAINT membership_brought_from_check;
ALTER TABLE membership ADD CONSTRAINT membership_brought_from_check CHECK (brought_from IN ('playtomic', 'courtreserve', 'playbypoint'));

-- CourtReserve is a source the guide knows now.
ALTER TABLE move_in DROP CONSTRAINT move_in_source_check;
ALTER TABLE move_in ADD CONSTRAINT move_in_source_check CHECK (source IN ('playtomic', 'playbypoint', 'courtreserve', 'spreadsheet'));

-- Bringing credit and memberships in is the owner's, as from Playtomic: a manager asks.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000013501', '00000000-0000-7000-8000-000000000002', 'move.credit', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000013502', '00000000-0000-7000-8000-000000000002', 'move.memberships', 'ask', 'any');

-- What the file holds is forgotten from a preview nobody confirmed (actions.ts, forgetStaleInputs).
DROP INDEX IF EXISTS action_run_forget;
CREATE INDEX action_run_forget ON action_run (action) WHERE action IN ('playtomic.upload', 'chat.report', 'chat.stop', 'club.set_logo', 'move.upload');
