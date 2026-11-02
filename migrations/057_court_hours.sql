-- A court's own week (bookings.ts, courtOpenings): an outdoor court that closes at dusk, one that opens later. A
-- weekday a court has no hours of its own follows its location's; a row with no times is that court closed that
-- day. A row no longer used is kept, switched off. Special days still apply to every court, unless one court has
-- its own special day for that date.
CREATE TABLE court_hours (
  id       uuid PRIMARY KEY,
  court_id uuid NOT NULL REFERENCES court,
  weekday  int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens    time,
  closes   time,                                   -- '24:00' is midnight at the end of the day
  active   boolean NOT NULL DEFAULT true,
  version  int  NOT NULL DEFAULT 1,
  CHECK ((opens IS NULL) = (closes IS NULL) AND (closes IS NULL OR closes > opens)),
  UNIQUE (court_id, weekday)
);

-- A special day for one court only; none: the whole location's.
ALTER TABLE hours_exception ADD COLUMN court_id uuid REFERENCES court;
DROP INDEX hours_exception_day;
CREATE UNIQUE INDEX hours_exception_day ON hours_exception (location_id, coalesce(court_id, '00000000-0000-0000-0000-000000000000'::uuid), on_date) WHERE active;
