-- A member can take back a change of their own from the note that follows it (Undo, in the members' app). The
-- undo is judged as the change it takes back (action.undo): only what the member could do themselves, to their
-- own rows, and only while that change still allows an undo.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000001188', '00000000-0000-7000-8000-000000000006', 'action.undo', 'allow', 'own');
