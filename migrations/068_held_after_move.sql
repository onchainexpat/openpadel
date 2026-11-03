-- A club's export carries what was still waiting to go out when it was made: events not yet handled and
-- messages not yet sent. The old server, which may still be running, sends those itself. So when the export is
-- restored on another server, they're held there instead of sent a second time, until whoever runs it says
-- (`kumi held send` once the old server never got to them, `kumi held drop` once it did). Refunds aren't held:
-- the refund handler asks the card provider first, so one the old server already sent is recorded, not repeated.
ALTER TABLE event_outbox ADD COLUMN held_at timestamptz;
ALTER TABLE outbound_message DROP CONSTRAINT outbound_message_status_check;
ALTER TABLE outbound_message ADD CONSTRAINT outbound_message_status_check CHECK (status IN ('waiting', 'sent', 'failed', 'dropped', 'held'));
CREATE INDEX outbound_message_held ON outbound_message (created_at) WHERE status = 'held';
