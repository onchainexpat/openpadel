-- Levels (data_model.md 5): every change is an append-only rating event with its explanation,
-- so replaying the events reproduces the ratings exactly and "why it moved" is always answerable.
CREATE TABLE rating_event (
  id            uuid PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES person,
  sport         text NOT NULL DEFAULT 'padel',
  game_id       uuid REFERENCES game,
  kind          text NOT NULL CHECK (kind IN ('game', 'staff_set', 'floor', 'import_seed', 'recompute')),
  mu_before     double precision, sigma_before double precision, level_before numeric(4,2),
  mu_after      double precision NOT NULL, sigma_after double precision NOT NULL, level_after numeric(4,2) NOT NULL,
  share         double precision,
  factors       jsonb NOT NULL DEFAULT '{}',
  explanation   jsonb NOT NULL,
  action_run_id uuid NOT NULL REFERENCES action_run,
  model_version text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rating_event_person ON rating_event (person_id, at);
CREATE RULE rating_event_no_update AS ON UPDATE TO rating_event DO INSTEAD NOTHING;
CREATE RULE rating_event_no_delete AS ON DELETE TO rating_event DO INSTEAD NOTHING;

-- Friendlies never count: a program says whether its games are rated, and players see it first.
ALTER TABLE program ADD COLUMN rated boolean NOT NULL DEFAULT false;

-- Level changes: owners and managers do them; front desk asks; coaches set floors after an assessment.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000050', '00000000-0000-7000-8000-000000000003', 'level.*', 'ask', 'any'),
  ('00000000-0000-7000-8001-000000000051', '00000000-0000-7000-8000-000000000004', 'level.*', 'allow', 'any');
