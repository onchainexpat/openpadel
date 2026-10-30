-- Taking over a place in a match. Up to the start, a player who can't make it can find someone to take
-- their place: a friend, or whoever opens their link. The sub pays in the app, and only then is the place
-- theirs and the player paid back. After the deadline, a player who backs out without a sub is a late
-- cancellation and the desk hears about it once; staff can open the place in the app (whoever joins and
-- pays takes it over) or give it to someone free. What a late leaver gets back is the club's own rule,
-- kept with each booking like its other rules; staff can choose otherwise case by case.

ALTER TABLE booking_policy ADD COLUMN late_sub_refund_percent    int NOT NULL DEFAULT 100 CHECK (late_sub_refund_percent BETWEEN 0 AND 100);    -- their own sub took it
ALTER TABLE booking_policy ADD COLUMN late_filled_refund_percent int NOT NULL DEFAULT 100 CHECK (late_filled_refund_percent BETWEEN 0 AND 100); -- the club filled it with a paying player
ALTER TABLE booking_policy ADD COLUMN late_empty_refund_percent  int NOT NULL DEFAULT 0 CHECK (late_empty_refund_percent BETWEEN 0 AND 100);    -- nobody took it, or it was given free

CREATE TABLE place_offer (
  id                uuid PRIMARY KEY,
  booking_player_id uuid NOT NULL REFERENCES booking_player,   -- the place on offer, still its player's until a sub pays
  to_person_id      uuid REFERENCES person,                    -- the friend it's offered to; none: whoever has the link
  code              text NOT NULL UNIQUE,                      -- in the "take my place" link
  status            text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'taken', 'withdrawn')),
  taken_by          uuid REFERENCES booking_player,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  version           int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX place_offer_open ON place_offer (booking_player_id) WHERE status = 'offered';

-- A sub's seat while they pay: the place it takes over (cleared once it's theirs). It isn't a place of its own.
ALTER TABLE booking_player ADD COLUMN replaces uuid REFERENCES booking_player;
-- A late leaver's place that staff opened in the app: what its player gets back in all, as a percent of what
-- they paid, when someone joins and pays (the club's rule, or what staff chose).
ALTER TABLE booking_player ADD COLUMN fill_refund_percent int CHECK (fill_refund_percent BETWEEN 0 AND 100);

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000127', '00000000-0000-7000-8000-000000000006', 'booking.offer_place', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000128', '00000000-0000-7000-8000-000000000006', 'booking.withdraw_offer', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000129', '00000000-0000-7000-8000-000000000006', 'booking.take_place', 'allow', 'own');
