# Services that see member data

What each outside service Kumi can use gets, so a club can list them in its privacy policy (a template to adapt is
in [templates/member-privacy-policy.md](templates/member-privacy-policy.md)). Self-hosted, each is the
club's own account, set up only if the club wants it; with none of the optional ones, nothing about a member
leaves the club's server except what the club's own email and payments need.

| Service | When | What it gets | Setup |
|---|---|---|---|
| Stripe | Card payments | Each payer's name and email (a Stripe customer), amounts and what they're for. Card numbers go straight from the member's browser to Stripe, never through Kumi. | [setup/accounts/stripe.md](setup/accounts/stripe.md) |
| Resend | Email | Each email: the address it goes to and what it says. | [setup/accounts/resend.md](setup/accounts/resend.md) |
| Twilio (optional) | Texts | The number and the words of each text, and what members text back. | [setup/accounts/twilio.md](setup/accounts/twilio.md) |
| The browser's push service (Apple, Google, Mozilla) | Push messages, for members who turn them on | Each message, encrypted so only the member's device can read it, and when it was sent. | none |
| TypeSafe (optional) | Ask the club | The words of a member's new question and the club's facts. No names or details. Its privacy policy (checked 2 November 2026) says it won't train any model on what it's sent. | [setup/accounts/ask-the-club.md](setup/accounts/ask-the-club.md) |
| Anthropic (optional) | Ask the club; drafts in the club's other language | The same as TypeSafe, when Claude Haiku decides. For a draft, only the club's own words a staff member asks to have translated (a plan's description, the waiver, a coach's bio), never anything about a member. Its commercial terms (checked 2 November 2026) say it may not train models on customer content from its API. | [setup/accounts/ask-the-club.md](setup/accounts/ask-the-club.md) |
| The club's offsite storage (optional) | Nightly backups | The whole database, sealed with the club's backup key before it leaves; the storage company can't read it. | [setup/accounts/offsite-backups.md](setup/accounts/offsite-backups.md) |

Playtomic, when the club uses it, only sends the club's own bookings to Kumi; Kumi never writes to it.
