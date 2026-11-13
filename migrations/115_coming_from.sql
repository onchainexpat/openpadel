-- "Coming from" (Settings, club.yaml's coming_from): the software the club's staff used before, so the staff app uses
-- the words, menu order and first page they know. Only words and order: never what a role may see or do. Every club
-- before this saw Playtomic's words, so that is the default and nothing changes until a club picks another. No list of
-- names is checked here: a new one is added as data in the app, without a migration (an unknown one reads as the default).
ALTER TABLE club ADD COLUMN IF NOT EXISTS coming_from text NOT NULL DEFAULT 'playtomic' CHECK (coming_from ~ '^[a-z_]{1,40}$');
