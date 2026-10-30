-- Memberships: plans and what they give (member prices on courts, a longer booking window), and who has
-- one. Joining and paying in the app (auto-renewal) builds on this.

CREATE TABLE membership_plan (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,                       -- "Monthly", "Annual", "Off-peak"
  description text,
  price_cents int  NOT NULL CHECK (price_cents >= 0),
  period      text NOT NULL CHECK (period IN ('month', 'year')),
  days_ahead  int  CHECK (days_ahead BETWEEN 1 AND 365),   -- members book this far ahead; none: the club's rule
  join_in_app boolean NOT NULL DEFAULT true,       -- offered in the members' app (once paying there exists)
  sort        int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  version     int  NOT NULL DEFAULT 1
);

CREATE TABLE membership (
  id                   uuid PRIMARY KEY,
  person_id            uuid NOT NULL REFERENCES person,
  plan_id              uuid NOT NULL REFERENCES membership_plan,
  status               text NOT NULL CHECK (status IN ('active', 'past_due', 'ended')),
  source               text NOT NULL CHECK (source IN ('app', 'desk', 'import')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz,                -- none: until someone ends it (given at the desk)
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  ended_at             timestamptz,
  note                 text,
  provider_ref         text,                       -- the provider's subscription, when paid in the app
  version              int NOT NULL DEFAULT 1
);
-- One membership at a time.
CREATE UNIQUE INDEX membership_one_live ON membership (person_id) WHERE status IN ('active', 'past_due');

-- A court price for members of chosen plans only; none: for everyone.
ALTER TABLE price_rule ADD COLUMN plan_ids uuid[];

-- The front desk gives and ends memberships; managers and owners already can.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000090', '00000000-0000-7000-8000-000000000003', 'membership.grant', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000091', '00000000-0000-7000-8000-000000000003', 'membership.end', 'allow', 'any');
