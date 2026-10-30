-- Several courts in one checkout: each court is its own booking with its own payment, and the payments
-- share a group, which the card form opens as one payment at the provider for their total.
ALTER TABLE payment ADD COLUMN group_id uuid;
CREATE INDEX payment_group ON payment (group_id) WHERE group_id IS NOT NULL;
-- One provider payment per Kumi payment, except within a group, whose payments all share theirs.
DROP INDEX payment_provider_ref;
CREATE UNIQUE INDEX payment_provider_ref ON payment (provider, provider_ref) WHERE provider_ref IS NOT NULL AND group_id IS NULL;
CREATE INDEX payment_group_ref ON payment (provider, provider_ref) WHERE provider_ref IS NOT NULL AND group_id IS NOT NULL;

-- Members book several courts at once, for themselves.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000130', '00000000-0000-7000-8000-000000000006', 'booking.request_courts', 'allow', 'own');
