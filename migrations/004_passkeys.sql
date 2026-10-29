-- Passkeys: challenges for adding and signing in, passkeys that can be revoked rather than
-- deleted, and how each session signed in (the strong-sign-in rule reads it).
ALTER TABLE auth_challenge DROP CONSTRAINT auth_challenge_kind_check;
ALTER TABLE auth_challenge ADD CONSTRAINT auth_challenge_kind_check CHECK (kind IN ('email_code', 'phone_code', 'passkey_add', 'passkey_sign_in'));
ALTER TABLE auth_challenge ADD COLUMN person_id uuid REFERENCES person;
ALTER TABLE passkey ADD COLUMN name text, ADD COLUMN revoked_at timestamptz, ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE web_session ADD COLUMN method text NOT NULL DEFAULT 'email_code' CHECK (method IN ('email_code', 'passkey'));

-- Everyone with an account looks after their own passkeys. Owners and managers have '*'.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000010', '00000000-0000-7000-8000-000000000003', 'person.passkey_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000011', '00000000-0000-7000-8000-000000000004', 'person.passkey_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000012', '00000000-0000-7000-8000-000000000005', 'person.passkey_*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000013', '00000000-0000-7000-8000-000000000006', 'person.passkey_*', 'allow', 'own');
