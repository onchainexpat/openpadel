-- A membership counts its periods: one more each time a period is added (paid for, by card or at the desk), and
-- never by a pause, which moves the dates only. A card payment asked for the next period keeps the count it was
-- asked at, so a period paid another way meanwhile is told apart from a pause or its end moving the dates. This
-- replaces the period end the payment kept (075), which a pause moved from under it.
ALTER TABLE membership ADD COLUMN period_no int NOT NULL DEFAULT 1;
ALTER TABLE payment ADD COLUMN for_period_no int;
-- A card payment already asked for a period keeps the count it was asked at: the current one, unless that period
-- was paid another way since (the period end moved on, and another payment for the membership went through after
-- it was asked); a pause alone moved the end without paying anything, so it's still the current period.
UPDATE payment SET for_period_no = CASE WHEN payment.for_period_end <> m.current_period_end AND EXISTS (SELECT 1 FROM payment q
    WHERE q.membership_id = m.id AND q.status = 'succeeded' AND q.id <> payment.id AND q.created_at > payment.created_at)
  THEN m.period_no - 1 ELSE m.period_no END
  FROM membership m WHERE m.id = payment.membership_id AND payment.for_period_end IS NOT NULL;
ALTER TABLE payment DROP COLUMN for_period_end;

-- The desk's day (Reports) reads the changes that took money at the desk or handed it back there, by when they were
-- made: an index on just those. The one on payment.created_at (075) couldn't serve it.
CREATE INDEX action_run_desk ON action_run (applied_at)
  WHERE action IN ('booking.record_payment', 'enrolment.record_payment', 'membership.sell', 'membership.record_payment', 'refund.give_back');
DROP INDEX payment_at_desk;
