-- Accounts deleted on the database a restore replaced, to delete again (after_restore.ts, deploy/release.sh): a copy
-- from before the deletion would otherwise bring the account and its words back. The server works through them as
-- it starts, and `kumi restore` at once; each goes the same way as the deletion itself (privacy.ts).
CREATE TABLE erase_after_restore (
  person_id   uuid PRIMARY KEY REFERENCES person ON DELETE CASCADE,
  redacted_at timestamptz NOT NULL,              -- when the database before it deleted the account
  deleted_by  text CHECK (deleted_by IN ('self', 'family', 'staff')),   -- who asked (null: not known, always deleted again)
  queued_at   timestamptz NOT NULL DEFAULT now()
);
-- Who asked for an account's deletion, kept with the account itself, so every later restore knows it too: the person
-- (self), a parent or the household (family), or the club (staff). Only the club's can be kept back at a restore.
ALTER TABLE person ADD COLUMN erased_by_kind text CHECK (erased_by_kind IN ('self', 'family', 'staff'));
-- Consents stay as given, but a deletion takes the numbers and addresses kept as evidence out of them: that one
-- change (evidence to nothing, everything else the same) goes through, with no table lock (privacy.ts).
CREATE OR REPLACE RULE channel_consent_no_update AS ON UPDATE TO channel_consent
  WHERE NOT (NEW.evidence IS NULL AND OLD.evidence IS NOT NULL AND NEW.id = OLD.id AND NEW.person_id = OLD.person_id AND NEW.channel = OLD.channel
    AND NEW.purpose = OLD.purpose AND NEW.granted = OLD.granted AND NEW.source = OLD.source AND NEW.form_version IS NOT DISTINCT FROM OLD.form_version AND NEW.at = OLD.at)
  DO INSTEAD NOTHING;
-- Card payments the payment provider took that the club's database has no record of (made after the copy a restore
-- brought back, or lost): for the staff to refund in full or mark handled (after_restore_money.ts). Never refunded
-- by themselves.
CREATE TABLE payment_found (
  id            uuid PRIMARY KEY,
  provider      text NOT NULL,
  provider_ref  text NOT NULL UNIQUE,
  account       text,
  amount_cents  int NOT NULL CHECK (amount_cents >= 0),
  paid_at       timestamptz NOT NULL,
  email         text,
  description   text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'refund_asked', 'refunded', 'handled', 'refund_failed')),
  note          text,
  found_at      timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,
  version       int NOT NULL DEFAULT 1
);
-- A restore happened: card payments and refunds the provider has from after the copy's newest payment are looked up
-- when the server next starts (it has the provider; the restore may not). Each row once.
CREATE TABLE restore_check (
  id          bigserial PRIMARY KEY,
  since       timestamptz NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);
