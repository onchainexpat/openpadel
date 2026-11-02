-- When the member last opened their question in the app (questions.ts, messages.ts): an automatic answer they
-- saw there isn't emailed to them as well.
ALTER TABLE question ADD COLUMN member_seen_at timestamptz;
