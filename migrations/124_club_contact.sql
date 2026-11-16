-- How members reach the club and what it has (club.update): its phone, its website, and its amenities, shown on the
-- members' Home and the public page. The phone is kept as one number in international form (+ and digits), read in
-- the club's country when it's typed without a +. The amenities are keys from a fixed list (AMENITIES in
-- packages/i18n/src/amenities.ts, with their words in both languages); the action checks them, so adding one later
-- is data only, as with coming_from.
ALTER TABLE club
  ADD COLUMN phone     text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  ADD COLUMN website   text CHECK (website ~ '^https?://' AND length(website) <= 2000),
  ADD COLUMN amenities text[] NOT NULL DEFAULT '{}';
