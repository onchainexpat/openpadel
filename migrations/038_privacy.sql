-- A member's copy of their data, and deleting an account (packages/core/src/privacy.ts). Deleting is a
-- redaction: the person stays as a row named "Former member" with no way to reach or recognise them, and
-- payments, the ledger and game results stay. Nothing new to store: both are action runs in Changes.
--
-- Everyone exports and deletes their own (a parent their juniors', as the rows' owners); for anyone else, a
-- manager asks the owner, and the owner may (the '*' grant). Front desk and coaches can't, for others.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000160', '00000000-0000-7000-8000-000000000006', 'privacy.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000161', '00000000-0000-7000-8000-000000000003', 'privacy.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000162', '00000000-0000-7000-8000-000000000004', 'privacy.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000163', '00000000-0000-7000-8000-000000000005', 'privacy.*', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000164', '00000000-0000-7000-8000-000000000002', 'privacy.*', 'ask', 'any');

-- Level history stays append-only for its numbers, but its words can be redacted: another player's "Won 6-3
-- with Ann" names someone who has since deleted their account. Anything else changed is refused, loudly
-- (the old rule ignored every update without a word).
DROP RULE rating_event_no_update ON rating_event;
CREATE FUNCTION rating_event_words_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'explanation') IS DISTINCT FROM (to_jsonb(OLD) - 'explanation') THEN
    RAISE EXCEPTION 'rating_event is append-only: only its explanation can be redacted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rating_event_words_only BEFORE UPDATE ON rating_event FOR EACH ROW EXECUTE FUNCTION rating_event_words_only();
