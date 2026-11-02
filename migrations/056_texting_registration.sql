-- The club's texting registration with US carriers, made through its own Twilio account by `kumi texting`
-- (texting_registration.ts in core, the steps in the server's texting.ts): toll-free first. One row: the number,
-- the Messaging Service it's in, and the toll-free verification sent for it, with where the review stands. Once
-- Twilio approves, texts go from that Messaging Service unless the settings file names a sender of its own.
CREATE TABLE texting_registration (
  id                    uuid PRIMARY KEY,
  kind                  text NOT NULL DEFAULT 'tollfree' CHECK (kind IN ('tollfree')),
  phone_number          text,                             -- E.164
  phone_number_sid      text,                             -- Twilio's PN...
  bought                boolean NOT NULL DEFAULT false,   -- Kumi bought it (rather than using the club's own)
  messaging_service_sid text,                             -- MG...
  verification_sid      text,                             -- HH...
  status                text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'submitted', 'in_review', 'approved', 'rejected')),
  twilio_status         text,                             -- as Twilio says it (PENDING_REVIEW, IN_REVIEW, TWILIO_APPROVED, TWILIO_REJECTED)
  rejection             jsonb,                            -- Twilio's reasons and codes, as given
  edit_allowed          boolean,
  edit_expires_at       timestamptz,
  submitted             jsonb,                            -- what was sent for review (no keys, nothing secret)
  submitted_at          timestamptz,
  checked_at            timestamptz,
  told_status           text,                             -- the last decision the owner and managers heard (said once)
  created_at            timestamptz NOT NULL DEFAULT now(),
  version               int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX texting_registration_one ON texting_registration ((true));
