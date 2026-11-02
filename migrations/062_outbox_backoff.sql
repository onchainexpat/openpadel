-- Money events (a refund on its way to the card provider) wait longer between tries instead of stopping after
-- eight: 30 seconds, doubling to an hour (outbox.ts). Until then an event can be tried again at once.
ALTER TABLE event_outbox ADD COLUMN next_attempt_at timestamptz;
