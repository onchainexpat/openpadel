-- Family plans. A plan can cover a family: whoever pays (on their own card) and others from their
-- household, up to `family_size` people in all, and optionally more at `extra_person_cents` each a
-- period. The payer picks who's covered: the household's other parent, grown-up children with their
-- own login, and juniors. Everyone covered has the plan's benefits as their own; included sessions are
-- counted for each person. A person added beyond the plan's number is charged their extra price for
-- the current period at once; someone taken off keeps the benefits until the next renewal.

ALTER TABLE membership_plan ADD COLUMN family_size int CHECK (family_size BETWEEN 2 AND 12);   -- null: one person
ALTER TABLE membership_plan ADD COLUMN extra_person_cents int CHECK (extra_person_cents >= 0);  -- null: no more than family_size
-- As joined, like the price: a membership keeps the terms it was bought on.
ALTER TABLE membership ADD COLUMN family_size int;
ALTER TABLE membership ADD COLUMN extra_person_cents int;

CREATE TABLE membership_member (
  id            uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES membership,
  person_id     uuid NOT NULL REFERENCES person,
  extra         boolean NOT NULL DEFAULT false,   -- beyond the plan's number when added
  added_by      uuid REFERENCES person,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,                      -- taken off: covered until then
  version       int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX membership_member_live ON membership_member (person_id) WHERE ends_at IS NULL;   -- one family plan at a time
CREATE INDEX membership_member_membership ON membership_member (membership_id);

-- The extra person's price for the period they were added in.
ALTER TABLE payment ADD COLUMN membership_member_id uuid REFERENCES membership_member;

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000148', '00000000-0000-7000-8000-000000000006', 'membership.add_person', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000149', '00000000-0000-7000-8000-000000000006', 'membership.remove_person', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000150', '00000000-0000-7000-8000-000000000003', 'membership.add_person', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000151', '00000000-0000-7000-8000-000000000003', 'membership.remove_person', 'allow', 'any');
