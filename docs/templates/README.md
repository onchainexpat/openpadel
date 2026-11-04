**Draft for review by a lawyer. This is not legal advice.**

# Templates for the club's own policies

Every club needs a privacy policy and terms for its members on its own website. Carriers check the privacy policy
before they approve the club's texts, and Stripe and members expect both. These templates say what Kumi actually
does, so a club only has to add its own details and rules:

| Template | What it is |
|---|---|
| [member-privacy-policy.md](member-privacy-policy.md) | The club's privacy policy for members: what the app collects and why, texts (opt-in, STOP, HELP, and the clause carriers look for), email, payments, families and children, the companies involved, downloading and deleting your data |
| [member-terms.md](member-terms.md) | The club's terms of use: accounts, booking, paying (sharing a court, open matches, saved cards), cancelling, memberships, families, the waiver, levels, members' own AI assistants |

## How to use them

1. Copy both into the club's website.
2. Replace every `[PLACEHOLDER]` with the club's own details and rules. Keep the `[IF ...]` parts that apply (the
   club texts, uses "ask the club", is hosted, uses Playtomic) and delete the rest.
3. Take out the first line and the notes in italics.
4. **Have a lawyer read them**, along with the club's waiver. They're written for clubs in the United States, and
   state laws differ.
5. Put the club's version in every language its members use. Kumi's apps are in English and US Spanish.
6. Publish them on the club's own website. Twilio's reviewers look for the privacy policy before they approve the
   club's texts (`docs/setup/accounts/twilio.md`, step 3), and they turn registrations down most often when the policy
   doesn't say members' mobile numbers aren't shared for marketing. Keep that sentence word for word.
7. **Put the links into Kumi:** the staff app's Settings, "Terms for members" and "Privacy policy" (or `terms_url` and
   `privacy_policy_url` under `club:` in club.yaml, for `kumi setup`). Members then see them where they join, beside
   the yes to texts, on their profile and at the foot of the public pages, and joining agrees to them: Kumi keeps
   which links each new member agreed to, and when, and it's in their Download data. Members who joined before the
   links were set aren't asked again. The texting registration gives Twilio the same links, and `kumi doctor` warns
   while the club texts without a privacy policy linked.

## Keep them true

The templates describe Kumi as of 3 November 2026. If the club changes what it does (adds a service, keeps data
longer, sends texts about something else), change the policy first. Where each statement comes from:

- what's collected: `migrations/` (the `person` table and sessions), `packages/core/src/households.ts`,
  `packages/core/src/kids.ts`;
- texts: the opt-in wording and replies in `packages/i18n/src/en.ts` (`texting.opt_in_flow`, `texting.use_case`,
  `sms.*`);
- email and quiet hours: the README, "Messages and email"; club news consent in `packages/i18n/src/en.ts`
  (`plan.consent.news_yes`);
- payments, sharing a court and open matches: the README, "Card payments"; `packages/core/src/booking_pay.ts`;
- the companies involved: [`docs/processors.md`](../processors.md);
- downloading and deleting data, and what's kept: `docs/setup/README.md`, "Members' data";
  `packages/core/src/privacy.ts`;
- backups: the README, "Going back to a minute";
- no tracking: the server sets only its session cookie (`apps/server/src/app.ts`), and IP addresses are kept only
  in memory for sign-in limits (`apps/server/src/limits.ts`);
- members' own assistants: `docs/setup/README.md`, "Members' own assistants".
