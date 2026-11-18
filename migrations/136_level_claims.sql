-- Levels players bring from other apps (level_claims.ts): every claim is kept, several at once, one per app. The start
-- comes from the surest of them (the lowest uncertainty); the others are shown beside it. Staff confirm one (it then
-- counts as seen in the app), change it or turn it down with a reason the player reads. A screenshot the player adds
-- as proof is kept sealed, for the player and staff only, and deleted once staff answer or after 60 days.
CREATE TABLE level_claim (
  id           uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES person,
  platform     text NOT NULL,
  raw          double precision NOT NULL,                 -- the number as the other app shows it, on its own scale
  conf         jsonb NOT NULL DEFAULT '{}',               -- how sure that app says it is (reliability, matches, WPR's HC/LC)
  start_level  numeric(4,2),                              -- on the club's 0 to 7; null when the scale isn't converted
  last_played  date,
  profile_url  text CHECK (profile_url IS NULL OR (profile_url ~ '^https://' AND char_length(profile_url) <= 300)),
  sent_by      uuid REFERENCES person,                    -- the player, or a parent for their junior
  -- waiting: for staff (above the club's line, or a scale not converted); standing: counts as the player's word;
  -- confirmed: staff checked it (or gave its start); rejected: staff turned it down; removed: the player took it away.
  status       text NOT NULL CHECK (status IN ('waiting', 'standing', 'confirmed', 'rejected', 'removed')),
  evidence     text NOT NULL DEFAULT 'self' CHECK (evidence IN ('self', 'staff_seen')),
  sigma        double precision CHECK (sigma IS NULL OR sigma >= 0.6),   -- how unsure a start from it is
  event_id     uuid,                                      -- the import_seed it's the start through, while it is
  proof        text NOT NULL DEFAULT 'none' CHECK (proof IN ('none', 'kept', 'deleted')),
  answer       text CHECK (answer IS NULL OR char_length(answer) <= 300),   -- staff's reason, which the player reads
  answered_by  uuid REFERENCES person,
  answered_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);
-- One standing claim per app: another from the same app is a new claim once the first is taken away or turned down.
CREATE UNIQUE INDEX level_claim_one_per_app ON level_claim (person_id, platform) WHERE status IN ('waiting', 'standing', 'confirmed');
CREATE INDEX level_claim_person ON level_claim (person_id, created_at);
CREATE INDEX level_claim_open ON level_claim (created_at) WHERE status IN ('waiting', 'standing');

-- A screenshot of the other app, sealed (sealed.ts). It reaches the server before the claim (the members' app sends it
-- first, as the vault does), so it waits unattached for up to an hour; attached, it's kept until staff answer the
-- claim or 60 days pass, then deleted.
CREATE TABLE level_proof (
  id           uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES person,           -- whose level it's for
  claim_id     uuid REFERENCES level_claim ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes        bytea NOT NULL,
  size_bytes   int NOT NULL CHECK (size_bytes BETWEEN 1 AND 3000000),
  created_by   uuid REFERENCES person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  attached_at  timestamptz
);
CREATE INDEX level_proof_claim ON level_proof (claim_id);
CREATE INDEX level_proof_age ON level_proof (created_at);

-- Front desk answers claims (coaches and managers can already, through level.*); members take their own away.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000013601', '00000000-0000-7000-8000-000000000003', 'level.answer_claim', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000013602', '00000000-0000-7000-8000-000000000006', 'level.remove_claim', 'allow', 'own');
