-- After a restore, the last round (payments_after_restore.ts). A payment the provider has from after the copy that
-- Kumi made by itself (a renewal, a weekly week, an unpaid share, a family card charge: they carry kumi_charge_id) is
-- one the jobs make again by its key and then record; so it waits for the jobs to run before it's counted as paid with
-- nothing here, and is recorded (closed) once a payment row for it appears. A refund the provider made since the copy
-- is marked as seen after a restore: the cancellation it went with may be one this copy doesn't have, so a later
-- cancel by the club's rule gives nothing more back for it (the staff are told and decide).
ALTER TABLE payment_found ADD COLUMN kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'kumi_charge'));
ALTER TABLE payment_found DROP CONSTRAINT payment_found_status_check;
ALTER TABLE payment_found ADD CONSTRAINT payment_found_status_check CHECK (status IN ('waiting', 'open', 'refund_asked', 'refunded', 'handled', 'refund_failed', 'recorded'));
ALTER TABLE refund ADD COLUMN seen_after_restore boolean NOT NULL DEFAULT false;
