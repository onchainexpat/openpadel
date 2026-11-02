-- Same-day open matches (open_matches.ts). An open match can be opened after the club's "pay my part" deadline
-- has passed: each player pays their own part when they join, and the match has its own cutoff, the club's
-- same_day_cutoff_hours before the start. Not full by then, it's cancelled and everyone gets their money back,
-- as at the deadline. A match opened before the deadline has no cutoff of its own (cutoff_at stays null).
ALTER TABLE booking_policy ADD COLUMN same_day_cutoff_hours int NOT NULL DEFAULT 2 CHECK (same_day_cutoff_hours BETWEEN 1 AND 24);
ALTER TABLE open_match ADD COLUMN cutoff_at timestamptz;
