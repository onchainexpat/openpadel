-- Players talk inside a game they play together (chat.ts): a court booking with named players (an open match is
-- one), or a program's date. No messages between members outside a shared game, and none for juniors in this
-- version. A thread is made with its first message and goes, with everything in it, 90 days after its game.

CREATE TABLE chat_thread (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('booking', 'session')),
  ref_id     uuid NOT NULL,                              -- the booking, or the program's date (session)
  ends_at    timestamptz NOT NULL,                       -- when the game ends: kept until 90 days after
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id)
);
CREATE INDEX chat_thread_ends ON chat_thread (ends_at);

-- A message: plain text. Taken back by its author (or their account deleted): the words go, "message removed"
-- stays. Hidden by the club: kept for the staff, shown to players as "hidden by the club".
CREATE TABLE chat_message (
  id         uuid PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES chat_thread ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES person,
  body       text NOT NULL CHECK (length(body) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  removed_at timestamptz,
  hidden_at  timestamptz,
  hidden_by  uuid REFERENCES person,
  version    int NOT NULL DEFAULT 1
);
CREATE INDEX chat_message_thread ON chat_message (thread_id, created_at);
CREATE INDEX chat_message_person ON chat_message (person_id, created_at);

-- Each player's place in a thread: what they've read, whether they muted it, when their phone was last told.
-- Someone who leaves the game keeps it, and reads (without posting) until the game ends.
CREATE TABLE chat_seen (
  thread_id uuid NOT NULL REFERENCES chat_thread ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES person,
  read_at   timestamptz,
  muted     boolean NOT NULL DEFAULT false,
  pushed_at timestamptz,
  PRIMARY KEY (thread_id, person_id)
);

-- The club stopping someone posting in chats for a while (they still read).
CREATE TABLE chat_stop (
  id         uuid PRIMARY KEY,
  person_id  uuid NOT NULL REFERENCES person,
  until      timestamptz NOT NULL,
  reason     text CHECK (length(reason) <= 300),
  created_by uuid REFERENCES person,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  version    int NOT NULL DEFAULT 1
);
CREATE INDEX chat_stop_person ON chat_stop (person_id, until);

-- A player reporting a message to the club: the staff hear once per message.
CREATE TABLE chat_report (
  id         uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES chat_message ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES person,
  reason     text CHECK (length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  UNIQUE (message_id, person_id)
);

-- The club's switch (Settings): on by default; off, no chat anywhere.
ALTER TABLE club ADD COLUMN players_chat boolean NOT NULL DEFAULT true;

-- Members report a message; front desk hides one and stops (or lets again) someone posting. Owners and
-- managers have '*'.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000901', '00000000-0000-7000-8000-000000000006', 'chat.report', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000902', '00000000-0000-7000-8000-000000000003', 'chat.hide', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000903', '00000000-0000-7000-8000-000000000003', 'chat.stop', 'allow', 'any'),
  ('00000000-0000-7000-8001-000000000904', '00000000-0000-7000-8000-000000000003', 'chat.allow', 'allow', 'any');
