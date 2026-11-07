-- Moving in from Playtomic, the money side (brought_in.ts): wallet balances become club credit, and memberships
-- carry over paid through Playtomic's own end date.
--
-- Credit brought in is what the club already owes its members from Playtomic's wallets: a liability (member_credit),
-- the other side a brought_in account (money the club took before openPadel), never revenue. One row per person and
-- wallet, so a re-run adds only what changed and never twice.
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check
  CHECK (kind IN ('member_credit', 'receivable', 'revenue', 'provider_clearing', 'cash_drawer', 'refunds_payable', 'adjustment', 'gift_cards', 'passes', 'brought_in'));

CREATE TABLE brought_credit (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person(id),
  system        text NOT NULL CHECK (system IN ('playtomic')),
  -- Playtomic's wallet id, or its name when the export has no id.
  wallet_ref    text NOT NULL,
  wallet_name   text NOT NULL,
  cents         int NOT NULL CHECK (cents >= 0),
  action_run_id uuid NOT NULL,
  at            timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  version       int NOT NULL DEFAULT 1,
  UNIQUE (person_id, system, wallet_ref)
);
CREATE INDEX brought_credit_person ON brought_credit (person_id);

-- Once the owner says the Playtomic wallets are at zero, credit isn't brought in again (a later read would show
-- them empty and take back what members hold here).
ALTER TABLE club ADD COLUMN brought_wallets_at timestamptz;
-- Where the first credit came from (Playtomic itself, or the club's export): their wallets are named differently (an id,
-- or a column), so a re-run from the other one could bring the same money in twice. A club keeps to one.
ALTER TABLE club ADD COLUMN brought_wallets_source text CHECK (brought_wallets_source IN ('playtomic', 'file'));
ALTER TABLE club ADD COLUMN brought_wallets_zeroed_at timestamptz;
ALTER TABLE club ADD COLUMN brought_wallets_zeroed_by uuid REFERENCES person(id);

-- A membership carried over from Playtomic: one joined here in all but its first card. It's paid through Playtomic's
-- date; it renews here from that date on a card the member adds in the app, and without one it ends then, quietly.
ALTER TABLE membership ADD COLUMN brought_from text CHECK (brought_from IN ('playtomic'));
ALTER TABLE membership ADD COLUMN brought_ref text;
ALTER TABLE membership ADD COLUMN brought_note text;
CREATE UNIQUE INDEX membership_brought ON membership (person_id, brought_from, brought_ref) WHERE brought_from IS NOT NULL;

-- Playtomic's players as last read through its Third Party API (/players with their wallets and benefits): what the
-- move-in previews read, so a preview never waits on Playtomic's one-call-a-minute pace. Deleted with the person
-- (privacy.ts), and it holds nothing a club's own customer export doesn't.
CREATE TABLE playtomic_player (
  player_id text PRIMARY KEY,
  name      text NOT NULL,
  email     text,
  phone     text,
  wallets   jsonb NOT NULL DEFAULT '[]',
  benefits  jsonb NOT NULL DEFAULT '[]',
  read_at   timestamptz NOT NULL
);
CREATE INDEX playtomic_player_email ON playtomic_player (lower(email));
ALTER TABLE club ADD COLUMN playtomic_players_wanted_at timestamptz;
ALTER TABLE club ADD COLUMN playtomic_players_read_at timestamptz;
ALTER TABLE club ADD COLUMN playtomic_players_error text;

-- Saying the Playtomic wallets are at zero is the owner's: a manager asks.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000001010', '00000000-0000-7000-8000-000000000002', 'credit.brought_zeroed', 'ask', 'any');
