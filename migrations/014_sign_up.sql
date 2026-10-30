-- Members sign themselves up. The club can close it (then only staff add people). A verified email
-- gets a short-lived sign-up ticket; the name and the email-consent answer come with the sign-up.
ALTER TABLE club ADD COLUMN IF NOT EXISTS sign_up_open boolean NOT NULL DEFAULT true;
ALTER TABLE auth_challenge DROP CONSTRAINT auth_challenge_kind_check;
ALTER TABLE auth_challenge ADD CONSTRAINT auth_challenge_kind_check CHECK (kind IN ('email_code', 'phone_code', 'passkey_add', 'passkey_sign_in', 'sign_up'));
