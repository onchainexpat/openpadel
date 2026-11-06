-- Promo code uses made after the copy a restore brought back (after_restore.ts, deploy/release.sh): their payments
-- aren't in the copy, but they still count against the code's limits, per person.
CREATE TABLE promo_use_before_restore (
  promo_code_id uuid NOT NULL REFERENCES promo_code ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES person ON DELETE CASCADE,
  n             int  NOT NULL CHECK (n > 0),
  PRIMARY KEY (promo_code_id, person_id)
);
