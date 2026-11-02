-- Sign-up per date (programs.ts): a weekly clinic or social whose dates each have their own places, roster,
-- waitlist and minimum. The program's sign_up column was there from the start; these are what a date needs too:
-- its own decision on the minimum, and "tell me when a place opens" for one date.
ALTER TABLE session ADD COLUMN min_heads_up_at timestamptz;
ALTER TABLE session ADD COLUMN min_decided_at timestamptz;

ALTER TABLE program_watch ADD COLUMN session_id uuid REFERENCES session;
DROP INDEX program_watch_one;
CREATE UNIQUE INDEX program_watch_one ON program_watch (program_id, coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid), person_id)
  WHERE told_at IS NULL AND ended_at IS NULL;

-- Joining several dates in one go: the same people may do it as join one (front desk for anyone, members their own).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000590', '00000000-0000-7000-8000-000000000003', 'enrolment.join_dates', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000591', '00000000-0000-7000-8000-000000000006', 'enrolment.join_dates', 'allow', 'own');
