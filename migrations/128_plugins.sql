-- Plugins (docs/plugins/): an extra a club installs, declared by a manifest (openpadel-plugin.json) that says exactly
-- what it may do. A plugin is a separate program that talks to the club only through the door (/mcp and the command
-- line) and gets events by signed webhook: it never runs inside the server and never touches the database.
--
-- Each installed plugin is a club agent (126) with a role made from its manifest: the actions it may plan (allow or
-- ask) and the parts of the club it reads. Its token is never shown to whoever installs it: a remote plugin is sent it
-- by a signed registration POST to its own address; a local one has it written into its service's environment on the
-- server. Its manifest is kept as installed.
CREATE TABLE plugin (
  id                    uuid PRIMARY KEY,
  name                  text NOT NULL,
  release               text NOT NULL,                       -- the manifest's version
  manifest              jsonb NOT NULL,                      -- as installed
  manifest_sha256       text NOT NULL,
  source                text NOT NULL CHECK (source IN ('catalog', 'url', 'file')),
  source_url            text,
  mode                  text NOT NULL CHECK (mode IN ('remote', 'local')),
  -- Where it's reached: a remote plugin's address, or a local one's port on this server (http://127.0.0.1:<port>).
  base_url              text,
  local_port            int UNIQUE CHECK (local_port BETWEEN 1024 AND 65535),
  status                text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'on', 'paused', 'removed')),
  settings              jsonb NOT NULL DEFAULT '{}',
  agent_id              uuid UNIQUE REFERENCES agent,
  role_id               uuid REFERENCES role,
  subscription_id       uuid REFERENCES webhook_subscription,
  -- The plugin's own secret (sealed): it signs what the club forwards to it from /plugins/<name>/hook.
  secret_sealed         text NOT NULL,
  secret_last4          text NOT NULL,
  -- Its token and secrets on their way to it (sealed), until they're delivered; then cleared. Never in the change log.
  registration_sealed   text,
  registration_attempts int NOT NULL DEFAULT 0,
  registration_next_at  timestamptz,
  registration_error    text,
  registered_at         timestamptz,
  installed_by          uuid REFERENCES person,
  installed_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  removed_at            timestamptz,
  version               int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX plugin_name_live ON plugin (name) WHERE status <> 'removed';
CREATE INDEX plugin_registration_due ON plugin (registration_next_at) WHERE registration_sealed IS NOT NULL;

-- A plugin's role is the club's like any other, but it belongs to the plugin: nobody else is given it, it isn't
-- edited in Roles, and it changes only with the plugin (plugin.update). It may also read parts of the club its
-- actions don't cover (read_areas), as its manifest says.
ALTER TABLE role ADD COLUMN for_plugin boolean NOT NULL DEFAULT false;
ALTER TABLE role ADD COLUMN read_areas text[] NOT NULL DEFAULT '{}';

-- The club's key for signing what it sends plugins (an Ed25519 key pair): its private half sealed, its public half
-- published at /.well-known/openpadel-plugin-key so a plugin can check a registration really came from this club.
CREATE TABLE plugin_key (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  private_sealed text NOT NULL,
  public_jwk   jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Installing, setting up, updating, pausing and removing plugins: the owner (through '*'); a manager asks.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000012801', '00000000-0000-7000-8000-000000000002', 'plugin.*', 'ask', 'any');
