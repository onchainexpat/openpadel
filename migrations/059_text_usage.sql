-- Texts counted per club month, in carrier segments (what Twilio bills: 160 plain characters in one, 153 each
-- when longer), against a monthly cap the club sets (text_usage.ts). 1,500 segments is about $19 at Twilio's US
-- price, twice what the cost model gives an 800-member club texting the default way; the estimate uses
-- text_segment_cost (cents) until Twilio reports a text's price.
ALTER TABLE club ADD COLUMN text_cap_segments int NOT NULL DEFAULT 1500 CHECK (text_cap_segments BETWEEN 0 AND 1000000);
ALTER TABLE club ADD COLUMN text_segment_cost numeric(6,3) NOT NULL DEFAULT 1.26 CHECK (text_segment_cost >= 0 AND text_segment_cost <= 100);

CREATE TABLE text_usage (
  month         date PRIMARY KEY,                    -- the first day of the club's month
  texts         int NOT NULL DEFAULT 0,              -- every text handed to Twilio, codes and replies included
  segments      int NOT NULL DEFAULT 0,
  code_texts    int NOT NULL DEFAULT 0,              -- sign-in and confirm-number codes, and HELP and START replies
  code_segments int NOT NULL DEFAULT 0,
  held          int NOT NULL DEFAULT 0,              -- texts not sent because the cap was reached
  priced        int NOT NULL DEFAULT 0,              -- texts Twilio reported a price for
  actual_cents  numeric(10,3) NOT NULL DEFAULT 0,    -- what those cost
  near_cap      int,                                 -- the cap the 80% message was said for (once per cap)
  reached_cap   int,                                 -- the cap the 100% message was said for
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A text's segments as sent, and its price once Twilio says it.
ALTER TABLE outbound_message ADD COLUMN segments smallint;
ALTER TABLE outbound_message ADD COLUMN cost_cents numeric(8,3);
