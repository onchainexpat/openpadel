-- After a restore, the jobs make again some of what the database before it had already sent: a reminder, a notice
-- or club news whose "already said" record (booking.reminded_at, a leaving_notice row, a broadcast's sent_at) was
-- written after the copy was made, so the copy doesn't have it. Those messages are new rows, so carrying over the
-- old rows' answers (after_restore.ts) can't see them. So the restore also keeps here a fingerprint of each email,
-- text and push the database before it had sent that the copy doesn't have: the person, the kind, the channel and
-- the exact words and link. For a week after the restore, a waiting message with the same fingerprint takes the
-- earlier one's answer (sent, at its time) instead of going again, once per fingerprint. The in-app inbox isn't
-- counted: its copy is the app's record, and the restored copy lost it.
CREATE TABLE sent_before_restore (
  id          bigserial PRIMARY KEY,
  fp          text NOT NULL,                 -- sha256 of person, kind, channel, subject, body and link
  message_id  uuid NOT NULL,                 -- the message the database before the restore had sent
  sent_at     timestamptz NOT NULL,
  restored_at timestamptz NOT NULL,
  until       timestamptz NOT NULL,          -- a week after the restore: later, the same words go as new
  used_at     timestamptz,
  used_by     uuid                           -- the message made again, which took this answer instead of going
);
CREATE INDEX sent_before_restore_open ON sent_before_restore (fp) WHERE used_at IS NULL;
