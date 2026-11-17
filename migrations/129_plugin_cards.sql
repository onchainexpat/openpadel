-- Plugin cards (docs/plugins/README.md, "Cards"): what a plugin shows in the core apps' slots, as data the apps render
-- with their own components. The manifest declares a card's slot and title; what it says comes from the plugin at run
-- time through the door (plugin.card_put, plugin.card_clear), one card per plugin, slot and subject:
--   court_tile      a court's tile on Today (subject: the court)
--   game            a game's page, in the members' app and for staff (subject: the booking, or the game)
--   member_profile  a member's profile, theirs and staff's (subject: the person)
--   money           the Money page (no subject)
--   connectors      the Connectors page (no subject)
-- Putting a card again replaces it; clearing it keeps the row (cleared_at) for the change log and undo. A paused or
-- removed plugin's cards aren't shown.
CREATE TABLE plugin_card (
  id          uuid PRIMARY KEY,
  plugin_id   uuid NOT NULL REFERENCES plugin,
  slot        text NOT NULL CHECK (slot IN ('game', 'court_tile', 'member_profile', 'money', 'connectors')),
  subject     uuid,
  tone        text NOT NULL DEFAULT 'ok' CHECK (tone IN ('ok', 'warn', 'off')),
  -- Up to six rows of { label: {en, es}, text: {en, es} }, and an optional { url, label: {en, es} } (https only).
  rows        jsonb NOT NULL DEFAULT '[]',
  link        jsonb,
  put_at      timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  version     int NOT NULL DEFAULT 1,
  CHECK ((slot IN ('money', 'connectors')) = (subject IS NULL))
);
CREATE UNIQUE INDEX plugin_card_one ON plugin_card (plugin_id, slot, coalesce(subject, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX plugin_card_shown ON plugin_card (slot, subject) WHERE cleared_at IS NULL;
