-- The move-in's second review (not released).
--
-- An upload's rows (names, emails, phones of the club's Playtomic customers, members or not) were copied into the change
-- log by every upload, where neither the 30-day delete nor a deleted account reached them. The log keeps the upload's
-- hash and how many rows it had (row_count, below) instead (actions.ts, KEYS_NOT_KEPT); what this unreleased code already
-- wrote there is taken out.
ALTER TABLE playtomic_upload ADD COLUMN row_count int NOT NULL DEFAULT 0;
UPDATE playtomic_upload SET row_count = jsonb_array_length(rows);
UPDATE entity_change SET after = after - 'rows' - 'problems' - 'wallet_columns'
  WHERE entity = 'playtomic_upload' AND after IS NOT NULL;
UPDATE entity_change SET before = before - 'rows' - 'problems' - 'wallet_columns'
  WHERE entity = 'playtomic_upload' AND before IS NOT NULL;

-- The wallets: once the owner says they're being set to zero in Playtomic, every read shows 0, so from then credit only
-- comes in, never goes back out (brought_zeroing_at).
ALTER TABLE club ADD COLUMN brought_zeroing_at timestamptz;
-- And a run reads nothing from before the last one: an older upload or read would undo a take-back. Uploads, Playtomic
-- reads and runs take their turn from one sequence, so two in the same instant are still in order.
CREATE SEQUENCE brought_seq;
ALTER TABLE playtomic_upload ADD COLUMN seq bigint NOT NULL DEFAULT nextval('brought_seq');
ALTER TABLE club ADD COLUMN playtomic_players_read_seq bigint;
ALTER TABLE club ADD COLUMN brought_run_seq bigint;
-- What the last run read: an upload's id, or 'playtomic'. Run again from the same source, nothing is out of turn.
ALTER TABLE club ADD COLUMN brought_run_source text;
-- How many players the last read of Playtomic left out because their account was deleted here, for the preview.
ALTER TABLE club ADD COLUMN playtomic_players_erased int NOT NULL DEFAULT 0;
ALTER TABLE playtomic_upload ADD COLUMN erased_count int NOT NULL DEFAULT 0;

-- A membership carried over from Playtomic: its first renewal, so its periods (included sessions, a desk payment's
-- "until") run from Playtomic's day on its anchor_day, not from the day it was carried over.
ALTER TABLE membership ADD COLUMN first_renewal_at timestamptz;
UPDATE membership SET first_renewal_at = current_period_end WHERE brought_from IS NOT NULL AND first_renewal_at IS NULL AND period_no = 1;

-- Saying the wallets are being set to zero is the owner's, as is saying they are at zero: a manager asks.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000001014', '00000000-0000-7000-8000-000000000002', 'credit.brought_zeroing', 'ask', 'any');
