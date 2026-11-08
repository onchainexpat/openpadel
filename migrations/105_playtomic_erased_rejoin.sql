-- The marker of people deleted here (102), grouped by the person it was made for, and lifted when they come back: an
-- account made again with the same address (a sign-up, the desk, an import), or a live member linked to the same
-- Playtomic id. A rejoin starts fresh from its own date: what Playtomic holds from before it stays out, what's theirs
-- after comes in (playtomic_erased.ts). Kept as a salted one-way hash (club.erase_salt), so the trigger can match an
-- address without the server's key, and a change of that key (kumi rotate-key) doesn't let anyone back in.
ALTER TABLE playtomic_erased ADD COLUMN erased_person_id uuid;
ALTER TABLE playtomic_erased ADD COLUMN rejoined_at timestamptz;
UPDATE playtomic_erased e SET erased_person_id = p.person_id
  FROM (SELECT DISTINCT ON (participant_id) participant_id, person_id FROM playtomic_booking_player WHERE erased_at IS NOT NULL AND person_id IS NOT NULL ORDER BY participant_id, erased_at) p
  WHERE e.playtomic_id = p.participant_id AND e.erased_person_id IS NULL;
CREATE INDEX playtomic_erased_person ON playtomic_erased (erased_person_id) WHERE erased_person_id IS NOT NULL;

CREATE FUNCTION playtomic_rejoined() RETURNS trigger AS $$
DECLARE s text; h text;
BEGIN
  IF TG_TABLE_NAME = 'person' THEN
    IF NEW.email IS NULL OR NEW.redacted_at IS NOT NULL THEN RETURN NEW; END IF;
    SELECT erase_salt INTO s FROM club LIMIT 1;
    IF s IS NULL THEN RETURN NEW; END IF;
    h := encode(sha256(convert_to(s || ':' || lower(btrim(NEW.email)), 'UTF8')), 'hex');
    UPDATE playtomic_erased SET rejoined_at = now()
      WHERE rejoined_at IS NULL AND (email_hash = h OR erased_person_id IN (SELECT erased_person_id FROM playtomic_erased WHERE email_hash = h AND erased_person_id IS NOT NULL));
  ELSE
    IF NEW.system <> 'playtomic' OR NEW.entity <> 'person' THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM person WHERE id::text = NEW.entity_id AND redacted_at IS NULL) THEN RETURN NEW; END IF;
    UPDATE playtomic_erased SET rejoined_at = now()
      WHERE rejoined_at IS NULL AND (playtomic_id = NEW.external_id OR erased_person_id IN (SELECT erased_person_id FROM playtomic_erased WHERE playtomic_id = NEW.external_id AND erased_person_id IS NOT NULL));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER person_playtomic_rejoined AFTER INSERT OR UPDATE OF email ON person FOR EACH ROW EXECUTE FUNCTION playtomic_rejoined();
CREATE TRIGGER external_ref_playtomic_rejoined AFTER INSERT ON external_ref FOR EACH ROW EXECUTE FUNCTION playtomic_rejoined();
