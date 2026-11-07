-- What an assistant connection was allowed when its person allowed it, so a staff role, a wider role or the club's
-- new rule for a second step later never reaches through it without their allowing it again (assistant_reach.ts):
-- the roles and grants they held then, and whether they had given a second step. When it's held to a member's reach
-- for that, the person hears it once (limited_told_at).
-- A connection made before this has no powers yet: the first use takes what the person holds then. No second step
-- is counted for it, so where the club asks for one it works as a member's until it's connected again.
ALTER TABLE oauth_grant ADD COLUMN IF NOT EXISTS powers jsonb;
ALTER TABLE oauth_grant ADD COLUMN IF NOT EXISTS second_step boolean NOT NULL DEFAULT false;
ALTER TABLE oauth_grant ADD COLUMN IF NOT EXISTS limited_told_at timestamptz;
