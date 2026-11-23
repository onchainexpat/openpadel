-- The assistant's name (Ask {assistant}): the club's own, in Settings or club.yaml. NULL: the install's product name
-- (openPadel on a club's own server, Kumi on the hosted service), so a club that never sets one sees no change.
-- A name, the same in both languages: plain text, 1 to 24 characters (club.update checks the rest).
ALTER TABLE club ADD COLUMN assistant_name text CHECK (assistant_name IS NULL OR char_length(assistant_name) BETWEEN 1 AND 24);
