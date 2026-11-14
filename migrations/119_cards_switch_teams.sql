-- A member's card on file (Me, "Card on file"): saved with a card setup, so nothing is charged or held when it's
-- added. It's the one card used for everything charged later: a court's unpaid shares at the deadline, membership
-- renewals and the family card. Replacing it moves all of those to the new card; removing it takes it off all of
-- them. The brand, last four digits and expiry are kept to show it, never more.
CREATE TABLE person_card (
  id               uuid PRIMARY KEY,
  person_id        uuid NOT NULL REFERENCES person,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'removed')),
  provider         text NOT NULL,
  provider_ref     text,               -- the card setup
  provider_account text,
  saved_customer   text,
  saved_method     text,
  brand            text,
  last4            text CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month        int CHECK (exp_month BETWEEN 1 AND 12),
  exp_year         int CHECK (exp_year BETWEEN 2000 AND 2200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  saved_at         timestamptz,
  removed_at       timestamptz,
  version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX person_card_in_use ON person_card (person_id) WHERE status = 'saved';
CREATE INDEX person_card_person ON person_card (person_id);
CREATE INDEX person_card_setup ON person_card (provider_ref) WHERE provider_ref IS NOT NULL;

-- Switching plans: the plan a membership joined in the app moves to when its period ends. Nothing is charged until
-- then; at the renewal the membership ends and one on the new plan starts, charged to the same card.
ALTER TABLE membership ADD COLUMN switch_to uuid REFERENCES membership_plan;

-- The teams of a court's four, as its organiser chose them: the fair teams suggested, or as the players joined.
-- Not chosen (null), the fair teams are shown as a suggestion.
ALTER TABLE booking ADD COLUMN teams text CHECK (teams IN ('fair', 'joined'));

-- Who may: a member their own card on file, plan switch and court's teams; staff their own card (as with the family
-- card); a manager may call off any member's plan switch, as they may cancel a membership.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000001180', '00000000-0000-7000-8000-000000000006', 'card.remove', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000001181', '00000000-0000-7000-8000-000000000003', 'card.remove', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000001182', '00000000-0000-7000-8000-000000000004', 'card.remove', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000001183', '00000000-0000-7000-8000-000000000005', 'card.remove', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000001184', '00000000-0000-7000-8000-000000000006', 'membership.switch', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000001185', '00000000-0000-7000-8000-000000000006', 'membership.switch_cancel', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000001186', '00000000-0000-7000-8000-000000000003', 'membership.switch_cancel', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000001187', '00000000-0000-7000-8000-000000000006', 'booking.set_teams', 'allow', 'own');
