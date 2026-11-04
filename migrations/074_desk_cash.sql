-- Paid at the desk for a membership or a program place, as for a court booking (cash, the club's own card reader,
-- or another way). What goes back of money paid at the desk goes back at the desk, never to a card: a refund of it
-- waits there ('desk', pending) until someone at the desk hands it over (sent).
ALTER TABLE refund DROP CONSTRAINT refund_destination_check;
ALTER TABLE refund ADD CONSTRAINT refund_destination_check CHECK (destination IN ('card', 'credit', 'desk'));
CREATE INDEX refund_at_desk ON refund (payment_id) WHERE destination = 'desk' AND status = 'pending';

-- A membership sold at the desk covers one period and doesn't renew by itself. What's still owed on its current
-- period (part paid now, the rest later, at the desk), and the period end its member was reminded of.
ALTER TABLE membership ADD COLUMN balance_cents int NOT NULL DEFAULT 0 CHECK (balance_cents >= 0);
ALTER TABLE membership ADD COLUMN end_reminded_for timestamptz;

-- The front desk takes money at the desk and hands back what's owed there; managers and owners already can.
-- A member pays the next period of their own, by card in the app, when the plan is one they could join there.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000744', '00000000-0000-7000-8000-000000000006', 'membership.pay_next', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000740', '00000000-0000-7000-8000-000000000003', 'membership.sell', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000741', '00000000-0000-7000-8000-000000000003', 'membership.record_payment', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000742', '00000000-0000-7000-8000-000000000003', 'enrolment.record_payment', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000743', '00000000-0000-7000-8000-000000000003', 'refund.give_back', 'allow', 'any');
