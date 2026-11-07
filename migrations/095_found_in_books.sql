-- "Record as paid elsewhere" counts in the books (Kelly, 6 Nov 2026). A card payment found after a restore that the
-- staff keep is other income on the day it was paid, so Kumi's revenue matches the payment provider's. booked_cents is
-- what the books count of it now: a refund the provider made of it since takes its part back out, each refund once
-- (payment_found_refund); a payment row Kumi records for it later takes the rest back out, so it never counts twice.
-- currency is the payment's own, as the provider said it (null: not said, read as the club's); one in another
-- currency than the club's isn't put in the books (they're in the club's currency), and the staff are told so.
ALTER TABLE payment_found ADD COLUMN currency text CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE payment_found ADD COLUMN booked_cents int NOT NULL DEFAULT 0 CHECK (booked_cents >= 0);
CREATE TABLE payment_found_refund (
  provider_ref     text PRIMARY KEY,
  payment_found_id uuid NOT NULL REFERENCES payment_found,
  cents            int NOT NULL CHECK (cents >= 0),
  at               timestamptz NOT NULL DEFAULT now()
);
