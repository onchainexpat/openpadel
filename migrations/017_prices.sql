-- Court prices and booking rules. A booking keeps its quote and the rules it was made under, so changing
-- either later never rewrites what someone already agreed to.

-- Whether members book courts in Kumi (off while the club books courts in Playtomic), and sales tax on
-- bookings in basis points (825 is 8.25%), shown in the price.
ALTER TABLE club ADD COLUMN IF NOT EXISTS court_bookings boolean NOT NULL DEFAULT false;
ALTER TABLE club ADD COLUMN IF NOT EXISTS tax_rate_bp int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 3000);

-- What a court costs an hour, by location, courts, weekdays, time of day and season. Each half hour of a
-- booking is priced by the highest-priority rule that covers it, so a booking running from off-peak into
-- peak pays each part at its own rate.
CREATE TABLE price_rule (
  id             uuid PRIMARY KEY,
  location_id    uuid NOT NULL REFERENCES location,
  name           text NOT NULL,                    -- "Peak", "Weekend", "Summer off-peak"
  court_ids      uuid[],                           -- none: every court at the location
  weekdays       int[],                            -- none: every day (0 is Sunday)
  starts         time,                             -- the half hours it covers, by when they start; none: all day
  ends           time,
  valid_from     date,                             -- a season; none: always
  valid_to       date,
  cents_per_hour int NOT NULL CHECK (cents_per_hour >= 0),
  priority       int NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  version        int NOT NULL DEFAULT 1,
  CHECK ((starts IS NULL) = (ends IS NULL) AND (ends IS NULL OR ends > starts)),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX price_rule_location ON price_rule (location_id) WHERE active;

-- The booking rules, in versions: a change adds a version; bookings keep the one they were made under.
CREATE TABLE booking_policy (
  id                   uuid PRIMARY KEY,
  version_no           int  NOT NULL UNIQUE,
  days_ahead           int  NOT NULL DEFAULT 14 CHECK (days_ahead BETWEEN 1 AND 365),
  max_active           int  NOT NULL DEFAULT 3 CHECK (max_active BETWEEN 1 AND 50),      -- upcoming bookings one person can organise
  free_cancel_hours    int  NOT NULL DEFAULT 24 CHECK (free_cancel_hours BETWEEN 0 AND 720),
  late_refund_percent  int  NOT NULL DEFAULT 0 CHECK (late_refund_percent BETWEEN 0 AND 100),  -- what comes back when cancelling later
  split_deadline_hours int  NOT NULL DEFAULT 24 CHECK (split_deadline_hours BETWEEN 1 AND 168), -- "pay my part": the organiser covers what's unpaid this long before
  lengths              int[] NOT NULL DEFAULT '{60,90,120}',
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1
);
INSERT INTO booking_policy (id, version_no) VALUES ('00000000-0000-7000-8002-000000000001', 1);

ALTER TABLE booking ADD COLUMN policy_id uuid REFERENCES booking_policy;
ALTER TABLE booking ADD COLUMN tax_cents int NOT NULL DEFAULT 0 CHECK (tax_cents >= 0);   -- the tax inside price_cents
