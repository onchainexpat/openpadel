-- Open matches when plans change. A host saves places for named friends (each pays their own; unpaid at the
-- deadline, the host covers them as for any place). A player who can't make it puts their place up for
-- someone else and gets their money back when it's taken; leaving after the deadline is a late leave. A
-- player running late tells the others. After the game the host can mark who didn't come: the no-show
-- and late-leave record is what hosts see when someone joins or asks.

ALTER TABLE booking_player ADD COLUMN leaving_at timestamptz;              -- can't make it: the place is up for someone else
ALTER TABLE booking_player ADD COLUMN late_leave boolean NOT NULL DEFAULT false;
ALTER TABLE booking_player ADD COLUMN saved_by uuid REFERENCES person;     -- a place the host saved for this friend
ALTER TABLE booking_player ADD COLUMN no_show_by uuid REFERENCES person;   -- who marked it, and when
ALTER TABLE booking_player ADD COLUMN no_show_at timestamptz;

INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000110', '00000000-0000-7000-8000-000000000006', 'booking.save_place', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000111', '00000000-0000-7000-8000-000000000006', 'booking.drop_saved_place', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000112', '00000000-0000-7000-8000-000000000006', 'booking.leave', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000113', '00000000-0000-7000-8000-000000000006', 'booking.running_late', 'allow', 'own'),
  ('00000000-0000-7000-8001-000000000114', '00000000-0000-7000-8000-000000000006', 'booking.mark_no_show', 'allow', 'own');
