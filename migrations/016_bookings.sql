-- Court bookings, part one: opening hours, court blocks and bookings. Everything that holds a court is
-- still one court_time row, so the exclusion constraint keeps guaranteeing no double booking.

-- When each location is open, by weekday (0 is Sunday). No row, or no times, means closed that day.
CREATE TABLE opening_hours (
  id          uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES location,
  weekday     int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens       time,
  closes      time,                                -- '24:00' is midnight at the end of the day
  version     int  NOT NULL DEFAULT 1,
  CHECK ((opens IS NULL) = (closes IS NULL) AND (closes IS NULL OR closes > opens)),
  UNIQUE (location_id, weekday)
);

-- A holiday or special day: closed (no times), or open different hours.
CREATE TABLE hours_exception (
  id          uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES location,
  on_date     date NOT NULL,
  opens       time,
  closes      time,
  note        text,
  active      boolean NOT NULL DEFAULT true,
  version     int  NOT NULL DEFAULT 1,
  CHECK ((opens IS NULL) = (closes IS NULL) AND (closes IS NULL OR closes > opens))
);
CREATE UNIQUE INDEX hours_exception_day ON hours_exception (location_id, on_date) WHERE active;

-- A court taken out of use (maintenance, a private event); its time lives in court_time.
CREATE TABLE court_block (
  id         uuid PRIMARY KEY,
  reason     text NOT NULL CHECK (reason IN ('maintenance', 'fault', 'resurfacing', 'event', 'other')),
  note       text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);

CREATE TABLE booking (
  id            uuid PRIMARY KEY,
  code          text NOT NULL UNIQUE,                -- short, for the desk: KP-8F3Q
  location_id   uuid NOT NULL REFERENCES location,
  kind          text NOT NULL DEFAULT 'court' CHECK (kind IN ('court')),
  organiser_id  uuid REFERENCES person,
  status        text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'completed')),
  source        text NOT NULL CHECK (source IN ('app', 'desk', 'agent', 'import')),
  price_cents   int  NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  quote         jsonb,                               -- how the price was worked out, as it was sold
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  cancel_reason text,
  version       int NOT NULL DEFAULT 1
);

-- Who plays: a person, or a guest by name, and their share of the price.
CREATE TABLE booking_player (
  id            uuid PRIMARY KEY,
  booking_id    uuid NOT NULL REFERENCES booking,
  person_id     uuid REFERENCES person,
  guest_name    text,
  share_cents   int  NOT NULL DEFAULT 0 CHECK (share_cents >= 0),
  checked_in_at timestamptz,
  no_show       boolean NOT NULL DEFAULT false,
  removed_at    timestamptz,
  version       int NOT NULL DEFAULT 1,
  CHECK ((person_id IS NULL) <> (guest_name IS NULL))
);
CREATE INDEX booking_player_booking ON booking_player (booking_id);
CREATE INDEX booking_player_person ON booking_player (person_id);

ALTER TABLE court_time ADD COLUMN booking_id uuid REFERENCES booking;
ALTER TABLE court_time ADD COLUMN block_id uuid REFERENCES court_block;
ALTER TABLE court_time ADD CONSTRAINT court_time_owner
  CHECK ((kind IN ('booking', 'hold')) = (booking_id IS NOT NULL) AND (kind = 'block') = (block_id IS NOT NULL));
CREATE INDEX court_time_booking ON court_time (booking_id);
CREATE INDEX court_time_block ON court_time (block_id);
CREATE INDEX court_time_court_start ON court_time (court_id, lower(during)) WHERE active;

-- Default grants: the front desk books and blocks courts and sets special days; members' own
-- bookings come with payments. Managers and owners already can.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000070', '00000000-0000-7000-8000-000000000003', 'booking.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000071', '00000000-0000-7000-8000-000000000003', 'court.block', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000072', '00000000-0000-7000-8000-000000000003', 'court.unblock', 'allow', 'any');
