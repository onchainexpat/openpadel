-- A member takes back a gift card they bought in the app that's still waiting for its payment (gift_card.drop): its
-- payment is called off and it leaves their list. Their own cards only.
INSERT INTO role_grant (id, role_id, pattern, mode, rows_scope) VALUES
  ('00000000-0000-7000-8001-000000000952', '00000000-0000-7000-8000-000000000006', 'gift_card.drop', 'allow', 'own');
