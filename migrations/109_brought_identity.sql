-- The move-in's third review (not released): brought_credit is one total per person here, so a member who deleted their
-- account and joined again (a new person) got the same Playtomic wallet a second time while it still showed in
-- Playtomic. What's been brought in now also follows the person as Playtomic knows them: their Playtomic id and their
-- address, each kept only as a one-way hash salted with the club's own value (club.erase_salt, as the erased marker
-- keeps them), with the total brought for them. Nothing in it can be read back to anyone, so it outlives an erasure.
CREATE TABLE brought_identity (
  key_hash   text PRIMARY KEY,
  system     text NOT NULL CHECK (system IN ('playtomic')),
  cents      int NOT NULL CHECK (cents >= 0),
  updated_at timestamptz NOT NULL,
  version    int NOT NULL DEFAULT 1
);
