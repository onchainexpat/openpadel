-- People whose account here was deleted, as Playtomic knows them: so no later read of Playtomic (its bookings, three
-- months back included, or its players) brings their name, email or phone back in (playtomic_erased.ts). Their
-- Playtomic id, when known, and a one-way hash of each email address, salted with the club's own random value, never
-- the address itself.
CREATE TABLE playtomic_erased (
  id           uuid PRIMARY KEY,
  playtomic_id text,
  email_hash   text,
  erased_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (playtomic_id IS NOT NULL OR email_hash IS NOT NULL)
);
CREATE UNIQUE INDEX playtomic_erased_id ON playtomic_erased (playtomic_id) WHERE playtomic_id IS NOT NULL;
CREATE UNIQUE INDEX playtomic_erased_email ON playtomic_erased (email_hash) WHERE email_hash IS NOT NULL;
ALTER TABLE club ADD COLUMN erase_salt text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text);

-- Those already erased from the archive (migration 100) keep being kept out.
INSERT INTO playtomic_erased (id, playtomic_id, erased_at)
  SELECT gen_random_uuid(), participant_id, min(erased_at) FROM playtomic_booking_player
  WHERE erased_at IS NOT NULL AND family_member_id IS NULL GROUP BY participant_id
  ON CONFLICT DO NOTHING;
