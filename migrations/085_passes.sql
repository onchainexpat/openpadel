-- Passes (passes.ts): products the club makes ("10 clinic places", "5 court bookings up to 90 minutes", "1 drop-in"),
-- bought in the members' app by card or sold at the desk. A pass is one person's. Until a use is taken the money is
-- the club's liability (a passes account, like gift cards); each use taken moves its share of the price to revenue,
-- and a use given back (a cancel the club's rules refund in full) moves it back. No expiry unless the club sets one,
-- and then at least 12 months. Unused uses can be refunded by the owner or a manager, pro rata.
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check
  CHECK (kind IN ('member_credit', 'receivable', 'revenue', 'provider_clearing', 'cash_drawer', 'refunds_payable', 'adjustment', 'gift_cards', 'passes'));

-- A payment covered by a pass (method 'pass') moves no money; one made free by a promo code (method 'promo', 086)
-- neither. A pass use given back is a refund to the pass.
ALTER TABLE payment DROP CONSTRAINT payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check CHECK (method IN ('card', 'terminal', 'credit', 'cash', 'other', 'paid_elsewhere', 'pass', 'promo'));
ALTER TABLE refund DROP CONSTRAINT refund_destination_check;
ALTER TABLE refund ADD CONSTRAINT refund_destination_check CHECK (destination IN ('card', 'credit', 'desk', 'pass'));

CREATE TABLE pass_product (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  translations  jsonb,
  covers        text NOT NULL CHECK (covers IN ('programs', 'courts')),
  -- Programs: these kinds (clinic, course, social...) or these programs; neither means any program.
  program_kinds text[],
  program_ids   uuid[],
  -- Courts: bookings up to this long, starting between these minutes of the club's day (optional).
  max_minutes   int CHECK (max_minutes IS NULL OR max_minutes > 0),
  from_minute   int CHECK (from_minute IS NULL OR from_minute BETWEEN 0 AND 1439),
  to_minute     int CHECK (to_minute IS NULL OR to_minute BETWEEN 1 AND 1440),
  price_cents   int NOT NULL CHECK (price_cents > 0),
  uses          int NOT NULL CHECK (uses BETWEEN 1 AND 100),
  valid_days    int CHECK (valid_days IS NULL OR valid_days >= 365),
  on_sale       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

CREATE TABLE pass (
  id           uuid PRIMARY KEY,
  product_id   uuid NOT NULL REFERENCES pass_product,
  person_id    uuid NOT NULL REFERENCES person,
  -- What it was bought as: a later change to the product doesn't change a pass already bought.
  name         text NOT NULL,
  covers       text NOT NULL CHECK (covers IN ('programs', 'courts')),
  program_kinds text[],
  program_ids  uuid[],
  max_minutes  int,
  from_minute  int,
  to_minute    int,
  price_cents  int NOT NULL CHECK (price_cents > 0),
  uses         int NOT NULL CHECK (uses > 0),
  uses_left    int NOT NULL CHECK (uses_left >= 0),
  expires_at   timestamptz,
  sold_via     text NOT NULL CHECK (sold_via IN ('app', 'desk')),
  status       text NOT NULL CHECK (status IN ('pending', 'active', 'refunded')),
  refunded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  CHECK (uses_left <= uses)
);
CREATE INDEX pass_person ON pass (person_id);
ALTER TABLE payment ADD COLUMN pass_id uuid REFERENCES pass;

-- Each use taken: the payment it covered and its share of the price. Given back, returned_at is set and the use is
-- the pass's again.
CREATE TABLE pass_use (
  id          uuid PRIMARY KEY,
  pass_id     uuid NOT NULL REFERENCES pass,
  payment_id  uuid NOT NULL UNIQUE REFERENCES payment,
  value_cents int  NOT NULL CHECK (value_cents >= 0),
  at          timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz
);
CREATE INDEX pass_use_pass ON pass_use (pass_id);

-- Members buy and use their own; the desk sells passes and uses a member's pass for them. Products and refunds are
-- the owner's and managers' (their grant covers everything).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000946', '00000000-0000-7000-8000-000000000006', 'pass.buy', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000947', '00000000-0000-7000-8000-000000000006', 'payment.use_pass', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000948', '00000000-0000-7000-8000-000000000003', 'pass.sell', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000949', '00000000-0000-7000-8000-000000000003', 'payment.use_pass', 'allow', 'any');
