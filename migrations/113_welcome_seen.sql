-- The members' app's welcome for someone who moved in from Playtomic (welcome.ts): shown once, at their first sign-in
-- after the move, then never again. When they saw it.
ALTER TABLE person ADD COLUMN welcomed_at timestamptz;
