-- Asking the club (v1 scope, Help): the club's approved answers ("club facts"), members' questions as
-- threads the staff answer from one inbox, and an alert said once when a question waits too long.
-- "Ask the club" later puts a decision model in front: it picks an approved fact, word for word, or
-- hands the question to staff. Every such decision is kept with the version of the questions it was
-- asked, and a member's "that didn't answer it" is kept on it as a label (decisions.md).

-- A fact is the club's own words, in each of its languages. Members see the switched-on ones as
-- "Common questions"; the public page shows those marked public, once the page is on.
CREATE TABLE club_fact (
  id          uuid PRIMARY KEY,
  topic       text NOT NULL CHECK (topic IN ('general', 'hours', 'prices', 'bookings', 'memberships', 'programs', 'lessons', 'juniors', 'rules', 'parking', 'facilities')),
  question_en text,
  answer_en   text,
  question_es text,
  answer_es   text,
  active      boolean NOT NULL DEFAULT true,
  public      boolean NOT NULL DEFAULT false,          -- also on the public page (a door code never is, unless ticked)
  created_by  uuid REFERENCES person,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  CHECK ((question_en IS NULL) = (answer_en IS NULL) AND (question_es IS NULL) = (answer_es IS NULL) AND (question_en IS NOT NULL OR question_es IS NOT NULL))
);
CREATE INDEX club_fact_active ON club_fact (active, topic);

-- A thread: whom it's about (a junior, when a parent asks), who asked, and where it stands. Waiting
-- since: when the member's latest message started waiting for the staff (null once staff or the club's
-- fact answered). The alert is said once per thread.
CREATE TABLE question (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person,
  asked_by      uuid NOT NULL REFERENCES person,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  assigned_to   uuid REFERENCES person,
  waiting_since timestamptz,
  alerted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  version       int NOT NULL DEFAULT 1
);
CREATE INDEX question_waiting ON question (status, waiting_since);
CREATE INDEX question_asked_by ON question (asked_by, created_at);
CREATE INDEX question_person ON question (person_id);

-- Each message in a thread: the member's, a staff member's, or the club's fact sent word for word.
CREATE TABLE question_message (
  id          uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES question,
  side        text NOT NULL CHECK (side IN ('member', 'staff', 'club')),
  author_id   uuid REFERENCES person,                  -- null for the club's fact
  body        text NOT NULL,
  fact_id     uuid REFERENCES club_fact,
  created_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);
CREATE INDEX question_message_thread ON question_message (question_id, created_at);

-- What the answerer decided for each member message it saw: send a fact, or hand the question to staff.
-- Kept whatever it decided, with the version of its questions, so a change of model or thresholds can
-- be compared, and staff corrections (the member's "that didn't answer it") become labels.
CREATE TABLE answer_decision (
  id                uuid PRIMARY KEY,
  question_id       uuid NOT NULL REFERENCES question,
  message_id        uuid NOT NULL REFERENCES question_message,
  answerer          text NOT NULL,                     -- 'staff_only' until a decision model is set
  questions_version text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('fact', 'staff')),
  fact_id           uuid REFERENCES club_fact,
  confidence        numeric(5,4),
  detail            jsonb,                             -- what the answerer gave back (probabilities), or why it failed
  corrected         text CHECK (corrected IN ('not_answered')),
  corrected_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answer_decision_question ON answer_decision (question_id);

-- How long a question can wait for the staff, counted in opening hours, before front desk hears. 0: never.
ALTER TABLE club ADD COLUMN question_alert_hours int NOT NULL DEFAULT 2 CHECK (question_alert_hours BETWEEN 0 AND 72);

-- Members ask, follow up, say a fact didn't answer it and close their own threads (a parent for their
-- junior); front desk writes the facts and answers, assigns and closes any thread (owners and managers
-- have '*').
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000180', '00000000-0000-7000-8000-000000000006', 'question.ask', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000181', '00000000-0000-7000-8000-000000000006', 'question.reply', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000182', '00000000-0000-7000-8000-000000000006', 'question.not_answered', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000183', '00000000-0000-7000-8000-000000000006', 'question.close', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000184', '00000000-0000-7000-8000-000000000003', 'question.answer', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000185', '00000000-0000-7000-8000-000000000003', 'question.assign', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000186', '00000000-0000-7000-8000-000000000003', 'question.close', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000187', '00000000-0000-7000-8000-000000000003', 'fact.create', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000188', '00000000-0000-7000-8000-000000000003', 'fact.update', 'allow', 'any');
