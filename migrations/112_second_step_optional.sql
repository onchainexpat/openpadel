-- A second step at sign-in is the club's choice (Settings, "Sign-in and roles"), off unless the owner turns it on.
--
-- Off: staff sign in with the emailed (or texted) code alone. Whoever has set up a passkey or an authenticator still
-- gives it at sign-in, the club's most sensitive changes (strongAuth: settings, roles, the payments account, the
-- vault, a club export...) still ask for one from the roles club.two_factor names, and an assistant connected
-- without one still works as a member's (assistant_reach.ts). On: those roles give it at every sign-in, as before.
-- Every club starts off, the clubs already running too (CHANGELOG, "When updating").
ALTER TABLE club ADD COLUMN IF NOT EXISTS second_step_sign_in boolean NOT NULL DEFAULT false;
