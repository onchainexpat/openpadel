-- The club's public page: its details, prices, memberships and upcoming public events, readable without
-- signing in (and by search engines), once the club switches it on.
ALTER TABLE club ADD COLUMN public_page boolean NOT NULL DEFAULT false;
ALTER TABLE club ADD COLUMN about text;   -- a few lines about the club, shown at the top of the page
