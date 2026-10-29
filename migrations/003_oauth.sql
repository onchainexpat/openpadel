-- The MCP doors (data_model.md 2): assistants register, a person grants them access with scopes,
-- and tokens are bound to this club's MCP address. Codes and tokens are stored as hashes.
CREATE TABLE oauth_client (
  client_id      text PRIMARY KEY,           -- ours for registered clients, a URL for published identities
  kind           text NOT NULL CHECK (kind IN ('registered', 'published')),
  name           text,
  redirect_uris  text[] NOT NULL,
  auth_method    text NOT NULL DEFAULT 'none' CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  secret_hash    text,
  metadata       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_grant (
  id               uuid PRIMARY KEY,
  person_id        uuid NOT NULL REFERENCES person,
  client_id        text NOT NULL REFERENCES oauth_client,
  scopes           text[] NOT NULL,
  weekly_cap_cents int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);

CREATE TABLE oauth_code (
  code_hash      text PRIMARY KEY,
  grant_id       uuid NOT NULL REFERENCES oauth_grant,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  resource       text NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz
);

CREATE TABLE oauth_token (
  token_hash text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id   uuid NOT NULL REFERENCES oauth_grant,
  family     uuid NOT NULL,                 -- a refresh chain; reusing an old refresh token revokes it all
  resource   text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_token_family ON oauth_token (family);
