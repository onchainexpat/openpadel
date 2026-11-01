-- The Today view (v1 scope, Staff): staff move a booking or change how long it runs (booking.move and
-- booking.extend come under the front desk's 'booking.*'), and staff alerts are handled once for the club.
-- An alert is a staff message that needs someone (a place left empty at the last minute, a question waiting,
-- money owed, a program short of its minimum, a refund that failed); its words are that message. This table
-- only says who handled it and when, so it goes off everyone's list.
CREATE TABLE staff_alert (
  id         uuid PRIMARY KEY,
  event_id   bigint NOT NULL REFERENCES event_outbox,
  kind       text NOT NULL,
  handled_by uuid REFERENCES person,
  handled_at timestamptz NOT NULL,
  version    int NOT NULL DEFAULT 1,
  UNIQUE (event_id, kind)
);

-- The front desk handles alerts (owners and managers have '*').
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000207', '00000000-0000-7000-8000-000000000003', 'alert.handle', 'allow', 'any');
