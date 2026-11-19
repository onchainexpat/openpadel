-- A session that owes a second step whatever the club's rules say (auth.ts): one started by an owner's one-time
-- sign-in link (`openpadel sign-in-link`), which an agent handed over. Until the person sets up a passkey or an
-- authenticator (or gives the one they have), only the second step's own pages answer. Giving it marks the session
-- two-step (second_factor) or replaces it with a passkey session, as for an emailed code.
ALTER TABLE web_session ADD COLUMN second_step_owed boolean NOT NULL DEFAULT false;
