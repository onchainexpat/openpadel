-- A player's own assistant (the MCP door, oauth.ts) spends within the weekly cap they set for it when they
-- connect it, and can change in the app: the grant's weekly_cap_cents (from 003), $0 until they choose more
-- (assistant_spend.ts). Each change an assistant makes remembers which connection made it, so what it spent
-- this week can be added up. A person changes the cap or disconnects it with actions of their own.
ALTER TABLE oauth_grant ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE action_run ADD COLUMN oauth_grant_id uuid REFERENCES oauth_grant;
CREATE INDEX action_run_oauth_grant ON action_run (oauth_grant_id, applied_at) WHERE oauth_grant_id IS NOT NULL;

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000420', '00000000-0000-7000-8000-000000000006', 'assistant.*', 'allow', 'own');
