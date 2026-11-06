-- The club's country (ISO 3166-1 alpha-2, US until changed): the country a phone number typed without a + is read in,
-- and the one a club's own Stripe account is opened in under Connect. A location's address gains its postal code,
-- region and country, each optional, so an address outside the US is written as it is there.
ALTER TABLE club ADD COLUMN country text NOT NULL DEFAULT 'US' CHECK (country ~ '^[A-Z]{2}$');
ALTER TABLE location ADD COLUMN postal_code text CHECK (postal_code IS NULL OR length(postal_code) <= 16);
ALTER TABLE location ADD COLUMN region text CHECK (region IS NULL OR length(region) <= 60);
ALTER TABLE location ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
