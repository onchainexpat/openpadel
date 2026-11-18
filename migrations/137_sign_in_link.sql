-- An owner's one-time sign-in link, made on the server by `openpadel sign-in-link` (auth.ts): for the first sign-in on a
-- new server with no email service yet, so nobody reads a code out of the server's log and passes it on. It works once,
-- for 15 minutes, and only while there's no email service. Its token is kept as a hash, like a code.
ALTER TABLE auth_challenge DROP CONSTRAINT auth_challenge_kind_check;
ALTER TABLE auth_challenge ADD CONSTRAINT auth_challenge_kind_check
  CHECK (kind IN ('email_code', 'phone_code', 'passkey_add', 'passkey_sign_in', 'sign_up', 'totp_setup', 'phone_sign_in', 'email_add', 'email_undo', 'sign_in_link'));
