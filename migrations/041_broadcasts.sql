-- Broadcasts (v1 scope, Staff > Messages): a message the club writes once, in each of its languages, to a
-- group of members. A group is a segment: a set of filters, saved with a name or built on the spot. Club
-- news goes only to people who said yes to it; a service notice (a court closed, a clinic moved) only to
-- people with a booking or place on a date, or in a program, since it's about something of theirs.
-- Members carry the club's own tags ("league A", "beginner 2025").

CREATE TABLE tag (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX tag_name ON tag (lower(name)) WHERE active;

CREATE TABLE person_tag (
  id         uuid PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES person,
  tag_id     uuid NOT NULL REFERENCES tag,
  added_by   uuid REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  version    int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX person_tag_live ON person_tag (person_id, tag_id) WHERE removed_at IS NULL;
CREATE INDEX person_tag_tag ON person_tag (tag_id) WHERE removed_at IS NULL;

-- The filters are kept as written (broadcasts.ts says what each means), so a saved group is "whoever
-- matches when it's used", not a list of names.
CREATE TABLE segment (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  filters    jsonb NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);

CREATE TABLE message_template (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  subject_en text,
  body_en    text,
  subject_es text,
  body_es    text,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  CHECK ((subject_en IS NULL) = (body_en IS NULL) AND (subject_es IS NULL) = (body_es IS NULL) AND (subject_en IS NOT NULL OR subject_es IS NOT NULL))
);

-- One broadcast: the words, the group (its filters as they were, and the saved group's name if it was
-- one), and when. Scheduled until it goes; then the messages are written for whoever matches at that
-- moment. Stopped: the club called off what hadn't gone yet (email spread over days).
CREATE TABLE broadcast (
  id               uuid PRIMARY KEY,
  purpose          text NOT NULL CHECK (purpose IN ('club_news', 'service')),
  subject_en       text,
  body_en          text,
  subject_es       text,
  body_es          text,
  filters          jsonb NOT NULL,
  segment_id       uuid REFERENCES segment,
  segment_name     text,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled', 'stopped')),
  send_at          timestamptz NOT NULL,
  created_by       uuid REFERENCES person,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  cancelled_at     timestamptz,
  matched          int NOT NULL DEFAULT 0,             -- people in the group when it went
  recipients       int NOT NULL DEFAULT 0,             -- people it went to (juniors' parents instead of the juniors)
  left_out_consent int NOT NULL DEFAULT 0,             -- club news: in the group, but no yes to club news
  email_days       int NOT NULL DEFAULT 1,             -- days the email is spread over, under the club's daily cap
  version          int NOT NULL DEFAULT 1,
  CHECK ((subject_en IS NULL) = (body_en IS NULL) AND (subject_es IS NULL) = (body_es IS NULL) AND (subject_en IS NOT NULL OR subject_es IS NOT NULL))
);
CREATE INDEX broadcast_due ON broadcast (send_at) WHERE status = 'scheduled';

ALTER TABLE outbound_message ADD COLUMN broadcast_id uuid REFERENCES broadcast;
CREATE UNIQUE INDEX outbound_message_broadcast ON outbound_message (broadcast_id, person_id, kind, channel) WHERE broadcast_id IS NOT NULL;

-- The address in a club news email's unsubscribe link: a key for that one thing (stopping club news by
-- email), never for signing in. A deleted account gets a new one, so an old link leads nowhere.
ALTER TABLE person ADD COLUMN news_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
CREATE UNIQUE INDEX person_news_token ON person (news_token);

-- How many broadcast emails go out in a club day (the rest wait for the next day, so the email service's
-- daily limit and the club's own messages keep room), and whether managers get a copy of each broadcast.
ALTER TABLE club ADD COLUMN broadcast_daily_cap int NOT NULL DEFAULT 80 CHECK (broadcast_daily_cap BETWEEN 1 AND 100000);
ALTER TABLE club ADD COLUMN broadcast_copy_managers boolean NOT NULL DEFAULT false;

-- Front desk tags members, keeps the club's groups and templates, and sends broadcasts (owners and managers
-- have '*'); a member says yes or no to club news for themselves.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000189', '00000000-0000-7000-8000-000000000003', 'tag.create', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000190', '00000000-0000-7000-8000-000000000003', 'tag.update', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000191', '00000000-0000-7000-8000-000000000003', 'person.tag', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000192', '00000000-0000-7000-8000-000000000003', 'person.untag', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000193', '00000000-0000-7000-8000-000000000003', 'segment.save', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000194', '00000000-0000-7000-8000-000000000003', 'segment.update', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000195', '00000000-0000-7000-8000-000000000003', 'template.save', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000196', '00000000-0000-7000-8000-000000000003', 'template.update', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000197', '00000000-0000-7000-8000-000000000003', 'broadcast.send', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000198', '00000000-0000-7000-8000-000000000003', 'broadcast.cancel', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000199', '00000000-0000-7000-8000-000000000006', 'consent.club_news', 'allow', 'own');
