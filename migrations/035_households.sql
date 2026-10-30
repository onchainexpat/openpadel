-- Households and juniors. A junior (under 18) has no login and no contact details: only a name and a birth
-- year, in a parent's household. The household's adults (whoever made it, and another parent they invited,
-- each with their own login) manage its juniors: they sign them up, book their lessons, pay, and get their
-- messages. Juniors never show on the public page, in level lists, among friends or in open matches.
--
-- Waivers: the club's waiver, one text, a new version each time it changes. An adult accepts the current
-- version before their first booking or sign-up, and a parent accepts it for each junior. A new version asks
-- again; with none set, nobody is asked.

ALTER TABLE person DROP CONSTRAINT person_created_via_check;
ALTER TABLE person ADD CONSTRAINT person_created_via_check CHECK (created_via IN ('signup', 'import', 'desk', 'setup', 'household'));
ALTER TABLE person ADD COLUMN junior boolean NOT NULL DEFAULT false;   -- no login of their own; managed by a household's adults
ALTER TABLE person ADD CONSTRAINT person_junior_no_contact CHECK (NOT junior OR (email IS NULL AND phone IS NULL));

CREATE TABLE household (
  id         uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);

CREATE TABLE household_member (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household,
  person_id    uuid NOT NULL REFERENCES person,
  role         text NOT NULL CHECK (role IN ('adult', 'member', 'junior')),   -- adult: a parent, who manages the juniors; member: a junior grown up, with their own login
  added_by     uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  version      int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX household_member_one ON household_member (person_id) WHERE removed_at IS NULL;   -- one household at a time
CREATE INDEX household_member_household ON household_member (household_id) WHERE removed_at IS NULL;

-- Another parent joins by a link the first one shares (nothing is sent to an address Kumi doesn't know).
CREATE TABLE household_invite (
  id           uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household,
  code         text NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES person,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'withdrawn')),
  accepted_by  uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  decided_at   timestamptz,
  version      int NOT NULL DEFAULT 1
);

CREATE TABLE waiver (
  id         uuid PRIMARY KEY,
  version_no int NOT NULL UNIQUE,
  body       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX waiver_one_active ON waiver (active) WHERE active;

CREATE TABLE waiver_acceptance (
  id          uuid PRIMARY KEY,
  waiver_id   uuid NOT NULL REFERENCES waiver,
  person_id   uuid NOT NULL REFERENCES person,   -- whom it covers
  accepted_by uuid NOT NULL REFERENCES person,   -- who accepted: themselves, or a parent for a junior
  accepted_at timestamptz NOT NULL,
  version     int NOT NULL DEFAULT 1,
  UNIQUE (waiver_id, person_id)
);

-- Members run their own household and accept the waiver for themselves and their juniors; front desk
-- helps families at the counter. Setting the waiver is a manager's (the '*' grants).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000142', '00000000-0000-7000-8000-000000000006', 'household.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000143', '00000000-0000-7000-8000-000000000006', 'waiver.accept', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000144', '00000000-0000-7000-8000-000000000003', 'household.*', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000145', '00000000-0000-7000-8000-000000000004', 'waiver.accept', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000146', '00000000-0000-7000-8000-000000000003', 'waiver.accept', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000147', '00000000-0000-7000-8000-000000000005', 'waiver.accept', 'allow', 'own');
