-- A found card payment kept as paid elsewhere, the review (6 Nov 2026). The staff say how it's kept (kept_as): counted as
-- income (it's added to the books), or already in the books (put right by hand with a payment Kumi records, a court
-- paid at the desk for it, say: nothing is added, so the same money never counts twice). A kept one is asked of the
-- provider again now and then (checked_at, a few at a time) for refunds made since (in its dashboard, say) and for a
-- dispute (disputed_at: the staff are told once). A refund of it comes out of the books only once it has gone
-- through (status succeeded; out_cents is what came out for it): one still pending is looked at again, and one that
-- failed takes nothing out.
ALTER TABLE payment_found ADD COLUMN kept_as text CHECK (kept_as IN ('income', 'already'));
ALTER TABLE payment_found ADD COLUMN checked_at timestamptz;
ALTER TABLE payment_found ADD COLUMN disputed_at timestamptz;
UPDATE payment_found SET kept_as = CASE WHEN booked_cents > 0 THEN 'income' ELSE 'already' END WHERE status = 'handled';
ALTER TABLE payment_found_refund ADD COLUMN status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed'));
ALTER TABLE payment_found_refund ADD COLUMN out_cents int NOT NULL DEFAULT 0 CHECK (out_cents >= 0);
