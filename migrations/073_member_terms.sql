-- The club's own terms and privacy policy for members (docs/templates), on its own website: the member app links them
-- where someone joins, beside the yes to texts and on the profile, the public pages link them, and the texting
-- registration gives them to Twilio. Set in Settings (or club.yaml); without them, nothing is shown or asked.
ALTER TABLE club ADD COLUMN terms_url text;
ALTER TABLE club ADD COLUMN privacy_policy_url text;

-- What someone agreed to when they joined: the links the sign-up page showed them, in which language, and when.
-- Kept when an account is deleted, like the answers to texts and the waiver.
CREATE TABLE policy_acceptance (
  id                 uuid PRIMARY KEY,
  person_id          uuid NOT NULL REFERENCES person,
  terms_url          text,
  privacy_policy_url text,
  lang               text NOT NULL CHECK (lang IN ('en', 'es')),
  source             text NOT NULL CHECK (source IN ('sign_up')),
  accepted_at        timestamptz NOT NULL,
  CHECK (terms_url IS NOT NULL OR privacy_policy_url IS NOT NULL)
);
CREATE INDEX policy_acceptance_person ON policy_acceptance (person_id, accepted_at);
