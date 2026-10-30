-- When a booking's reminder went out, so each booking is reminded once.
ALTER TABLE booking ADD COLUMN reminded_at timestamptz;
