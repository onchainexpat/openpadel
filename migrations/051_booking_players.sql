-- Players on a court booked and paid in full (booking_players.ts). The booker names who's playing (a member
-- found by name), or shares the booking's players link; nobody added pays anything, and taking a player off never
-- moves money. With four on it, the game can be scored, and it counts for levels when the booker says so.
ALTER TABLE booking ADD COLUMN rated boolean NOT NULL DEFAULT false;     -- not an open match: does its game count for levels
ALTER TABLE booking_player ADD COLUMN added_by uuid REFERENCES person;   -- put on a whole-court booking (by the booker, or themselves by its link)

-- Whole-court bookings made before this get their players link too (new ones get it when they're made).
UPDATE booking SET invite_code = translate(encode(decode(md5(random()::text || clock_timestamp()::text || id::text), 'hex'), 'base64'), '+/=', '-_')
  WHERE kind = 'court' AND pay_mode = 'whole' AND invite_code IS NULL AND organiser_id IS NOT NULL;

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000410', '00000000-0000-7000-8000-000000000006', 'booking.add_player', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000411', '00000000-0000-7000-8000-000000000006', 'booking.remove_player', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000412', '00000000-0000-7000-8000-000000000006', 'booking.set_rated', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000413', '00000000-0000-7000-8000-000000000006', 'booking.join_players', 'allow', 'own');
