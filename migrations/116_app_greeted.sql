-- The short welcome each app plays at someone's first sign-in there (the apps' Greeting): once in the members' app,
-- once in the staff app, never again. When they saw it.
ALTER TABLE person ADD COLUMN member_greeted_at timestamptz, ADD COLUMN staff_greeted_at timestamptz;
-- Anyone who has already signed in is past their first sign-in: the welcome is for new arrivals, not for people
-- already using the apps when this ships. The staff app's only for those already staff: a member made staff later
-- still gets it.
UPDATE person SET member_greeted_at = now(),
    staff_greeted_at = CASE WHEN EXISTS (SELECT 1 FROM person_role pr JOIN role r ON r.id = pr.role_id
      WHERE pr.person_id = person.id AND pr.active AND r.key <> 'member') THEN now() END
  WHERE EXISTS (SELECT 1 FROM web_session s WHERE s.person_id = person.id)
     OR EXISTS (SELECT 1 FROM auth_identity a WHERE a.person_id = person.id AND a.verified_at IS NOT NULL);
