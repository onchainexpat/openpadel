-- Ask the club: a decision model answers a new question from the club's facts, word for word, or hands it to
-- the staff (questions.ts; the model and its thresholds are in apps/server/src/answerer.ts). It never writes
-- anything itself. A club can switch it off in Settings even when the server has a model set up.
ALTER TABLE club ADD COLUMN auto_answers boolean NOT NULL DEFAULT true;

-- Two labels on a decision now: the fact didn't answer it, or the member wanted a person anyway (the fact may
-- have been right).
ALTER TABLE answer_decision DROP CONSTRAINT IF EXISTS answer_decision_corrected_check;
ALTER TABLE answer_decision ADD CONSTRAINT answer_decision_corrected_check CHECK (corrected IN ('not_answered', 'wants_person'));
-- The health check counts the last day's decisions.
CREATE INDEX answer_decision_at ON answer_decision (created_at);

-- Members ask for a person after the club's fact (a parent for their junior).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000303', '00000000-0000-7000-8000-000000000006', 'question.ask_person', 'allow', 'own');
