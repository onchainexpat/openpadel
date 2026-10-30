-- Results of court bookings and open matches. A player enters the score (their side confirms it by entering
-- it); a player from the other side confirms or disputes it; with no answer by confirm_by it counts as
-- entered. A rated match moves levels once confirmed. A dispute goes to the club, which keeps the score,
-- corrects it, or sets it aside, and levels are replayed from what's left.

ALTER TABLE game ADD COLUMN booking_id uuid REFERENCES booking;
ALTER TABLE game ADD COLUMN confirm_by timestamptz;
CREATE UNIQUE INDEX game_one_per_booking ON game (booking_id) WHERE booking_id IS NOT NULL AND status <> 'void';

CREATE TABLE result_answer (
  id        uuid PRIMARY KEY,
  game_id   uuid NOT NULL REFERENCES game,
  person_id uuid REFERENCES person,                 -- none: Kumi, when nobody answered in time
  side      text CHECK (side IN ('a', 'b')),
  answer    text NOT NULL CHECK (answer IN ('entered', 'confirm', 'dispute', 'auto', 'kept', 'corrected', 'set_aside')),
  note      text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX result_answer_game ON result_answer (game_id);

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000120', '00000000-0000-7000-8000-000000000006', 'result.enter', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000121', '00000000-0000-7000-8000-000000000006', 'result.confirm', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000122', '00000000-0000-7000-8000-000000000006', 'result.dispute', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000123', '00000000-0000-7000-8000-000000000003', 'result.resolve', 'allow', 'any');
