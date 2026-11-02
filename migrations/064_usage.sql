-- One meter per club month (usage.ts): what the club's paid outside services cost (AI, texts, email), in cents at
-- the server's prices (KUMI_PRICES), against one monthly cap the owner sets. $50 a month by default: a typical
-- month on Kumi's defaults is $25 to $45 for an 800-member club. The owner can also allow an amount over the cap
-- for a busy month. Texts had a cap of their own, in segments (059); it is folded into this one. Its columns stay
-- (unused) so a rollback to 0.1.0 still runs.
ALTER TABLE club ADD COLUMN usage_cap_cents int NOT NULL DEFAULT 5000 CHECK (usage_cap_cents BETWEEN 0 AND 10000000);
ALTER TABLE club ADD COLUMN usage_over_cents int NOT NULL DEFAULT 0 CHECK (usage_over_cents BETWEEN 0 AND 10000000);

CREATE TABLE usage_month (
  month         date NOT NULL,                       -- the first day of the club's month
  kind          text NOT NULL CHECK (kind IN ('ai_decisions', 'ai_drafts', 'texts', 'email')),
  count         int NOT NULL DEFAULT 0,              -- calls to a model, texts or emails
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  segments      int NOT NULL DEFAULT 0,              -- texts: carrier segments
  cents         numeric(14,4) NOT NULL DEFAULT 0,    -- at the prices when each was counted
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, kind)
);

-- The 80%, cap and paused messages, each said once per cap (or limit) per month: the value it was said for.
CREATE TABLE usage_alert (
  month         date PRIMARY KEY,
  near_cap      int,
  reached_cap   int,
  paused_limit  int
);

-- The texts already counted this month and before, at the price per segment the club had.
INSERT INTO usage_month (month, kind, count, segments, cents)
SELECT u.month, 'texts', u.texts, u.segments, u.segments * coalesce((SELECT text_segment_cost FROM club), 1.26)
FROM text_usage u WHERE u.texts > 0;
