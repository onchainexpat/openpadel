-- Moved (club_exit.ts): the club's Kumi now runs on another server, so this one sends members nothing more and
-- takes nothing new (as read-only), and both apps say where the club went. An export made after it's on carries
-- what was still waiting to go out, and the new server sends it: only one server ever talks to members.
ALTER TABLE club ADD COLUMN moved_at timestamptz, ADD COLUMN moved_to text;
