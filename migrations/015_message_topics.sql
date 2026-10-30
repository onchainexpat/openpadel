-- When Kumi started telling people about each kind of event. A release that adds a kind of message
-- mustn't send it for events from before the update (a "Paid" for yesterday's payment): those are
-- skipped. Each topic is written when a server that knows it first starts.
CREATE TABLE message_topic (
  topic text PRIMARY KEY,
  since timestamptz NOT NULL DEFAULT now()
);
