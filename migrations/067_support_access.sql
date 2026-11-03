-- Support access (hosted.md item 7): someone outside the club's staff (the host's support, or a contractor) whom
-- the owner lets in for a set time, to look only or to work like a manager. Everything they open and do is
-- recorded for the owner, and the access ends by itself.

-- A person made for support access (they had no account here) is marked so, and kept out of the member lists.
ALTER TABLE person DROP CONSTRAINT person_created_via_check;
ALTER TABLE person ADD CONSTRAINT person_created_via_check CHECK (created_via IN ('signup', 'import', 'desk', 'setup', 'household', 'support'));

CREATE TABLE support_grant (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person(id),
  name          text NOT NULL,
  email         text NOT NULL,
  reason        text NOT NULL,
  level         text NOT NULL CHECK (level IN ('view', 'manager')),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  ended_at      timestamptz,                      -- ended early
  ended_by      uuid REFERENCES person(id),
  granted_by    uuid REFERENCES person(id),
  first_seen_at timestamptz,                      -- their first use of it: the owner hears
  end_told_at   timestamptz,                      -- the owner heard it ended
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  CHECK (ends_at > starts_at)
);
CREATE INDEX support_grant_person ON support_grant (person_id, ends_at);

-- What a person with support access opened (their changes are in action_run, marked with the grant).
CREATE TABLE support_access_log (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES support_grant(id),
  at       timestamptz NOT NULL DEFAULT now(),
  method   text NOT NULL,
  path     text NOT NULL,
  status   int
);
CREATE INDEX support_access_log_grant ON support_access_log (grant_id, at);

ALTER TABLE action_run ADD COLUMN support_grant_id uuid REFERENCES support_grant(id);

-- The owner lets support in; a manager asks the owner. Ending it early only takes access away, so a manager may.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000660', '00000000-0000-7000-8000-000000000002', 'support.*', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000000661', '00000000-0000-7000-8000-000000000002', 'support.end', 'allow', 'any');
