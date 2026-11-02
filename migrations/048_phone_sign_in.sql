-- Signing in or joining by a code texted to a US or Canadian number (auth.ts), and adding an email address
-- to an account that joined by phone.
--
-- A phone sign-in code is its own kind of challenge (a number's codes, for sign-in and for confirming a number
-- on the profile, count together toward the limits on what a number and the club can be sent in an hour).
-- An email added to an account is confirmed by a code too ('email_add'). A session started by a texted code
-- says so ('phone_code'): like an emailed code, it's one step, so the 2-step rules for staff still apply.
ALTER TABLE auth_challenge DROP CONSTRAINT auth_challenge_kind_check;
ALTER TABLE auth_challenge ADD CONSTRAINT auth_challenge_kind_check
  CHECK (kind IN ('email_code', 'phone_code', 'passkey_add', 'passkey_sign_in', 'sign_up', 'totp_setup', 'phone_sign_in', 'email_add'));

ALTER TABLE web_session DROP CONSTRAINT web_session_method_check;
ALTER TABLE web_session ADD CONSTRAINT web_session_method_check CHECK (method IN ('email_code', 'passkey', 'phone_code'));
