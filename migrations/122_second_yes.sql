-- A second yes: the club can say which changes need two different people's yes before they happen (Roles, "Needs a
-- second yes"): the changes it names, whatever their amount, and any change by staff that charges or refunds more than
-- an amount. Neither the person who asked nor someone who already said yes counts again. Off (nothing named, no
-- amount) by default. Changing it is role.second_yes: the owner's, and a manager asks for it (role.*, 002_roles.sql).
ALTER TABLE club ADD COLUMN second_yes_actions text[] NOT NULL DEFAULT '{}';
ALTER TABLE club ADD COLUMN second_yes_over_cents int CHECK (second_yes_over_cents IS NULL OR second_yes_over_cents >= 0);

-- On each change: how many yeses it waits for (1, or 2 under the club's rule), and who said yes and when, in order:
-- [{ "by": person id, "at": time }]. approved_by stays the last yes, the one that made it happen.
ALTER TABLE action_run ADD COLUMN yeses_needed smallint NOT NULL DEFAULT 1 CHECK (yeses_needed BETWEEN 1 AND 2);
ALTER TABLE action_run ADD COLUMN yeses jsonb NOT NULL DEFAULT '[]';
-- When an ask ended without happening: someone said no, or another change made it out of date or settled it. A yes is
-- applied_at; before this, a no carried no time.
ALTER TABLE action_run ADD COLUMN ended_at timestamptz;

-- The yeses already given, as they'd have been recorded.
UPDATE action_run SET yeses = jsonb_build_array(jsonb_build_object('by', approved_by, 'at', applied_at))
  WHERE approved_by IS NOT NULL AND applied_at IS NOT NULL;
