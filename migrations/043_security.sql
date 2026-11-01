-- Security: a second step at sign-in for staff, and roles the owner makes.
--
-- Two-step sign-in. A passkey is both steps on its own. Otherwise it's the emailed code and then a code from
-- an authenticator app (TOTP, RFC 6238), or one of ten one-time recovery codes. Who must: owners, managers
-- and anyone with a role the club made ('owner_manager', the default), or every staff role ('all_staff').
-- 'off' exists only for practice and test databases: no action sets it.
ALTER TABLE club ADD COLUMN two_factor text NOT NULL DEFAULT 'owner_manager' CHECK (two_factor IN ('owner_manager', 'all_staff', 'off'));

-- A session signed in by emailed code becomes two-step once the second code is given.
ALTER TABLE web_session ADD COLUMN second_factor text CHECK (second_factor IN ('totp', 'recovery'));

-- An authenticator being set up: the secret waits here (for 15 minutes) until a first code proves it.
ALTER TABLE auth_challenge DROP CONSTRAINT auth_challenge_kind_check;
ALTER TABLE auth_challenge ADD CONSTRAINT auth_challenge_kind_check CHECK (kind IN ('email_code', 'phone_code', 'passkey_add', 'passkey_sign_in', 'sign_up', 'totp_setup'));

-- One authenticator per person. The secret is a key: it never goes into the change log (actions.ts,
-- KEYS_NOT_KEPT), and a code's time step is kept so the same code can't be used twice.
CREATE TABLE staff_factor (
  person_id    uuid PRIMARY KEY REFERENCES person,
  secret       text NOT NULL,                -- base32, as authenticator apps take it
  confirmed_at timestamptz NOT NULL,
  last_step    bigint NOT NULL DEFAULT 0,
  removed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);

-- Recovery codes: shown once, kept only as hashes, each used once.
CREATE TABLE recovery_code (
  id         uuid PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES person,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_code_person ON recovery_code (person_id) WHERE used_at IS NULL;

-- Roles the owner makes: a name, what each may do (role_grant rows, never '*'), and which built-in role it
-- was copied from, if any. Built-in roles (system) can't be changed.
ALTER TABLE role ADD COLUMN name text;
ALTER TABLE role ADD COLUMN based_on text;
ALTER TABLE role ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE role ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
-- A role's grants are written and retired through actions now, so they need a way to be retired.
ALTER TABLE role_grant ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE role_grant DROP CONSTRAINT role_grant_role_id_pattern_key;
CREATE UNIQUE INDEX role_grant_one ON role_grant (role_id, pattern) WHERE active;

-- Everyone looks after their own second step (owners and managers have '*'). Resetting someone else's is the
-- owner's alone, so managers are told no.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000202', '00000000-0000-7000-8000-000000000003', 'person.factor_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000203', '00000000-0000-7000-8000-000000000004', 'person.factor_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000204', '00000000-0000-7000-8000-000000000005', 'person.factor_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000205', '00000000-0000-7000-8000-000000000006', 'person.factor_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000206', '00000000-0000-7000-8000-000000000002', 'person.reset_sign_in', 'no', 'any');
