-- Email that can't arrive (email_suppression.ts). The email service reports, through its signed webhook, an address
-- whose mail server refused the club's email for good (a hard bounce), a member marking it as spam (a complaint), or
-- an address the service itself won't send to any more. Sending to those again only hurts the club's sending name, so
-- each is kept here, in the club's own database: messages to it are dropped (the in-app copy stays), the member's
-- apps say why, and the desk can clear it once the address is fixed. Sign-in codes still go: the person just asked.
CREATE TABLE email_suppression (
  address    text PRIMARY KEY CHECK (address = lower(address)),
  reason     text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'provider')),
  detail     text,                                 -- what the receiving server or the email service said
  first_at   timestamptz NOT NULL,
  last_at    timestamptz NOT NULL,
  times      int NOT NULL DEFAULT 1,
  cleared_at timestamptz,                          -- the desk cleared it: email goes again until the next report
  cleared_by uuid REFERENCES person(id),
  version    int NOT NULL DEFAULT 1
);

-- The day the club's Kumi ends (leaving.ts): the domain its email comes from, so the owners' emails say what becomes of
-- it. The host's own (a subdomain of the host's, such as kestrel.mail.kumi.club) stays with the host; the club's own
-- moves to the club's own email account.
ALTER TABLE club ADD COLUMN leaving_email_domain text, ADD COLUMN leaving_email_domain_host boolean NOT NULL DEFAULT false;

-- The desk fixes members' contact details, so it may clear one too (owners and managers may do everything already).
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000662', '00000000-0000-7000-8000-000000000003', 'person.email_unsuppress', 'allow', 'any');
