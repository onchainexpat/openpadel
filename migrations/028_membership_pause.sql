-- Pausing a membership (an injury, a long trip): the club pauses it until a date. Meanwhile its benefits
-- stop and nothing is charged; the paid time left moves to after the pause, so the renewal moves with it.
ALTER TABLE membership ADD COLUMN paused_from timestamptz;
ALTER TABLE membership ADD COLUMN paused_until timestamptz;

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000097', '00000000-0000-7000-8000-000000000003', 'membership.pause', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000098', '00000000-0000-7000-8000-000000000003', 'membership.unpause', 'allow', 'any');
