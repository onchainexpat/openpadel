-- A club service's settings the owner sets in the app (Settings, Connectors; or `openpadel connect`), kept in the vault:
-- the vault item that holds one names the setting it is (OPENPADEL_RESEND_API_KEY). One kept at a time per setting.
-- The settings file still wins when it has the setting too (service_settings.ts).
ALTER TABLE vault_item ADD COLUMN setting text;
CREATE UNIQUE INDEX vault_item_setting ON vault_item (setting) WHERE active AND setting IS NOT NULL;

-- `openpadel connect <service> --link`: a link straight to that service's form for the owner, which an agent hands
-- on without opening it. It opens nothing by itself (the owner still signs in) and runs out in 15 minutes.
CREATE TABLE connector_link (
  id          uuid PRIMARY KEY,
  service     text NOT NULL,
  person_id   uuid NOT NULL REFERENCES person,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
