-- Joining a membership in the app and paying for it. Kumi renews it each period from the card saved when
-- the member joined (no subscription at the provider): on a failed renewal it tries again a few days
-- later, and the member can pay with another card meanwhile; cancelling stops renewal at the period's end.

-- What a membership renews at: the price and period when it was joined, so a later change to the plan
-- (or a founding price) doesn't change what members already agreed to.
ALTER TABLE membership ADD COLUMN price_cents int CHECK (price_cents >= 0);
ALTER TABLE membership ADD COLUMN period text CHECK (period IN ('month', 'year'));
ALTER TABLE membership ADD COLUMN saved_customer text;          -- the provider's customer and card it renews on
ALTER TABLE membership ADD COLUMN saved_method text;
ALTER TABLE membership ADD COLUMN provider_account text;
ALTER TABLE membership ADD COLUMN failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE membership ADD COLUMN next_attempt_at timestamptz;  -- after a failed renewal: when to try the card again
ALTER TABLE membership ADD COLUMN end_reason text;              -- 'not_paid' when renewals ran out

-- A payment to join a plan (the membership exists once it's paid), or for a membership (a renewal).
ALTER TABLE payment ADD COLUMN membership_plan_id uuid REFERENCES membership_plan;
ALTER TABLE payment ADD COLUMN membership_id uuid REFERENCES membership;
CREATE INDEX payment_membership ON payment (membership_id);

-- Members join, cancel and take back a cancellation of their own membership.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000092', '00000000-0000-7000-8000-000000000006', 'membership.join', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000093', '00000000-0000-7000-8000-000000000006', 'membership.cancel', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000094', '00000000-0000-7000-8000-000000000006', 'membership.resume', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000095', '00000000-0000-7000-8000-000000000003', 'membership.cancel', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000096', '00000000-0000-7000-8000-000000000003', 'membership.resume', 'allow', 'any');
