-- A club's own currency (ISO 4217): it was always US dollars. Amounts stay in the currency's smallest unit (cents,
-- pence; whole yen in a zero-decimal one), as Stripe takes them. Kumi refuses three-decimal currencies and any change
-- once the club has a payment (club.update), so the database only checks the code's shape.
ALTER TABLE club DROP CONSTRAINT IF EXISTS club_currency_check;
ALTER TABLE club ADD CONSTRAINT club_currency_code CHECK (currency ~ '^[A-Z]{3}$');
