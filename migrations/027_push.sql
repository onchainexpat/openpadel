-- Push notifications. Each phone or browser that turns them on is a subscription (for the members' app or the
-- staff app); every in-app message gets a push copy for that person's devices, quiet hours and consent
-- applying as for email. The club's key pair signs every push (it signs only; it lives with the rest of the
-- database, backups included, and is made the first time it's needed).
CREATE TABLE push_subscription (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES person,
  app         text NOT NULL CHECK (app IN ('member', 'staff')),
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX push_subscription_person ON push_subscription (person_id) WHERE revoked_at IS NULL;

CREATE TABLE push_key (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  public_key  text NOT NULL,
  private_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
