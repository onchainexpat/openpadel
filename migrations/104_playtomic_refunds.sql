-- What's handed back in Playtomic of a booking taken over from it (playtomic_archive.ts): kept as a refund of its own
-- kind, 'sent' as soon as it's said (the managers give it back there), so a later change to the same booking counts
-- what's left of it. Nothing is sent from Kumi, and nothing enters its books.
ALTER TABLE refund DROP CONSTRAINT refund_destination_check;
ALTER TABLE refund ADD CONSTRAINT refund_destination_check CHECK (destination IN ('card', 'credit', 'desk', 'pass', 'playtomic'));
