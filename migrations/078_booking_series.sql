-- Weekly court bookings: the same court, day and time every week, for one member. Each week is an ordinary booking
-- (its own code, court time, price, rules and payment), made from the series' prices and rules as they were when it
-- was made. Staff make one for a member, every week owed at the desk. A member makes their own when the club allows
-- it (club.weekly_bookings): the first week is paid by card, which saves the card for the others, and each later
-- week is booked as it comes into the member's booking window and goes on that card at the club's pay deadline
-- (the policy's split_deadline_hours before it starts), as unpaid shares do.
ALTER TABLE club ADD COLUMN weekly_bookings boolean NOT NULL DEFAULT false;
ALTER TABLE club ADD COLUMN weekly_max_weeks int NOT NULL DEFAULT 12 CHECK (weekly_max_weeks BETWEEN 2 AND 26);

CREATE TABLE booking_series (
  id            uuid PRIMARY KEY,
  location_id   uuid NOT NULL REFERENCES location,
  court_id      uuid NOT NULL REFERENCES court,
  organiser_id  uuid NOT NULL REFERENCES person,
  starts        time NOT NULL,                                   -- on the club's clock
  minutes       int  NOT NULL CHECK (minutes > 0),
  first_date    date NOT NULL,
  last_date     date NOT NULL CHECK (last_date >= first_date),
  pay           text NOT NULL CHECK (pay IN ('card', 'desk')),
  source        text NOT NULL CHECK (source IN ('app', 'desk')),
  policy_id     uuid NOT NULL REFERENCES booking_policy,
  ended_at      timestamptz,
  paused_at     timestamptz,                                     -- a member's, while the club takes no weekly bookings
  card_failed_at timestamptz,                                    -- a week's charge declined: later weeks owed at the desk
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);
CREATE INDEX booking_series_open ON booking_series (organiser_id) WHERE ended_at IS NULL;

-- Each week of a series, priced when the series was made: its booking, or why it wasn't booked, or neither yet
-- (a member's week not in their booking window yet). One row a week, so a week is never booked twice.
CREATE TABLE booking_series_week (
  id          uuid PRIMARY KEY,
  series_id   uuid NOT NULL REFERENCES booking_series,
  on_date     date NOT NULL,
  booking_id  uuid REFERENCES booking,                            -- null and not missed: still to be booked
  missed      text CHECK (missed IN ('taken', 'closed', 'not_bookable', 'too_late', 'no_card', 'unpaid', 'limit')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  UNIQUE (series_id, on_date),
  price_cents int NOT NULL CHECK (price_cents >= 0),               -- priced when the series was made
  tax_cents   int NOT NULL,
  quote       jsonb,
  CHECK (booking_id IS NULL OR missed IS NULL)
);

ALTER TABLE booking ADD COLUMN series_id uuid REFERENCES booking_series;
CREATE INDEX booking_series_bookings ON booking (series_id) WHERE series_id IS NOT NULL;

-- Members make their own weekly bookings (when the club allows it) and end their own; the front desk's
-- 'booking.*' covers making one for a member and ending it.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000771', '00000000-0000-7000-8000-000000000006', 'booking.repeat_request', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000772', '00000000-0000-7000-8000-000000000006', 'booking.repeat_end', 'allow', 'own');
