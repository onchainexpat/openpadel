-- Accounts deleted on the database a restore replaced, to delete again (after_restore.ts, deploy/release.sh): a copy
-- from before the deletion would otherwise bring the account and its words back. The server works through them as
-- it starts, and `kumi restore` at once; each goes the same way as the deletion itself (privacy.ts).
CREATE TABLE erase_after_restore (
  person_id   uuid PRIMARY KEY REFERENCES person ON DELETE CASCADE,
  redacted_at timestamptz NOT NULL,              -- when the database before it deleted the account
  deleted_by  text CHECK (deleted_by IN ('self', 'staff')),   -- who asked, from the deletion's change (null: with a parent's, or unknown)
  queued_at   timestamptz NOT NULL DEFAULT now()
);
