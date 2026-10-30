-- Linked kid accounts. A junior of 13 or more can have a login of their own, turned on by a parent: they
-- book and join matches, courts, programs and lessons themselves, and each payment goes on the family card
-- a parent saved, at once, with no card form for the kid. They stay a junior in the household, managed by
-- its parents, who set what they may do (each kind on or off, and a monthly limit). Anything switched off
-- or over the limit becomes a request the parents approve or decline; nothing is held while it waits.
-- A card that's declined, or wants its owner to confirm, means a parent pays in the app instead.

ALTER TABLE person ADD COLUMN own_login boolean NOT NULL DEFAULT false;   -- a junior with a login of their own
ALTER TABLE person DROP CONSTRAINT person_junior_no_contact;
ALTER TABLE person ADD CONSTRAINT person_junior_no_contact CHECK (NOT junior OR own_login OR (email IS NULL AND phone IS NULL));

-- What a kid may do on their own, set by a parent. Friends start off: nobody can add them, and they can't
-- add anyone, until a parent turns it on.
CREATE TABLE kid_rule (
  person_id           uuid PRIMARY KEY REFERENCES person,
  open_matches        boolean NOT NULL DEFAULT true,
  courts              boolean NOT NULL DEFAULT true,
  programs            boolean NOT NULL DEFAULT true,
  lessons             boolean NOT NULL DEFAULT true,
  monthly_limit_cents int NOT NULL DEFAULT 10000 CHECK (monthly_limit_cents >= 0),
  friends             boolean NOT NULL DEFAULT false,
  updated_by          uuid REFERENCES person,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1
);

-- The household's card, saved by a parent through the provider's card setup (never the card itself).
-- One in use at a time; saving another replaces it.
CREATE TABLE family_card (
  id               uuid PRIMARY KEY,
  household_id     uuid NOT NULL REFERENCES household,
  saved_by         uuid NOT NULL REFERENCES person,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'removed')),
  provider         text NOT NULL,
  provider_ref     text,               -- the card setup
  provider_account text,
  saved_customer   text,
  saved_method     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  saved_at         timestamptz,
  removed_at       timestamptz,
  version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX family_card_in_use ON family_card (household_id) WHERE status = 'saved';
CREATE INDEX family_card_setup ON family_card (provider_ref) WHERE provider_ref IS NOT NULL;

-- A kid's payment that went on the family card, or that a parent has been asked to pay.
ALTER TABLE payment ADD COLUMN family_card_id uuid REFERENCES family_card;
ALTER TABLE payment ADD COLUMN family_declines int NOT NULL DEFAULT 0;       -- a fresh charge key after each recorded decline
ALTER TABLE payment ADD COLUMN parent_to_pay_at timestamptz;                -- the family card couldn't be used: a parent pays

-- Something a kid asked a parent for: the action and its input as the kid sent them, run as the kid once a
-- parent approves (planned afresh then, so it's checked again: a court taken meanwhile is said, not booked).
CREATE TABLE kid_request (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,   -- the kid
  action      text NOT NULL,
  input       jsonb NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('open_matches', 'courts', 'programs', 'lessons')),
  reason      text NOT NULL CHECK (reason IN ('off', 'limit')),
  cents       int NOT NULL DEFAULT 0,
  what        jsonb NOT NULL,                    -- the plan's words, in each language, as the kid saw them
  status      text NOT NULL DEFAULT 'asked' CHECK (status IN ('asked', 'approved', 'declined', 'withdrawn', 'done', 'failed')),
  decided_by  uuid REFERENCES person,
  decided_at  timestamptz,
  run_id      uuid,                              -- the kid's action, once run
  error       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);
CREATE INDEX kid_request_open ON kid_request (person_id) WHERE status = 'asked';

-- Parents turn logins on and off and set the rules for their own kids (the plans name them as the rows'
-- owners); a kid asks and withdraws their own requests; a parent saves and removes the family card.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000152', '00000000-0000-7000-8000-000000000006', 'kid.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000153', '00000000-0000-7000-8000-000000000006', 'family_card.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000154', '00000000-0000-7000-8000-000000000003', 'kid.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000155', '00000000-0000-7000-8000-000000000004', 'kid.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000156', '00000000-0000-7000-8000-000000000005', 'kid.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000157', '00000000-0000-7000-8000-000000000003', 'family_card.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000158', '00000000-0000-7000-8000-000000000004', 'family_card.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000159', '00000000-0000-7000-8000-000000000005', 'family_card.*', 'allow', 'own');
