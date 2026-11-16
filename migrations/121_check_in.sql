-- Checking in at the desk (booking.check_in): each place in a booking is marked when its player arrives, and by whom.
-- booking_player.checked_in_at has been there since 016 and was never set; it's used now. The front desk's
-- 'booking.*' grant covers it (owners and managers have '*').
ALTER TABLE booking_player ADD COLUMN checked_in_by uuid REFERENCES person;
