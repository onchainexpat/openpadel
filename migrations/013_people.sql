-- Staff add people (person.create): the front desk adds members; managers and owners already can.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000060', '00000000-0000-7000-8000-000000000003', 'person.create', 'allow', 'any');
