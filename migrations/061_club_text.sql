-- The club's own words in both languages (club_text.ts): beside each text a club writes in its default language,
-- the version in the other language, as { "es": { "name": "..." } }. A field without one shows the club's own
-- wording. Club facts and message templates already had their two languages as columns.
ALTER TABLE membership_plan ADD COLUMN translations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE program ADD COLUMN translations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE waiver ADD COLUMN translations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE club ADD COLUMN translations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE coach ADD COLUMN translations jsonb NOT NULL DEFAULT '{}';
ALTER TABLE price_rule ADD COLUMN translations jsonb NOT NULL DEFAULT '{}';
-- Which language a waiver was shown in when someone accepted it.
ALTER TABLE waiver_acceptance ADD COLUMN lang text CHECK (lang IN ('en', 'es'));
