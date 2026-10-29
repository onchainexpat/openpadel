-- Money (data_model.md 10): the provider moves it; the ledger is the club's record. Double-entry,
-- so every payment, refund and credit balances, checked by the database itself.
CREATE TABLE ledger_account (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('member_credit', 'receivable', 'revenue', 'provider_clearing', 'cash_drawer', 'refunds_payable', 'adjustment')),
  person_id    uuid REFERENCES person,
  revenue_type text,
  UNIQUE NULLS NOT DISTINCT (kind, person_id, revenue_type)
);
CREATE TABLE ledger_txn (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL,
  action_run_id uuid NOT NULL REFERENCES action_run,
  at            timestamptz NOT NULL DEFAULT now(),
  memo          text
);
CREATE TABLE ledger_entry (
  id           bigserial PRIMARY KEY,
  txn_id       uuid NOT NULL REFERENCES ledger_txn,
  account_id   uuid NOT NULL REFERENCES ledger_account,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0)
);
CREATE INDEX ledger_entry_account ON ledger_entry (account_id);

-- A transaction's entries must sum to zero; checked at commit, so entries can be added one by one.
CREATE FUNCTION ledger_txn_balances() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT coalesce(sum(amount_cents), 0) FROM ledger_entry WHERE txn_id = NEW.txn_id) <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance', NEW.txn_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entry_balances AFTER INSERT ON ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_txn_balances();
CREATE RULE ledger_entry_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING;
CREATE RULE ledger_entry_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING;

CREATE TABLE payment (
  id           uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES person,
  amount_cents int  NOT NULL CHECK (amount_cents > 0),
  method       text NOT NULL CHECK (method IN ('card', 'terminal', 'credit', 'cash', 'other', 'paid_elsewhere')),
  provider     text NOT NULL CHECK (provider IN ('test', 'stripe', 'none')),
  provider_ref text,
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  enrolment_id uuid REFERENCES enrolment,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX payment_provider_ref ON payment (provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE refund (
  id            uuid PRIMARY KEY,
  payment_id    uuid NOT NULL REFERENCES payment,
  enrolment_id  uuid REFERENCES enrolment,
  amount_cents  int  NOT NULL CHECK (amount_cents > 0),
  destination   text NOT NULL CHECK (destination IN ('card', 'credit')),
  status        text NOT NULL CHECK (status IN ('waiting_for_sub', 'pending', 'sent', 'failed')),
  provider_ref  text,
  failure       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

-- What a member holds as club credit (a liability, so its balance is the negative of the entries).
CREATE VIEW member_credit_balance AS
  SELECT a.person_id, -coalesce(sum(e.amount_cents), 0) AS cents
  FROM ledger_account a LEFT JOIN ledger_entry e ON e.account_id = a.id
  WHERE a.kind = 'member_credit' GROUP BY a.person_id;
