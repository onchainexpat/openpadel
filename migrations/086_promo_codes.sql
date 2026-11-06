-- Promo codes (promo_codes.ts): made by the owner or a manager, a percentage or an amount off court bookings, program
-- places or a membership's first payment, between dates, with a total number of uses, uses per person and a
-- smallest spend. Never on a gift card or a pass. One code per payment, applied before its card form opens: the
-- payment is asked again for the lower amount (or, all of it off, goes through with nothing to pay).
CREATE TABLE promo_code (
  id              uuid PRIMARY KEY,
  code            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('percent', 'amount')),
  percent         int CHECK (percent IS NULL OR percent BETWEEN 1 AND 100),
  amount_cents    int CHECK (amount_cents IS NULL OR amount_cents > 0),
  applies_to      text[] NOT NULL,
  starts_at       timestamptz,
  ends_at         timestamptz,
  max_uses        int CHECK (max_uses IS NULL OR max_uses > 0),
  max_per_person  int NOT NULL DEFAULT 1 CHECK (max_per_person > 0),
  min_spend_cents int NOT NULL DEFAULT 0 CHECK (min_spend_cents >= 0),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK ((kind = 'percent' AND percent IS NOT NULL) OR (kind = 'amount' AND amount_cents IS NOT NULL))
);
CREATE UNIQUE INDEX promo_code_code ON promo_code (upper(code));

-- Each use: the payment it lowered and what it took off. A use whose payment was never paid (called off, given up)
-- doesn't count against the code's limits.
CREATE TABLE promo_use (
  id             uuid PRIMARY KEY,
  promo_code_id  uuid NOT NULL REFERENCES promo_code,
  payment_id     uuid NOT NULL UNIQUE REFERENCES payment,
  person_id      uuid NOT NULL REFERENCES person,
  discount_cents int  NOT NULL CHECK (discount_cents > 0),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promo_use_code ON promo_use (promo_code_id);
ALTER TABLE payment ADD COLUMN promo_code_id uuid REFERENCES promo_code;
ALTER TABLE payment ADD COLUMN discount_cents int NOT NULL DEFAULT 0;

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000950', '00000000-0000-7000-8000-000000000006', 'payment.use_promo', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000951', '00000000-0000-7000-8000-000000000003', 'payment.use_promo', 'allow', 'any');
