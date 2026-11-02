-- Texting (SMS) through the club's own Twilio account (texts.ts).
--
-- A text's row in outbound_message keeps Twilio's id for it (provider_ref), so the delivery reports Twilio
-- sends back find it, and when it reached the phone. A member says yes to texts in the app, after confirming
-- their number with a code; that yes is a channel_consent row ('sms', 'account') with the wording's version and
-- what they said yes on. A kid with a login of their own can only say yes once their parents have switched
-- texts on for them (kid_rule.texts, off to start).
ALTER TABLE outbound_message ADD COLUMN provider_ref text;
ALTER TABLE outbound_message ADD COLUMN delivered_at timestamptz;
CREATE UNIQUE INDEX outbound_message_provider_ref ON outbound_message (provider_ref) WHERE provider_ref IS NOT NULL;

ALTER TABLE kid_rule ADD COLUMN texts boolean NOT NULL DEFAULT false;

-- The latest answer for a person, channel and purpose is the one that counts (consent is append-only).
CREATE INDEX IF NOT EXISTS channel_consent_latest ON channel_consent (person_id, channel, purpose, at DESC);

-- Members say yes or no to texts for themselves.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000302', '00000000-0000-7000-8000-000000000006', 'consent.texts', 'allow', 'own');
