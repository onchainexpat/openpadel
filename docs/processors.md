# Services that see member data

What each outside service openPadel can use gets, so a club can list them in its privacy policy (a template to adapt is
in [templates/member-privacy-policy.md](templates/member-privacy-policy.md)). Self-hosted, each is the
club's own account, set up only if the club wants it; with none of the optional ones, nothing about a member
leaves the club's server except what the club's own email and payments need.

| Service | When | What it gets | Setup |
|---|---|---|---|
| Stripe | Card payments | Each payer's name and email (a Stripe customer), amounts and what they're for. Card numbers go straight from the member's browser to Stripe, never through openPadel. | [setup/accounts/stripe.md](setup/accounts/stripe.md) |
| Resend | Email | Each email: the address it goes to and what it says. | [setup/accounts/resend.md](setup/accounts/resend.md) |
| Twilio (optional) | Texts | The number and the words of each text, and what members text back. | [setup/accounts/twilio.md](setup/accounts/twilio.md) |
| The browser's push service (Apple, Google, Mozilla) | Push messages, for members who turn them on | Each message, encrypted so only the member's device can read it, and when it was sent. A new message in a game's chat goes this way too (its game, who wrote it and the start of what they wrote), at most once in 5 minutes per chat. | none |
| TypeSafe (optional) | Ask the club | The words of a member's new question and the club's facts. No names or details. Its privacy policy (checked 2 November 2026) says it won't train any model on what it's sent. | [setup/accounts/ask-the-club.md](setup/accounts/ask-the-club.md) |
| Anthropic (optional) | Ask the club; drafts in the club's other language | The same as TypeSafe, when Claude Haiku decides. For a draft, only the club's own words a staff member asks to have translated (a plan's description, the waiver, a coach's bio), never anything about a member. Its commercial terms (checked 2 November 2026) say it may not train models on customer content from its API. | [setup/accounts/ask-the-club.md](setup/accounts/ask-the-club.md) |
| A person's own assistant (Claude, ChatGPT, an agent using the command line), when they connect one | What they ask it to read or change, as they could see it in the app, sent to the assistant's provider. For a staff member, the staff screens' reads too, with emails and phone numbers shortened. The person chooses the provider; openPadel sends nothing until they connect it, and they can disconnect it in Profile, Assistants. | none (the person's choice) |
| The club's offsite storage (optional) | Nightly backups | The whole database, sealed with the club's backup key before it leaves; the storage company can't read it. | [setup/accounts/offsite-backups.md](setup/accounts/offsite-backups.md) |

Playtomic, when the club uses it, only sends the club's own bookings to openPadel; openPadel never writes to it.
openPadel keeps a copy of each booking it reads, with its players' names and emails, in the club's own database
(the club's record, since Playtomic keeps bookings only three months back). A member's name and email go from it
when their account is deleted ([moving-from-playtomic.md](setup/moving-from-playtomic.md)).
Moving in from Playtomic, staff can also read the club's own players from it, or upload its customer export (name, email, phone,
wallet balances and memberships), kept on the club's server for the move-in (an upload 30 days) and deleted with the person ([wallets and memberships](setup/playtomic-wallets-and-memberships.md)).

## Plugins

Each plugin a club installs ([plugins/README.md](plugins/README.md)) says in its manifest what member data it sends
where, in plain words (its `data_out`). The club's own list adds it as it's installed and drops it when it's removed:
`openpadel processors` gives the services above with a row for each installed plugin, in the reader's language, and the
same as Markdown rows ready for the privacy policy's table ([templates/member-privacy-policy.md](templates/member-privacy-policy.md)).
A plugin is installed only after the owner sees, in its install preview, what it sends.

