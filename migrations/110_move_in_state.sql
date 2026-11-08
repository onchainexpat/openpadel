-- The move-in's working state (brought_in.ts) gets a row of its own, off the club's (not released). Every run, upload
-- turn, zeroing step and read of Playtomic's players wrote it to the club row, so each counted as a change to the
-- club's details: a details change made before could no longer be undone ("something has changed it since"), a
-- manager's waiting ask to change one went out of date, and an owner's preview of one could fail as changed. The
-- club row keeps only the club's own settings.
CREATE TABLE move_in (
  singleton                   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  brought_wallets_at          timestamptz,
  brought_wallets_zeroed_at   timestamptz,
  brought_wallets_zeroed_by   uuid REFERENCES person(id),
  brought_zeroing_at          timestamptz,
  brought_run_seq             bigint,
  brought_run_source          text,
  playtomic_players_wanted_at timestamptz,
  playtomic_players_read_at   timestamptz,
  playtomic_players_read_seq  bigint,
  playtomic_players_error     text,
  playtomic_players_erased    int NOT NULL DEFAULT 0,
  version                     int NOT NULL DEFAULT 1
);
-- One row, there before the club is set up, so the move-in never has to make it.
INSERT INTO move_in DEFAULT VALUES;
UPDATE move_in m SET brought_wallets_at = c.brought_wallets_at, brought_wallets_zeroed_at = c.brought_wallets_zeroed_at,
  brought_wallets_zeroed_by = c.brought_wallets_zeroed_by, brought_zeroing_at = c.brought_zeroing_at, brought_run_seq = c.brought_run_seq,
  brought_run_source = c.brought_run_source, playtomic_players_wanted_at = c.playtomic_players_wanted_at,
  playtomic_players_read_at = c.playtomic_players_read_at, playtomic_players_read_seq = c.playtomic_players_read_seq,
  playtomic_players_error = c.playtomic_players_error, playtomic_players_erased = c.playtomic_players_erased
  FROM club c;
ALTER TABLE club DROP COLUMN brought_wallets_at, DROP COLUMN brought_wallets_zeroed_at, DROP COLUMN brought_wallets_zeroed_by,
  DROP COLUMN brought_zeroing_at, DROP COLUMN brought_run_seq, DROP COLUMN brought_run_source, DROP COLUMN playtomic_players_wanted_at,
  DROP COLUMN playtomic_players_read_at, DROP COLUMN playtomic_players_read_seq, DROP COLUMN playtomic_players_error,
  DROP COLUMN playtomic_players_erased;
-- The club's change log said them too: an undo puts back what a change wrote, and these aren't the club's any more.
UPDATE entity_change SET
  before = before - ARRAY['brought_wallets_at', 'brought_wallets_zeroed_at', 'brought_wallets_zeroed_by', 'brought_zeroing_at', 'brought_run_seq',
    'brought_run_source', 'playtomic_players_wanted_at', 'playtomic_players_read_at', 'playtomic_players_read_seq', 'playtomic_players_error', 'playtomic_players_erased'],
  after = after - ARRAY['brought_wallets_at', 'brought_wallets_zeroed_at', 'brought_wallets_zeroed_by', 'brought_zeroing_at', 'brought_run_seq',
    'brought_run_source', 'playtomic_players_wanted_at', 'playtomic_players_read_at', 'playtomic_players_read_seq', 'playtomic_players_error', 'playtomic_players_erased']
  WHERE entity = 'club';
