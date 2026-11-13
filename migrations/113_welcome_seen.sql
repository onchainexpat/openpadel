-- The members' app's welcome for someone who moved in from Playtomic (welcome.ts): shown once, at their first sign-in
-- after the move, then never again. When they saw it.
ALTER TABLE person ADD COLUMN welcomed_at timestamptz;
-- Anyone who has already signed in (a session, or an address or number proven by a code) is past their first sign-in:
-- the welcome is for new arrivals, not for members already using the app when this ships.
UPDATE person SET welcomed_at = now()
  WHERE EXISTS (SELECT 1 FROM web_session s WHERE s.person_id = person.id)
     OR EXISTS (SELECT 1 FROM auth_identity a WHERE a.person_id = person.id AND a.verified_at IS NOT NULL);
