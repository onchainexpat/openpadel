-- Ask openPadel, the hosted assistant (apps/server/src/assistant.ts, packages/core/src/assistant_chats.ts).
--
-- Its cost counts on the club's monthly meter as its own kind, under the owner's cap (usage.ts).
ALTER TABLE usage_month DROP CONSTRAINT usage_month_kind_check;
ALTER TABLE usage_month ADD CONSTRAINT usage_month_kind_check CHECK (kind IN ('ai_decisions', 'ai_drafts', 'ai_assistant', 'texts', 'email'));

-- Each person's conversations with it, kept 30 days after their last turn, deletable by the person
-- (assistant.chat_delete), and in their data export. A turn is written as it happens, like a game chat's message: it
-- changes nothing at the club. `content` is the message as the model sent or read it; `shown` what the app shows of
-- it (the words, and the previews it made), null for the tool results the person never sees.
CREATE TABLE assistant_chat (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,
  surface     text NOT NULL CHECK (surface IN ('staff', 'member')),
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_chat_person ON assistant_chat (person_id, updated_at DESC);
CREATE INDEX assistant_chat_updated ON assistant_chat (updated_at);

CREATE TABLE assistant_message (
  id          uuid PRIMARY KEY,
  chat_id     uuid NOT NULL REFERENCES assistant_chat ON DELETE CASCADE,
  seq         int NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     jsonb NOT NULL,
  shown       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, seq)
);

-- The built-in client the hosted assistant's connections belong to: one oauth_grant per person, so it is listed under
-- Profile, Assistants with its weekly limit and Disconnect, like an assistant they connect themselves. It has no
-- address to send anyone back to and no secret: the OAuth pages and the token endpoint refuse it (oauth.ts).
INSERT INTO oauth_client (client_id, kind, name, redirect_uris, auth_method)
  VALUES ('openpadel-hosted', 'registered', 'Ask openPadel', '{}', 'none') ON CONFLICT (client_id) DO NOTHING;

-- Deleting your own conversations: members have it through 'assistant.*' (053), owners and managers through '*'; the
-- desk, coaches and the accountant here. Only ever your own: the action finds nobody else's.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000012701', '00000000-0000-7000-8000-000000000003', 'assistant.chat_delete', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000012702', '00000000-0000-7000-8000-000000000004', 'assistant.chat_delete', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000012703', '00000000-0000-7000-8000-000000000005', 'assistant.chat_delete', 'allow', 'own');
