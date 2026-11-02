-- A member changes their own email (auth.ts): a code to the new address, as adding one does ('email_add'),
-- then the old address is told, with a link that puts it back and signs everyone out ('email_undo', kept as
-- a hash of the link's key, good for 14 days and once).
ALTER TABLE auth_challenge DROP CONSTRAINT auth_challenge_kind_check;
ALTER TABLE auth_challenge ADD CONSTRAINT auth_challenge_kind_check
  CHECK (kind IN ('email_code', 'phone_code', 'passkey_add', 'passkey_sign_in', 'sign_up', 'totp_setup', 'phone_sign_in', 'email_add', 'email_undo'));
