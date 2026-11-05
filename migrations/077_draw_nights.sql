-- Mexicano and King of the Court nights (games.ts, formats.ts): each round is made from the one before, so the
-- draw keeps who sat out each round (Mexicano credits a round sat out with half a game's points), and King of the
-- Court plays timed rounds.
ALTER TABLE draw ADD COLUMN round_minutes int CHECK (round_minutes > 0);
ALTER TABLE draw ADD COLUMN sat_out jsonb NOT NULL DEFAULT '{}';
