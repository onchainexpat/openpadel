-- Founding-member presales: a plan can take only so many members, and can start on a date. Members who
-- join before that date save their card (a card setup at the provider, not a payment: nothing is charged
-- or held) and keep their place; the first charge is on the start date, and renewals follow from there.

ALTER TABLE membership_plan ADD COLUMN max_members int CHECK (max_members > 0);   -- none: no limit
ALTER TABLE membership_plan ADD COLUMN starts_on date;                          -- a club date; none: from joining

-- 'upcoming': joined before the plan starts, nothing charged yet. Its provider_ref is the card setup.
ALTER TABLE membership DROP CONSTRAINT membership_status_check;
ALTER TABLE membership ADD CONSTRAINT membership_status_check CHECK (status IN ('upcoming', 'active', 'past_due', 'ended'));
ALTER TABLE membership ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
DROP INDEX membership_one_live;
CREATE UNIQUE INDEX membership_one_live ON membership (person_id) WHERE status IN ('upcoming', 'active', 'past_due');
CREATE INDEX membership_plan_live ON membership (plan_id) WHERE status IN ('upcoming', 'active', 'past_due');
