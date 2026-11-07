-- Moving from Playtomic (docs/setup/moving-from-playtomic.md).
--
-- The archive: each Playtomic booking as Playtomic gave it, kept from the first read (stage 1), because Playtomic
-- itself keeps bookings only three months back. The row without its players is `raw`; the players are rows of
-- their own, matched to Kumi people where an email or a Playtomic id says who they are. A member's rows lose their
-- name and email when their account is deleted (privacy.ts); Playtomic's own id stays on them, without either, so a
-- later read of the same booking doesn't copy the name back in.
CREATE TABLE playtomic_booking (
  booking_id    text PRIMARY KEY,                     -- Playtomic's
  object_id     text,
  resource_id   text NOT NULL,
  resource_name text NOT NULL,
  court_id      uuid REFERENCES court,                -- the Kumi court it was linked to when last read
  sport_id      text,
  booking_type  text NOT NULL,
  origin        text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
  price         text,                                 -- as Playtomic writes it: "10 EUR"
  price_cents   int,                                  -- in the club's currency, when it's the club's currency
  currency      text,
  payment_status text,
  canceled      boolean NOT NULL DEFAULT false,
  owner_id      text,                                 -- Playtomic's id of the player who owns it
  coach_ids     text[] NOT NULL DEFAULT '{}',
  course_id     text,
  course_name   text,
  activity_id   text,
  activity_name text,
  raw           jsonb NOT NULL,                       -- the row as given, less participant_info (kept below)
  row_hash      text NOT NULL,                        -- of the whole row as given: unchanged rows aren't written again
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  taken_over_booking_id uuid REFERENCES booking,      -- the Kumi booking that took it over (stage 3)
  version       int NOT NULL DEFAULT 1
);
CREATE INDEX playtomic_booking_start ON playtomic_booking (starts_at);
CREATE INDEX playtomic_booking_taken ON playtomic_booking (taken_over_booking_id) WHERE taken_over_booking_id IS NOT NULL;

CREATE TABLE playtomic_booking_player (
  id             uuid PRIMARY KEY,
  booking_id     text NOT NULL REFERENCES playtomic_booking ON DELETE CASCADE,
  participant_id text NOT NULL,                       -- Playtomic's id of the player
  family_member_id text,
  name           text,
  email          text,
  accepts_commercial boolean,
  participant_type text,                              -- GUEST, CUSTOMER or CONTACT
  is_owner       boolean NOT NULL DEFAULT false,
  person_id      uuid REFERENCES person,              -- who they are here, when known
  erased_at      timestamptz,                         -- their account here was deleted: no name, no email
  version        int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX playtomic_booking_player_one ON playtomic_booking_player (booking_id, participant_id, coalesce(family_member_id, ''));
CREATE INDEX playtomic_booking_player_person ON playtomic_booking_player (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX playtomic_booking_player_participant ON playtomic_booking_player (participant_id);
CREATE INDEX playtomic_booking_player_email ON playtomic_booking_player (lower(email)) WHERE email IS NOT NULL;

-- A Playtomic booking a Kumi booking took over: Kumi's own court time holds the court, so the mirror doesn't hold
-- it twice. Its Kumi booking cancelled, the mirror holds it again (it may still be booked in Playtomic).
ALTER TABLE mirror_booking DROP CONSTRAINT mirror_booking_status_check;
ALTER TABLE mirror_booking ADD CONSTRAINT mirror_booking_status_check CHECK (status IN ('held', 'covered', 'conflict', 'gone', 'taken'));

-- Paid in Playtomic: a booking taken over keeps what was paid there as a payment of its own kind. No money moved
-- through Kumi and none goes back through it: a refund of it is made in Playtomic.
ALTER TABLE payment DROP CONSTRAINT payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check CHECK (method IN ('card', 'terminal', 'credit', 'cash', 'other', 'paid_elsewhere', 'pass', 'promo', 'playtomic'));

-- The owner's daily comparison of Playtomic and Kumi: run once a club day, and each difference said once.
ALTER TABLE connector_status ADD COLUMN compared_on date;
CREATE TABLE playtomic_compare_told (
  key     text PRIMARY KEY,                           -- '<kind>:<court>:<day>' or '<kind>:<booking>'
  told_at timestamptz NOT NULL DEFAULT now()
);
