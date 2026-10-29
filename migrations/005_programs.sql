-- Courts, court time, and programming (data_model.md 1, 3, 7): one model for clinics, courses,
-- socials, tournaments and leagues, with rosters where leaving and refunding are separate.
CREATE TABLE court (
  id          uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES location,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'indoor' CHECK (kind IN ('indoor', 'covered_outdoor', 'outdoor')),
  sport       text NOT NULL DEFAULT 'padel' CHECK (sport IN ('padel', 'pickleball', 'tennis')),
  bookable    boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version     int NOT NULL DEFAULT 1
);

CREATE TABLE program (
  id                   uuid PRIMARY KEY,
  location_id          uuid NOT NULL REFERENCES location,
  kind                 text NOT NULL CHECK (kind IN ('clinic', 'course', 'league', 'tournament', 'social')),
  format               text CHECK (format IN ('americano', 'mexicano', 'king_of_court')),
  name                 text NOT NULL,
  level_min            numeric(3,2),
  level_max            numeric(3,2),
  capacity             int NOT NULL CHECK (capacity > 0),
  price_cents          int NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  sign_up              text NOT NULL DEFAULT 'whole_program' CHECK (sign_up IN ('whole_program', 'per_session')),
  refund_window_hours  int NOT NULL DEFAULT 24 CHECK (refund_window_hours >= 0),
  refund_inside_window text NOT NULL DEFAULT 'none' CHECK (refund_inside_window IN ('none', 'credit', 'full')),
  refund_rule_version  int NOT NULL DEFAULT 1,
  visibility           text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members', 'hidden')),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  version              int NOT NULL DEFAULT 1
);

CREATE TABLE session (
  id                uuid PRIMARY KEY,
  program_id        uuid NOT NULL REFERENCES program,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL CHECK (ends_at > starts_at),
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'moved', 'cancelled')),
  capacity_override int,
  version           int NOT NULL DEFAULT 1
);
CREATE INDEX session_program ON session (program_id, starts_at);

-- The one rule the calendar never breaks: two things can't hold one court at one time.
CREATE TABLE court_time (
  id         uuid PRIMARY KEY,
  court_id   uuid NOT NULL REFERENCES court,
  during     tstzrange NOT NULL CHECK (NOT isempty(during)),
  kind       text NOT NULL CHECK (kind IN ('booking', 'session', 'block', 'hold', 'mirror')),
  session_id uuid REFERENCES session,
  active     boolean NOT NULL DEFAULT true,
  hold_until timestamptz,
  version    int NOT NULL DEFAULT 1,
  CHECK ((kind = 'session') = (session_id IS NOT NULL)),
  EXCLUDE USING gist (court_id WITH =, during WITH &&) WHERE (active)
);

CREATE TABLE enrolment (
  id                      uuid PRIMARY KEY,
  program_id              uuid NOT NULL REFERENCES program,
  session_id              uuid REFERENCES session,
  person_id               uuid NOT NULL REFERENCES person,
  status                  text NOT NULL CHECK (status IN ('booked', 'waitlisted', 'cancelled', 'attended', 'no_show')),
  waitlist_position       int,
  price_cents             int NOT NULL DEFAULT 0,
  paid_by                 text NOT NULL DEFAULT 'none' CHECK (paid_by IN ('none', 'card', 'credit', 'pack', 'comp', 'desk', 'transfer')),
  comp_note               text,
  left_at                 timestamptz,
  left_how                text CHECK (left_how IN ('left', 'removed', 'transferred', 'no_show')),
  left_reason             text CHECK (left_reason IN ('late_cancel', 'no_show', 'found_sub', 'club', 'other')),
  refund_outcome          text CHECK (refund_outcome IN ('none', 'credit', 'partial', 'full')),
  refund_cents            int,
  refund_rule_version     int,
  refund_changed_by_staff boolean NOT NULL DEFAULT false,
  refund_note             text,
  replaced_by             uuid REFERENCES enrolment,
  created_at              timestamptz NOT NULL DEFAULT now(),
  version                 int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX enrolment_one_place ON enrolment (program_id, coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid), person_id) WHERE status IN ('booked', 'waitlisted');

CREATE TABLE waitlist_offer (
  id           uuid PRIMARY KEY,
  enrolment_id uuid NOT NULL REFERENCES enrolment,
  offered_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  outcome      text CHECK (outcome IN ('taken', 'declined', 'expired')),
  version      int NOT NULL DEFAULT 1
);

-- Default grants (action_catalogue.md section 4): front desk signs players up and takes them off;
-- members join, leave and pass on their own places; comps ask a manager.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000020', '00000000-0000-7000-8000-000000000003', 'enrolment.join', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000021', '00000000-0000-7000-8000-000000000003', 'enrolment.leave', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000022', '00000000-0000-7000-8000-000000000003', 'enrolment.remove', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000023', '00000000-0000-7000-8000-000000000003', 'enrolment.transfer', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000024', '00000000-0000-7000-8000-000000000003', 'enrolment.comp', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000000025', '00000000-0000-7000-8000-000000000003', 'enrolment.accept_offer', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000026', '00000000-0000-7000-8000-000000000006', 'enrolment.join', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000027', '00000000-0000-7000-8000-000000000006', 'enrolment.leave', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000028', '00000000-0000-7000-8000-000000000006', 'enrolment.transfer', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000029', '00000000-0000-7000-8000-000000000006', 'enrolment.accept_offer', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000030', '00000000-0000-7000-8000-000000000002', 'enrolment.comp', 'allow', 'any');
