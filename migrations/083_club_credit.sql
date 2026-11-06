-- Club credit (credit.ts): spent on a payment from the members' app, and paid out at the desk by the owner or a
-- manager. The balance is in the books already (member_credit accounts, 006); a pay-out also gets a row here, so the
-- desk's day shows the money handed back.
CREATE TABLE credit_payout (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person,
  amount_cents  int  NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL CHECK (method IN ('cash', 'other')),
  note          text,
  action_run_id uuid NOT NULL REFERENCES action_run,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_payout_at ON credit_payout (at);
CREATE INDEX credit_payout_person ON credit_payout (person_id);

-- A member spends their own credit. Paying it out is the owner's and managers' (their grant covers everything).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000941', '00000000-0000-7000-8000-000000000006', 'payment.use_credit', 'allow', 'own');
