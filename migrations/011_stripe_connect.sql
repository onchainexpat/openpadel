-- Stripe Connect: a hosted Kumi takes card payments straight into the club's own Stripe account
-- (Standard: the club's account, its dashboard, its payouts, its fees and disputes). Kumi keeps only
-- the account's id and whether Stripe says it can take payments yet.
ALTER TABLE club ADD COLUMN IF NOT EXISTS stripe_account_id text;
ALTER TABLE club ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE club ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false;
-- The Stripe account each card payment was taken on, so its refund goes back through the same one
-- even after the club changes accounts.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider_account text;
