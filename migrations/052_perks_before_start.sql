-- Founding members' perks before the start (memberships.ts, memberPlan). A presale membership whose card is saved
-- (or that costs nothing) gets its plan's member prices, program discounts and booking window from the day it's
-- taken, not only from the plan's start date, unless the plan says otherwise. Included sessions still start with
-- the membership: nothing is given free before anything is paid.
ALTER TABLE membership_plan ADD COLUMN perks_before_start boolean NOT NULL DEFAULT true;
