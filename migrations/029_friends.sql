-- Friends. A member adds someone they've played with (in the same booking or game), or anyone whose
-- friend link they've been given; the two are friends once each has added the other. Only friends can
-- save each other a place in a match, and finding someone by name looks among friends only, so a
-- member's name is never shown to someone they haven't played with or shared their link with.

CREATE TABLE friend (
  id         uuid PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES person,        -- who added
  friend_id  uuid NOT NULL REFERENCES person,        -- whom
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,                            -- taken back (adding again brings the row back)
  version    int NOT NULL DEFAULT 1,
  UNIQUE (person_id, friend_id),
  CHECK (person_id <> friend_id)
);
CREATE INDEX friend_back ON friend (friend_id);

-- The code in each member's "add me" link: not a secret (it only lets someone ask to be friends).
ALTER TABLE person ADD COLUMN friend_code text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
CREATE UNIQUE INDEX person_friend_code ON person (friend_code);

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000124', '00000000-0000-7000-8000-000000000006', 'friend.add', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000125', '00000000-0000-7000-8000-000000000006', 'friend.add_by_code', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000126', '00000000-0000-7000-8000-000000000006', 'friend.remove', 'allow', 'own');
