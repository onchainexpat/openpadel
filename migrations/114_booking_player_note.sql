-- A court booking made at the desk can carry two notes: the staff's own (booking.note, which members never see) and,
-- new here, a note its players see in the members' app ("Bring the club's balls", "Gate code at the desk").
ALTER TABLE booking ADD COLUMN IF NOT EXISTS player_note text CHECK (char_length(player_note) <= 200);
