-- What a big club (two years, 90,000 court bookings, 3,000 members) showed was missing: reads and checks that went
-- through a whole table, and slowed as the club grew.

-- The check that each ledger transaction balances (006) runs once per entry written and summed the whole ledger to
-- find the transaction's entries: 14 ms an entry at 160,000 entries, more every day, inside every money change.
-- Reports join entries to their transaction the same way.
CREATE INDEX IF NOT EXISTS ledger_entry_txn ON ledger_entry (txn_id);
-- Reports read the books by day.
CREATE INDEX IF NOT EXISTS ledger_txn_at ON ledger_txn (at);

-- A member's own bookings: how many they have coming up and what they owe (asked on every booking and sign-up),
-- their page, their download, their chats.
CREATE INDEX IF NOT EXISTS booking_organiser ON booking (organiser_id) WHERE organiser_id IS NOT NULL;

-- The outbox worker picks the next event for a topic it handles. Events for topics nothing handles stay undelivered
-- for good (outbox.ts), and the worker stepped over every one of them for each event it picked: 55 ms an event at
-- 130,000 of them, and a second a run with nothing to send.
CREATE INDEX IF NOT EXISTS event_outbox_waiting_topic ON event_outbox (topic, id) WHERE delivered_at IS NULL AND held_at IS NULL;

-- The desk's day reads the changes that took money at the desk (DESK_MONEY, permissions.ts). 076's index was made
-- for the five there were then; with gift cards and passes sold at the desk it no longer matched, and the desk's day
-- read every change the club ever made. This one has all seven, and a test keeps it matching DESK_MONEY.
CREATE INDEX IF NOT EXISTS action_run_desk_money ON action_run (applied_at)
  WHERE action IN ('booking.record_payment', 'enrolment.record_payment', 'membership.sell', 'membership.record_payment', 'refund.give_back', 'gift_card.sell', 'pass.sell');
DROP INDEX IF EXISTS action_run_desk;

-- What's left of a payment (refunds against it) and what a place has had taken off: asked inside money changes.
CREATE INDEX IF NOT EXISTS refund_payment ON refund (payment_id);
CREATE INDEX IF NOT EXISTS payment_enrolment ON payment (enrolment_id) WHERE enrolment_id IS NOT NULL;

-- After a restore, each payment and refund the provider lists is looked up by the provider's id for it (with or without
-- Kumi's own id): 13 ms a payment through the whole table, 16 s for a week of a big club's card payments.
CREATE INDEX IF NOT EXISTS payment_ref_lookup ON payment (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS refund_provider_ref ON refund (provider_ref) WHERE provider_ref IS NOT NULL;

-- Reports' tax collected reads receipts by day.
CREATE INDEX IF NOT EXISTS receipt_paid_at ON receipt (paid_at);
