-- The passes and promo codes review (passes.ts, promo_codes.ts): coach lessons are covered by a pass made for them
-- (a courts pass covers court bookings only); wrong promo codes are counted per person, as gift card codes are; and a
-- payment records who paid it (a parent paying their junior's), so a refund given as club credit goes to them.
ALTER TABLE pass_product DROP CONSTRAINT pass_product_covers_check;
ALTER TABLE pass_product ADD CONSTRAINT pass_product_covers_check CHECK (covers IN ('programs', 'courts', 'lessons'));
ALTER TABLE pass DROP CONSTRAINT pass_covers_check;
ALTER TABLE pass ADD CONSTRAINT pass_covers_check CHECK (covers IN ('programs', 'courts', 'lessons'));

CREATE TABLE promo_try (
  id        bigserial PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES person,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promo_try_person ON promo_try (person_id, at);

ALTER TABLE payment ADD COLUMN paid_by uuid REFERENCES person;
