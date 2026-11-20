-- Getting started (getting_started.ts): the checklist on a new club's Today, until the owner or a manager puts it away
-- (getting_started.hide), which only works once every required step is done. When it was put away; empty while it shows.
ALTER TABLE club ADD COLUMN getting_started_hidden_at timestamptz;
