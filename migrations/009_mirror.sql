-- The read-only Playtomic mirror (strategy.md, "alongside Playtomic"). Courts are linked through
-- external_ref (system 'playtomic', entity 'court'). Kumi never writes to Playtomic: these are
-- Kumi's copy of each booking it has seen, and what it decided about it.
CREATE TABLE mirror_booking (
  ref           text PRIMARY KEY,                  -- '<booking_id>:<resource_id>'
  system        text NOT NULL DEFAULT 'playtomic',
  court_id      uuid NOT NULL REFERENCES court,
  during        tstzrange NOT NULL CHECK (NOT isempty(during)),
  booking_type  text NOT NULL,
  -- held: a 'mirror' court_time keeps Kumi off the court. covered: the club's own block or event in
  -- Playtomic over a Kumi event. conflict: it overlaps Kumi's court time; staff are told once. gone:
  -- cancelled or no longer in Playtomic.
  status        text NOT NULL CHECK (status IN ('held', 'covered', 'conflict', 'gone')),
  court_time_id uuid REFERENCES court_time,
  clash_id      uuid REFERENCES court_time,        -- the Kumi court time it covers or clashes with
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  CHECK ((status = 'held') = (court_time_id IS NOT NULL))
);
CREATE INDEX mirror_booking_start ON mirror_booking (system, lower(during));
CREATE INDEX mirror_booking_court_time ON mirror_booking (court_time_id);

-- How each connector's last sync went, for the staff screen and "a connector needs attention".
CREATE TABLE connector_status (
  system       text PRIMARY KEY,
  last_sync_at timestamptz,
  last_ok_at   timestamptz,
  last_error   text,
  fetched      int,
  unmapped     jsonb NOT NULL DEFAULT '[]'
);
