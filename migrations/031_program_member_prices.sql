-- Member prices on programs (clinics, socials and the rest): a plan's discount, a program's own member
-- price (which wins over the discount), and single sessions a plan includes each period. What a place was
-- priced at, and why, stays with the place, so changing a price never changes what someone agreed to.

ALTER TABLE membership_plan ADD COLUMN program_percent_off int CHECK (program_percent_off BETWEEN 1 AND 100);
ALTER TABLE membership_plan ADD COLUMN program_cents_off int CHECK (program_cents_off > 0);
ALTER TABLE membership_plan ADD CONSTRAINT membership_plan_one_program_discount CHECK (program_percent_off IS NULL OR program_cents_off IS NULL);
-- So many single sessions each membership period, of these kinds (a course, paid once, never counts).
ALTER TABLE membership_plan ADD COLUMN included_sessions int CHECK (included_sessions BETWEEN 1 AND 100);
ALTER TABLE membership_plan ADD COLUMN included_kinds text[] NOT NULL DEFAULT '{clinic,social}' CHECK (included_kinds <@ '{clinic,social,tournament}'::text[]);

ALTER TABLE program ADD COLUMN member_price_cents int CHECK (member_price_cents >= 0);

-- How a place was priced: the full price, a member price, or one of the sessions the membership includes
-- (which period it counts in, and whether it was given back by leaving in time).
ALTER TABLE enrolment ADD COLUMN price_basis text NOT NULL DEFAULT 'full' CHECK (price_basis IN ('full', 'member', 'included'));
ALTER TABLE enrolment ADD COLUMN included_membership_id uuid REFERENCES membership;
ALTER TABLE enrolment ADD COLUMN included_period_start timestamptz;
ALTER TABLE enrolment ADD COLUMN included_back boolean NOT NULL DEFAULT false;
CREATE INDEX enrolment_included ON enrolment (included_membership_id, included_period_start) WHERE price_basis = 'included';
