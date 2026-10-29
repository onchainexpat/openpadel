-- What Kumi tells people (messages.md). Each event becomes messages after its change commits: one row
-- per person, message and channel. The in-app inbox copy is there at once; the email copy waits for
-- the sender job, outside quiet hours unless it's essential. A row keeps the exact words sent and the
-- event that caused it, so any message can be traced.
CREATE TABLE outbound_message (
  id          uuid PRIMARY KEY,
  event_id    bigint REFERENCES event_outbox,
  person_id   uuid NOT NULL REFERENCES person,
  kind        text NOT NULL,                       -- waitlist.offered, enrolment.removed...
  channel     text NOT NULL CHECK (channel IN ('inbox', 'email', 'push', 'sms', 'whatsapp')),
  purpose     text NOT NULL CHECK (purpose IN ('account', 'invites', 'club_news', 'staff')),
  essential   boolean NOT NULL,
  lang        text NOT NULL CHECK (lang IN ('en', 'es')),
  subject     text NOT NULL,
  body        text NOT NULL,
  link        text,                                -- where in the app it points, e.g. /places
  -- waiting: for the sender. sent: delivered (the inbox copy is sent when written). failed: gave up.
  -- dropped: stale before it could go, like a place offer that ran out during quiet hours.
  status      text NOT NULL CHECK (status IN ('waiting', 'sent', 'failed', 'dropped')),
  send_after  timestamptz NOT NULL,
  stale_at    timestamptz,
  attempts    int NOT NULL DEFAULT 0,
  failure     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  read_at     timestamptz,
  UNIQUE (event_id, person_id, kind, channel)
);
CREATE INDEX outbound_message_waiting ON outbound_message (send_after) WHERE status = 'waiting';
CREATE INDEX outbound_message_inbox ON outbound_message (person_id, created_at DESC) WHERE channel = 'inbox';
