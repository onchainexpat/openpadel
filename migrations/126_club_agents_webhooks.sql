-- Club agents and signed event webhooks (docs/agents/).
--
-- A club agent is an agent that isn't any one person's: an n8n workflow, a bot, a desk agent running all night. It is
-- the `agent` table's first real use: kind 'club', a name, the role that caps it (capped_role_id, a normal role the
-- club can edit), a weekly limit on the money its changes move, and one connection to the door (an oauth_grant with a
-- single long-lived token, kept only as a hash; its last four characters are kept to tell tokens apart). It acts
-- through a person row of its own (created_via 'agent', never able to sign in) holding that role, so every permission
-- check, read and approval works as for staff, and every change it makes is recorded with action_run.agent_id.
ALTER TABLE agent DROP CONSTRAINT agent_kind_check;
ALTER TABLE agent ADD CONSTRAINT agent_kind_check CHECK (kind IN ('concierge', 'desk', 'builder', 'summaries', 'import', 'system', 'club'));
ALTER TABLE agent
  ADD COLUMN name             text,
  ADD COLUMN person_id        uuid UNIQUE REFERENCES person,
  ADD COLUMN grant_id         uuid UNIQUE REFERENCES oauth_grant,
  ADD COLUMN created_by       uuid REFERENCES person,
  ADD COLUMN created_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoked_at       timestamptz,
  ADD COLUMN weekly_cap_cents int NOT NULL DEFAULT 0 CHECK (weekly_cap_cents >= 0),
  ADD COLUMN last_used_at     timestamptz,
  ADD COLUMN token_last4      text,
  -- A new token, sealed (sealed.ts), from the change that made it until it's shown once to whoever made it; then cleared.
  ADD COLUMN token_once       text,
  ADD COLUMN token_once_at    timestamptz;
ALTER TABLE agent ADD CONSTRAINT agent_club_complete CHECK (kind <> 'club' OR (name IS NOT NULL AND person_id IS NOT NULL AND capped_role_id IS NOT NULL));

ALTER TABLE person DROP CONSTRAINT person_created_via_check;
ALTER TABLE person ADD CONSTRAINT person_created_via_check CHECK (created_via IN ('signup', 'import', 'desk', 'setup', 'household', 'support', 'agent'));

-- Club agents connect as one shared client of the door.
ALTER TABLE oauth_client DROP CONSTRAINT oauth_client_kind_check;
ALTER TABLE oauth_client ADD CONSTRAINT oauth_client_kind_check CHECK (kind IN ('registered', 'published', 'agent'));
INSERT INTO oauth_client (client_id, kind, name, redirect_uris) VALUES ('openpadel-agent', 'agent', 'Club agent', '{}') ON CONFLICT DO NOTHING;

-- Signed event webhooks: an agent (or the owner) names an https address and the events it wants. Each event that
-- leaves the outbox after its change commits is copied to a delivery for each subscription that wants it and whose
-- reader (the agent, or the person who subscribed) could read that part of the club, then POSTed with an HMAC-SHA256
-- signature under the subscription's own secret (sealed here; its last four characters shown), retried with waits that
-- double. An address that keeps failing is paused and the owner hears once.
CREATE TABLE webhook_subscription (
  id             uuid PRIMARY KEY,
  url            text NOT NULL,
  topics         text[] NOT NULL CHECK (cardinality(topics) > 0),
  -- Whose reads decide what it gets: the agent's own person, or the person who subscribed.
  person_id      uuid NOT NULL REFERENCES person,
  agent_id       uuid REFERENCES agent,
  secret_sealed  text NOT NULL,
  secret_last4   text NOT NULL,
  created_by     uuid REFERENCES person,
  created_at     timestamptz NOT NULL DEFAULT now(),
  active         boolean NOT NULL DEFAULT true,
  paused_at      timestamptz,
  paused_why     text,
  failures       int NOT NULL DEFAULT 0,   -- attempts in a row that failed
  failing_since  timestamptz,
  last_ok_at     timestamptz,
  last_error     text,
  version        int NOT NULL DEFAULT 1
);
CREATE INDEX webhook_subscription_live ON webhook_subscription (id) WHERE active AND paused_at IS NULL;

CREATE TABLE webhook_delivery (
  id              bigserial PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES webhook_subscription,
  event_id        bigint REFERENCES event_outbox,   -- null for a test event
  topic           text NOT NULL,
  body            text NOT NULL,                    -- the exact JSON sent, the same bytes on every try
  status          text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'failed', 'dropped')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status     int,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX webhook_delivery_waiting ON webhook_delivery (next_attempt_at) WHERE status = 'waiting';

-- How far through the outbox the copying has got (the highest event id looked at).
CREATE TABLE webhook_cursor (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_event_id bigint NOT NULL
);
INSERT INTO webhook_cursor (last_event_id) SELECT coalesce(max(id), 0) FROM event_outbox;

-- Making, changing and taking back a club agent, and webhooks: the owner (through '*'); a manager asks.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000012601', '00000000-0000-7000-8000-000000000002', 'agent.*', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000012602', '00000000-0000-7000-8000-000000000002', 'webhook.*', 'ask', 'any');
