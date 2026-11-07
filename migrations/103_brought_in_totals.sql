-- The move-in's review (0cff98c, not released): brought_credit was one row per person and wallet, keyed by the wallet's
-- name (an export's column, or Playtomic's id), so the same wallet under another name (a renamed column, Playtomic in
-- another language, two staff with two exports, an id falling back to its name) came in twice. Now it is one total per
-- person: each run's target is the sum of that person's wallets as read, and a run moves only the difference, whatever
-- the wallets are called. Nothing real was in the old table (never released), so it is made again.
DROP TABLE brought_credit;
CREATE TABLE brought_credit (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person(id),
  system        text NOT NULL CHECK (system IN ('playtomic')),
  -- What has come over in all, in the club's currency: credit given, less what was taken back.
  cents         int NOT NULL CHECK (cents >= 0),
  -- The wallets as last read (name and amount), for staff and the member's download.
  wallets       jsonb NOT NULL DEFAULT '[]',
  action_run_id uuid NOT NULL,
  at            timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  version       int NOT NULL DEFAULT 1,
  UNIQUE (person_id, system)
);
-- One total whatever the source, so a club no longer keeps to one.
ALTER TABLE club DROP COLUMN brought_wallets_source;

-- The club's customer export as the server read it (brought_in.ts, playtomic.upload): the move-in applies only rows
-- the server parsed itself, never rows a request carries. Kept 30 days, and gone with a member who's deleted.
CREATE TABLE playtomic_upload (
  id             uuid PRIMARY KEY,
  sha256         text NOT NULL,
  file_name      text,
  rows           jsonb NOT NULL,
  wallet_columns jsonb NOT NULL DEFAULT '[]',
  problems       jsonb NOT NULL DEFAULT '[]',
  uploaded_by    uuid REFERENCES person(id),
  action_run_id  uuid NOT NULL,
  at             timestamptz NOT NULL,
  version        int NOT NULL DEFAULT 1
);
CREATE INDEX playtomic_upload_at ON playtomic_upload (at);

-- A membership's day of the month for renewals, when it isn't the day it started: one carried over from Playtomic
-- renews on Playtomic's day, kept apart so a 31st that fell on a shorter month goes back to the 31st after.
ALTER TABLE membership ADD COLUMN anchor_day int CHECK (anchor_day BETWEEN 1 AND 31);

-- Bringing credit and memberships in is the owner's, as with the club's other money settings: a manager asks.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000001011', '00000000-0000-7000-8000-000000000002', 'credit.bring_in', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000001012', '00000000-0000-7000-8000-000000000002', 'membership.bring_in', 'ask', 'any');
