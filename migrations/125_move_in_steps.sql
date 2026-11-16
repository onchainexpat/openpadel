-- The guided move-in (staff app, Moving in; `openpadel move ...`): where the club comes from, which of the five steps
-- it's on (connect, review, practice run, switch-over, wrap up), when it plans to switch over, the switch-over and
-- wrap-up items staff have said are done, and when the owner called the move finished. The club's data, so it
-- changes only through the move.* actions, beside what the move-in already keeps here (brought_in.ts).
ALTER TABLE move_in
  ADD COLUMN source      text CHECK (source IN ('playtomic', 'playbypoint', 'spreadsheet')),
  ADD COLUMN step        text NOT NULL DEFAULT 'connect' CHECK (step IN ('connect', 'review', 'practice', 'switch', 'wrap_up')),
  ADD COLUMN switch_at   timestamptz,
  -- {"<item>": {"at": "<time>", "by": "<person id or null>"}}: only items staff tick (move_in.ts, MOVE_CHECKS).
  ADD COLUMN checks      jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN finished_at timestamptz;
-- A club already moving in from Playtomic (players read, an export uploaded or courts linked) starts with Playtomic chosen.
UPDATE move_in SET source = 'playtomic'
  WHERE playtomic_players_read_at IS NOT NULL OR brought_wallets_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM playtomic_upload) OR EXISTS (SELECT 1 FROM external_ref WHERE system = 'playtomic' AND entity = 'court');
-- Calling the move finished is the owner's: a manager asks, as for saying Playtomic's wallets are at zero.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000012501', '00000000-0000-7000-8000-000000000002', 'move.finish', 'ask', 'any');
