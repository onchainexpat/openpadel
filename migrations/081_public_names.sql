-- A tournament or league's public page names its players only when the club turns it on for that program
-- (competitions.ts, public.ts). Juniors are never named there.
ALTER TABLE program ADD COLUMN public_names boolean NOT NULL DEFAULT false;
