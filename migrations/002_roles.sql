-- The built-in roles and their default grants (permissions.md, "Defaults by area").
-- Only the actions that exist so far; each later migration adds the grants for its actions.
INSERT INTO role (id, key, system) VALUES
  ('00000000-0000-7000-8000-000000000001', 'owner', true),
  ('00000000-0000-7000-8000-000000000002', 'manager', true),
  ('00000000-0000-7000-8000-000000000003', 'front_desk', true),
  ('00000000-0000-7000-8000-000000000004', 'coach', true),
  ('00000000-0000-7000-8000-000000000005', 'accountant', true),
  ('00000000-0000-7000-8000-000000000006', 'member', true);

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  -- Owner: everything.
  ('00000000-0000-7000-8001-000000000001', '00000000-0000-7000-8000-000000000001', '*', 'allow', 'any'),
  -- Manager: runs the club; setup and roles ask the owner.
  ('00000000-0000-7000-8001-000000000002', '00000000-0000-7000-8000-000000000002', '*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000003', '00000000-0000-7000-8000-000000000002', 'club.*', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000000004', '00000000-0000-7000-8000-000000000002', 'location.*', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000000005', '00000000-0000-7000-8000-000000000002', 'role.*', 'ask', 'any'),
  -- Everyone with an account can change their own profile.
  ('00000000-0000-7000-8001-000000000006', '00000000-0000-7000-8000-000000000003', 'person.update_profile', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000007', '00000000-0000-7000-8000-000000000004', 'person.update_profile', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000008', '00000000-0000-7000-8000-000000000005', 'person.update_profile', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000009', '00000000-0000-7000-8000-000000000006', 'person.update_profile', 'allow', 'own');
