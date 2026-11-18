-- WhatsApp as a message channel, sent by a plugin (packages/core/src/whatsapp.ts, plugins/whatsapp). The server still
-- decides who gets what: a member's yes (channel_consent, 'whatsapp'), quiet hours and STOP are checked here before
-- every send, and the plugin is handed only the number, the template and its words, signed, through the plugin's own
-- webhook (webhook_delivery, topic 'message.send').
--
-- A member links their WhatsApp number by sending the club's WhatsApp number a code the app shows them: that proves the
-- number is theirs, works in any country, and opens WhatsApp's 24-hour window for the club's answer.
CREATE TABLE whatsapp_number (
  person_id  uuid PRIMARY KEY REFERENCES person,
  phone      text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  linked_at  timestamptz NOT NULL DEFAULT now()
);

-- The code a member sends to link their number: one at a time, for an hour.
CREATE TABLE whatsapp_link_code (
  person_id  uuid PRIMARY KEY REFERENCES person,
  code       text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{6}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Messages that came in on a plugin's channel, by the service's own id: one that comes again (the service retries) is
-- handled once.
CREATE TABLE channel_inbound (
  ref        text PRIMARY KEY CHECK (length(ref) BETWEEN 1 AND 200),
  plugin_id  uuid NOT NULL REFERENCES plugin,
  from_hash  text NOT NULL,          -- the sender's number, hashed: enough to count a number's tries at a code
  outcome    text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX channel_inbound_from ON channel_inbound (from_hash, at);

-- A message's report from the plugin: read on the person's phone.
ALTER TABLE outbound_message ADD COLUMN seen_at timestamptz;

-- Members say yes or no to WhatsApp for themselves, like texts.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000013201', '00000000-0000-7000-8000-000000000006', 'consent.whatsapp', 'allow', 'own');
