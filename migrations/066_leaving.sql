-- Leaving (leaving.ts): the day this club's Kumi ends, set by whoever runs its server (`kumi leaving on`): a club
-- moving off its host, or a club shutting its own server down. The owner is told at once, and again a week and a
-- day before, each said once for that date, to download everything before then.
ALTER TABLE club ADD COLUMN leaving_on date, ADD COLUMN leaving_kept_days integer CHECK (leaving_kept_days >= 0);

-- Which notices went for which date. "covered": not sent, because an earlier one already said it (the date was set
-- less than a week ahead, or the server was off when the week's one was due).
CREATE TABLE leaving_notice (
  leaving_on date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('set', 'week', 'day')),
  said_at timestamptz NOT NULL,
  covered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (leaving_on, kind)
);
