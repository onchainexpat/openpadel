-- A message's in-app copy in the club's other language too (English and Spanish), written when it's sent, so the inbox
-- and Today's alerts read in whichever language the reader has when they're shown (messages.ts messageInLang). Only the inbox
-- copy keeps it: an email, a push or a text went out in one language and stays as it went.
ALTER TABLE outbound_message ADD COLUMN alt_subject text;
ALTER TABLE outbound_message ADD COLUMN alt_body text;
