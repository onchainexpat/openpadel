-- Members book and pay for courts. A booking holds its court for a few minutes while the organiser pays.
-- The organiser pays the whole court, or only their part: then each player pays their own share in the
-- app, the organiser's card is saved (never held), and whatever is still unpaid at the club's deadline is
-- charged to it once.

ALTER TABLE booking ADD COLUMN pay_mode text NOT NULL DEFAULT 'whole' CHECK (pay_mode IN ('whole', 'split'));
ALTER TABLE booking ADD COLUMN players int NOT NULL DEFAULT 4 CHECK (players BETWEEN 1 AND 8);   -- how many share the cost
ALTER TABLE booking ADD COLUMN invite_code text UNIQUE;                -- the link other players join with
ALTER TABLE booking ADD COLUMN settled_at timestamptz;                 -- "pay my part": when the deadline charge ran
ALTER TABLE booking ADD COLUMN balance_cents int NOT NULL DEFAULT 0 CHECK (balance_cents >= 0);   -- still owed after it

-- A payment for a player's share, and whether to save the card for the deadline charge.
ALTER TABLE payment ADD COLUMN booking_player_id uuid REFERENCES booking_player;
ALTER TABLE payment ADD COLUMN save_card boolean NOT NULL DEFAULT false;
ALTER TABLE payment ADD COLUMN saved_customer text;                    -- the provider's customer and card, once saved
ALTER TABLE payment ADD COLUMN saved_method text;
CREATE INDEX payment_booking_player ON payment (booking_player_id);

-- Members book, join a booking they were invited to, and cancel their own bookings.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000080', '00000000-0000-7000-8000-000000000006', 'booking.request', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000081', '00000000-0000-7000-8000-000000000006', 'booking.join', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000082', '00000000-0000-7000-8000-000000000006', 'booking.cancel', 'allow', 'own');
