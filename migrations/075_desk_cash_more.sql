-- A card payment asked for a membership's next period (in the app, or after its renewal's card was declined) keeps
-- the period end it was asked against. If that period is paid another way meanwhile (at the desk, or by the saved
-- card's retry) and this card goes through as well, it pays what's still owed at the desk, and the rest goes back
-- to the card, instead of a second period.
ALTER TABLE payment ADD COLUMN for_period_end timestamptz;

-- The desk's day (Reports): what was paid at the desk, and what was handed back there.
CREATE INDEX payment_at_desk ON payment (created_at) WHERE provider = 'none';
CREATE INDEX refund_given_back ON refund (payment_id) WHERE destination = 'desk' AND status = 'sent';
