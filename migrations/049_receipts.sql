-- Receipts (receipts.ts). Every payment that goes through, and every refund sent, gets a numbered receipt for
-- whoever paid (a kid's charge on the family card: the parent who saved the card), by email and in the app.
-- Several courts paid with one card payment share one receipt (receipt_payment links each payment to it).
--
-- Only payments and refunds from now on get one: an update doesn't send receipts for what was paid before it
-- (club.receipts_from). Numbers come from one sequence, so they never repeat, even across a restore.
ALTER TABLE club ADD COLUMN receipts_from timestamptz NOT NULL DEFAULT now();

CREATE SEQUENCE receipt_number START 1001;
CREATE TABLE receipt (
  id           uuid PRIMARY KEY,
  number       bigint NOT NULL UNIQUE DEFAULT nextval('receipt_number'),
  kind         text NOT NULL CHECK (kind IN ('payment', 'refund')),
  person_id    uuid NOT NULL REFERENCES person,       -- who it's for: whoever paid
  for_person_id uuid REFERENCES person,               -- a kid it was for, when a parent paid
  payment_id   uuid NOT NULL REFERENCES payment,      -- the payment (the first, for several paid together)
  refund_id    uuid REFERENCES refund,                -- a refund receipt's refund
  location_id  uuid REFERENCES location,
  lines        jsonb NOT NULL,                        -- [{ "what": { "en", "es" }, "cents" }]
  subtotal_cents int NOT NULL,
  tax_cents    int NOT NULL DEFAULT 0,
  total_cents  int NOT NULL,
  method       text NOT NULL,                         -- card, cash, terminal, other, credit (a refund as club credit)
  card         jsonb,                                 -- { "brand", "last4" } when the provider gave them
  paid_at      timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'refund') = (refund_id IS NOT NULL))
);
CREATE INDEX receipt_person ON receipt (person_id, created_at DESC);
CREATE UNIQUE INDEX receipt_refund ON receipt (refund_id) WHERE refund_id IS NOT NULL;
CREATE TABLE receipt_payment (
  payment_id uuid PRIMARY KEY REFERENCES payment,
  receipt_id uuid NOT NULL REFERENCES receipt
);

-- Sending a receipt again: whoever takes or sees the club's money (owners and managers already can do anything).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000304', '00000000-0000-7000-8000-000000000003', 'receipt.resend', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000305', '00000000-0000-7000-8000-000000000005', 'receipt.resend', 'allow', 'any');
