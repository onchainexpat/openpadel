-- The club vault, and the server's own health records.
--
-- The vault keeps the club's keys (a supplier login, the alarm code, an API key Kumi will use) and small
-- documents (insurance, the lease, a signed waiver), all sealed with the server's key (sealed.ts). Only the
-- owner sees it. A secret is never shown again in full: only its last four characters. The value or file
-- itself is never in an action's input or the change log: the owner's app sends it to the server first,
-- which seals it into vault_blob and hands back an id, and the action names that id.
CREATE TABLE vault_blob (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('secret', 'document')),
  bytes        bytea NOT NULL,                 -- sealBytes: "KS1" + key id + AES-256-GCM
  size_bytes   int NOT NULL,                   -- of the value or file before sealing
  content_type text,                           -- documents: from the file's first bytes, never the name
  filename     text,
  last4        text,                           -- secrets: the last four characters, to tell them apart
  created_by   uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  attached_at  timestamptz                     -- when an action put it in the vault; unattached ones are tidied
);

CREATE TABLE vault_item (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('secret', 'document')),
  name         text NOT NULL,
  note         text,
  blob_id      uuid NOT NULL REFERENCES vault_blob,
  last4        text,
  filename     text,
  content_type text,
  size_bytes   int NOT NULL,
  created_by   uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  active       boolean NOT NULL DEFAULT true,
  version      int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX vault_item_name ON vault_item (lower(name)) WHERE active;

-- Each time the owner downloads a document. Reads aren't actions, so they're kept here.
CREATE TABLE vault_access (
  id        uuid PRIMARY KEY,
  item_id   uuid NOT NULL REFERENCES vault_item,
  person_id uuid REFERENCES person,
  at        timestamptz NOT NULL DEFAULT now()
);

-- The vault is the owner's alone: managers are told no (owners hold '*'), and no role the club makes can
-- hold it (roles.ts only offers what a manager may do without asking).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000301', '00000000-0000-7000-8000-000000000002', 'vault.*', 'no', 'any');

-- When the server's own jobs last ran and last worked: the nightly backup, its offsite copy and the monthly
-- restore test. /health/deep and `kumi doctor` read these; a job that starts failing tells staff once.
CREATE TABLE ops_heartbeat (
  name        text PRIMARY KEY,
  last_run_at timestamptz,
  last_ok_at  timestamptz,
  last_error  text,
  details     jsonb NOT NULL DEFAULT '{}'
);
