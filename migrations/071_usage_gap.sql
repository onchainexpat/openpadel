-- The usage meter after a restore (after_restore.ts). Restoring a copy puts the meter back to the copy's counts, so
-- what was spent since would go uncounted: the restore carries the meter over from the database it replaces. When
-- that database can't vouch (a new server after losing the old one), what was spent between the copy's last count
-- and the restore isn't known: kept here, so `kumi usage` and `kumi doctor` say the months it touches may be short.
CREATE TABLE usage_gap (
  restored_at   timestamptz PRIMARY KEY,
  counted_until timestamptz              -- the copy's last count; null when it had none
);
