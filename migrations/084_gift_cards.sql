-- Gift cards (gift_cards.ts): bought by a member in the app (by card) or sold at the desk, for an amount the club
-- allows; never expire, no fees, not taxed when sold. Until it's redeemed a card is the club's liability (a
-- gift_cards account); redeemed, its value becomes the redeemer's club credit. The code is shown to whoever bought
-- it (sealed with the club's secret key, so a copy of the database alone doesn't give it away), and looked up by
-- its hash.
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check
  CHECK (kind IN ('member_credit', 'receivable', 'revenue', 'provider_clearing', 'cash_drawer', 'refunds_payable', 'adjustment', 'gift_cards'));

ALTER TABLE club ADD COLUMN gift_cards boolean NOT NULL DEFAULT false;
ALTER TABLE club ADD COLUMN gift_card_min_cents int NOT NULL DEFAULT 1000 CHECK (gift_card_min_cents >= 100);
ALTER TABLE club ADD COLUMN gift_card_max_cents int NOT NULL DEFAULT 50000 CHECK (gift_card_max_cents <= 500000);

CREATE TABLE gift_card (
  id             uuid PRIMARY KEY,
  code_hash      text NOT NULL UNIQUE,
  code_sealed    text NOT NULL,
  last4          text NOT NULL,
  amount_cents   int  NOT NULL CHECK (amount_cents > 0),
  buyer_id       uuid NOT NULL REFERENCES person,
  for_name       text,
  message        text,
  sold_via       text NOT NULL CHECK (sold_via IN ('app', 'desk')),
  status         text NOT NULL CHECK (status IN ('pending', 'active', 'redeemed', 'void')),
  redeemed_by    uuid REFERENCES person,
  redeemed_at    timestamptz,
  voided_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1
);
CREATE INDEX gift_card_buyer ON gift_card (buyer_id);
ALTER TABLE payment ADD COLUMN gift_card_id uuid REFERENCES gift_card;

-- A wrong code tried: redeeming is limited per person, so codes can't be guessed.
CREATE TABLE gift_card_try (
  id        bigserial PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES person,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_card_try_person ON gift_card_try (person_id, at);

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000942', '00000000-0000-7000-8000-000000000006', 'gift_card.buy', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000943', '00000000-0000-7000-8000-000000000006', 'gift_card.redeem', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000944', '00000000-0000-7000-8000-000000000003', 'gift_card.sell', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000945', '00000000-0000-7000-8000-000000000003', 'gift_card.resend', 'allow', 'any');
