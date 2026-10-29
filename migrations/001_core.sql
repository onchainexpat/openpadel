-- The club, its places, its people and roles, and the action spine (data_model.md 1, 2, 12).
-- One database per club, so no table carries a club id.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE club (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  name             text NOT NULL,
  legal_name       text,
  brand_colour     text NOT NULL DEFAULT '#0B5A55' CHECK (brand_colour ~ '^#[0-9A-Fa-f]{6}$'),
  brand_font       text,
  time_zone        text NOT NULL,
  languages        text[] NOT NULL DEFAULT '{en,es}' CHECK (languages <@ '{en,es}' AND cardinality(languages) > 0),
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'es')),
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  version          int  NOT NULL DEFAULT 1
);

CREATE TABLE location (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  time_zone   text NOT NULL,
  address     text,
  opened_on   date,
  archived_at timestamptz,
  version     int NOT NULL DEFAULT 1
);

CREATE TABLE person (
  id           uuid PRIMARY KEY,
  given_name   text,
  family_name  text,
  display_name text NOT NULL,
  email        text,
  phone        text CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  birth_year   int,
  locale       text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'es')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'guest', 'archived')),
  created_via  text NOT NULL CHECK (created_via IN ('signup', 'import', 'desk', 'setup')),
  trust_level  int  NOT NULL DEFAULT 1 CHECK (trust_level BETWEEN 1 AND 4),
  redacted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      int  NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX person_email_unique ON person (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX person_phone_unique ON person (phone) WHERE phone IS NOT NULL;

-- No passwords: an email code, a phone code, or a passkey.
CREATE TABLE auth_identity (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,
  kind        text NOT NULL CHECK (kind IN ('email', 'phone')),
  value       text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_identity_unique ON auth_identity (kind, lower(value));

CREATE TABLE auth_challenge (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('email_code', 'phone_code')),
  target      text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int  NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenge_target ON auth_challenge (lower(target), created_at DESC);

CREATE TABLE passkey (
  credential_id text PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE TABLE web_session (
  token_hash   text PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  user_agent   text,
  revoked_at   timestamptz
);

-- Roles and grants (permissions.md). A grant is an action name or pattern ('booking.*', '*').
CREATE TABLE role (
  id      uuid PRIMARY KEY,
  key     text NOT NULL UNIQUE,          -- owner, manager, front_desk, coach, accountant, member
  system  boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE role_grant (
  id         uuid PRIMARY KEY,
  role_id    uuid NOT NULL REFERENCES role,
  pattern    text NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('allow', 'ask', 'no')),
  rows_scope text NOT NULL DEFAULT 'any' CHECK (rows_scope IN ('any', 'own')),
  time_scope text NOT NULL DEFAULT 'any_time' CHECK (time_scope IN ('any_time', 'on_shift')),
  field_mask jsonb,
  version    int NOT NULL DEFAULT 1,
  UNIQUE (role_id, pattern)
);

-- A person holds a role everywhere (location_id null) or at one location.
CREATE TABLE person_role (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,
  role_id     uuid NOT NULL REFERENCES role,
  location_id uuid REFERENCES location,
  active      boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX person_role_unique ON person_role (person_id, role_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE active;

CREATE TABLE staff_member (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL UNIQUE REFERENCES person,
  title       text,
  active      boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1
);

CREATE TABLE staff_shift (
  id              uuid PRIMARY KEY,
  staff_member_id uuid NOT NULL REFERENCES staff_member,
  location_id     uuid NOT NULL REFERENCES location,
  during          tstzrange NOT NULL CHECK (NOT isempty(during))
);
CREATE INDEX staff_shift_during ON staff_shift USING gist (staff_member_id, during);

CREATE TABLE agent (
  id                 uuid PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('concierge', 'desk', 'builder', 'summaries', 'import', 'system')),
  capped_role_id     uuid REFERENCES role,
  acts_for_person_id uuid REFERENCES person,
  version            int NOT NULL DEFAULT 1
);

-- The spine: every write by anyone or anything is one of these (data_model.md 12).
CREATE TABLE action_run (
  id               uuid PRIMARY KEY,
  action           text NOT NULL,
  action_version   int  NOT NULL,
  actor_person_id  uuid REFERENCES person,
  agent_id         uuid REFERENCES agent,
  via              text NOT NULL,
  location_id      uuid REFERENCES location,
  input            jsonb NOT NULL,
  plan             jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN ('planned', 'awaiting_approval', 'applied', 'failed', 'expired', 'undone')),
  undo_kind        text NOT NULL CHECK (undo_kind IN ('reversible', 'compensating', 'none')),
  undo_note        jsonb,
  undo_of          uuid REFERENCES action_run,
  undo_until       timestamptz,
  parent_id        uuid REFERENCES action_run,
  read_versions    jsonb NOT NULL,
  plan_expires_at  timestamptz NOT NULL,
  money_cents      bigint NOT NULL DEFAULT 0,
  idempotency_key  text UNIQUE,
  ai_cost_cents    int NOT NULL DEFAULT 0,
  result           jsonb,
  error            jsonb,
  approved_by      uuid REFERENCES person,
  created_at       timestamptz NOT NULL DEFAULT now(),
  applied_at       timestamptz
);
CREATE INDEX action_run_actor ON action_run (actor_person_id, created_at DESC);
CREATE INDEX action_run_waiting ON action_run (created_at) WHERE status = 'awaiting_approval';

CREATE TABLE entity_change (
  id            bigserial PRIMARY KEY,
  action_run_id uuid NOT NULL REFERENCES action_run,
  entity        text NOT NULL,
  entity_id     text NOT NULL,
  op            text NOT NULL CHECK (op IN ('insert', 'update')),
  before        jsonb,
  after         jsonb NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_change_entity ON entity_change (entity, entity_id, at DESC);
CREATE INDEX entity_change_run ON entity_change (action_run_id);

-- Events leave through an outbox written in the same transaction (ground rule 8).
CREATE TABLE event_outbox (
  id            bigserial PRIMARY KEY,
  action_run_id uuid REFERENCES action_run,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0
);
CREATE INDEX event_outbox_pending ON event_outbox (id) WHERE delivered_at IS NULL;

-- Consent is append-only: the current answer is the latest row per person, channel, purpose.
CREATE TABLE channel_consent (
  id           uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES person,
  channel      text NOT NULL CHECK (channel IN ('push', 'email', 'sms', 'whatsapp')),
  purpose      text NOT NULL CHECK (purpose IN ('account', 'invites', 'club_news')),
  granted      boolean NOT NULL,
  source       text NOT NULL,
  form_version text,
  evidence     jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_consent_latest ON channel_consent (person_id, channel, purpose, at DESC);
CREATE RULE channel_consent_no_update AS ON UPDATE TO channel_consent DO INSTEAD NOTHING;
CREATE RULE channel_consent_no_delete AS ON DELETE TO channel_consent DO INSTEAD NOTHING;

CREATE TABLE external_ref (
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  system      text NOT NULL,
  external_id text NOT NULL,
  UNIQUE (system, external_id, entity)
);

CREATE TABLE missing_feature (
  id         uuid PRIMARY KEY,
  asked      text NOT NULL,
  person_id  uuid REFERENCES person,
  agent_id   uuid REFERENCES agent,
  at         timestamptz NOT NULL DEFAULT now()
);
