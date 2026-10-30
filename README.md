# Kumi

Free, open-source software (AGPL-3.0) that runs a padel club: bookings, payments, memberships,
open matches, clinics and fair levels, with the club's own branded app and a manager that works
on a phone. Agents are built in: members and staff can ask Kumi, or connect their own assistant
over MCP. A club can run it itself or have it hosted.

**Status:** pre-alpha, private while the first version is built. Not ready for use.

## Setting up your club

Start at [`docs/setup/README.md`](docs/setup/README.md): the order, who does what, and a guide for
each outside account (server, email, Stripe, Playtomic). It's written so an AI agent such as Claude
Code can do most of it with the owner, under the rules at the top of [`AGENTS.md`](AGENTS.md). On the
server, `kumi setup plan` and `kumi setup apply` turn a `club.yaml` (see
[`club.example.yaml`](club.example.yaml)) into the club, and `kumi doctor` says what still needs
doing.

## Layout

| Path | What |
|---|---|
| `packages/core` | Actions, schemas, database types and the permission check, shared by everything |
| `packages/i18n` | English and Spanish catalogs and formatting helpers |
| `apps/server` | The API, the MCP endpoint and background jobs (Hono on Node 24) |
| `apps/member` | The members' installable web app (Preact) |
| `apps/manager` | The staff app for phone and web (Preact) |
| `packages/ui` | What both apps share: sign-in, the preview sheet, the profile page, styles |
| `migrations` | Plain SQL migrations, numbered, each applied once |
| `deploy` | Running it: the one-server script, Docker Compose, and shipping updates |
| `docs` | Setting up a club ([`docs/setup`](docs/setup/README.md)), [every setting](docs/settings.md), [releasing](docs/releasing.md) |

## Stack

TypeScript end to end on Node 24 LTS, Hono, Postgres 17 with Kysely over node-postgres, Zod Mini
schemas shared by the API, the MCP tools and the forms, the official MCP SDK, and Preact. The
reasons and measurements are in the design notes (`docs/`, to come).

## Development

Needs Node 24 and Docker.

```bash
npm install
docker run -d --rm --name kumi-dev-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17.9-alpine
docker exec kumi-dev-pg createdb -U postgres kumi
node apps/server/src/seed.ts                                   # a demo club, owner owner@kestrel.test
npm run kumi -- setup plan club.example.yaml                   # or set up from a club.yaml instead
KUMI_PUBLIC_URL=http://localhost:5173 node apps/server/src/main.ts   # API on 8790; emailed codes go to its log
npm run dev -w @kumi/manager                                    # the staff app on http://localhost:5173
npm run dev -w @kumi/member                                     # the members' app on http://localhost:5174
npm test && npm run typecheck
```

Open the staff app at `localhost` (not `127.0.0.1`), so passkeys and the session cookie see one origin.

## Messages and email

Kumi tells people what happened: a place offered from the waitlist, a removal and what happens to the
money, a payment, a sub taking a place, and, for staff, a refund that failed or a clash with Playtomic.
Each lands in the in-app inbox at once; the email copy goes from a job every 30 seconds. Confirmations,
removals and money go straight away; the rest wait out quiet hours (9 pm to 8 am, club time) and are
dropped rather than sent late. Consent is checked at the send.

Without a Resend key, emails (and sign-in codes) only go to the server's log. With one, they go from the
club's own domain, which has to be verified in Resend first:

```bash
KUMI_RESEND_API_KEY=re_… KUMI_MAIL_FROM="Kestrel Padel <hello@kestrelpadel.com>" node apps/server/src/main.ts
# optional: KUMI_MAIL_REPLY_TO=desk@kestrelpadel.com
# outside production, only these get real email; everyone else's is held and logged:
# KUMI_MAIL_TEST_TO=you@example.com,staff@example.com
```

## Card payments (Stripe)

Without Stripe keys the server uses a stand-in, and the members' app shows a "Pay (test)" button.
With a Stripe **test** key it takes real test-mode card payments through Stripe's own card form
(card details go from the browser to Stripe and never reach Kumi), and refunds go back to the card:

```bash
KUMI_STRIPE_SECRET_KEY=sk_test_… KUMI_STRIPE_PUBLISHABLE_KEY=pk_test_… node apps/server/src/main.ts
# optional: KUMI_STRIPE_WEBHOOK_SECRET=whsec_…  (Stripe's webhook, at /webhooks/stripe)
```

A live key (`sk_live_`) is refused unless `NODE_ENV=production`. A payment is recorded however the
news arrives first: the app checking right after the card form, Stripe's webhook, or a job every
30 seconds that asks Stripe about card forms opened in the last two days. Each asks Stripe directly
rather than trusting a message, so the order and repeats don't matter. Test card: 4242 4242 4242 4242,
any future date, any CVC. For webhooks locally: `stripe listen --forward-to localhost:8790/webhooks/stripe`.

Payments are cards only. Apple Pay and Google Pay are cards underneath, so every payment refunds the
same way, straight back to the card.

**Hosted, with Stripe Connect** (`KUMI_STRIPE_CONNECT=1`): the key is Kumi's platform key, and each
club connects its own Stripe account from the manager's Payments page ("Connect with Stripe", then
Stripe's own setup pages). Every payment is made on the club's account, so the money, the payouts,
Stripe's fees and any dispute are the club's; Kumi takes no commission and never holds the club's key.
No payment is taken until Stripe says the club's account is ready, and none ever lands in the
platform's own account. Only the owner sets the account (a manager can ask), with a passkey sign-in if
they have one. Each payment remembers its account, so a refund goes back through it even after the
club changes accounts. Stripe's webhook should send `account.updated` and `payment_intent.*` events
from connected accounts.

## Running beside Playtomic

A club on Playtomic can keep it for court bookings while Kumi runs its events. Kumi copies the
club's Playtomic bookings in, read-only, so it never puts an event on a court Playtomic has sold.
It never writes to Playtomic. The club creates Third Party API keys in Playtomic (its top two
plans include them) and the server reads them from its environment:

```bash
KUMI_PLAYTOMIC_CLIENT_ID=… KUMI_PLAYTOMIC_SECRET=… KUMI_PLAYTOMIC_TENANT_ID=… node apps/server/src/main.ts
# optional: KUMI_MIRROR_EVERY_MINUTES (10), KUMI_MIRROR_DAYS_AHEAD (30)
```

Then staff link each Playtomic court to a Kumi court on the manager's Playtomic page. What a
copied booking does:

- **On a free court:** it holds the court in Kumi.
- **The club's own Playtomic tournament or open play over a Kumi event:** taken as the club
  holding the court for it. A Kumi event can also be added inside one that came first. (Court
  blocks made in Playtomic don't come through its API at all, so they never clash.)
- **A player's booking, lesson, class or course over a Kumi event:** a clash, listed for staff and
  said once.
- **Cancelled or gone in Playtomic:** the court is free again in Kumi.

## Taking part

[`CONTRIBUTING.md`](CONTRIBUTING.md) for changes, [`SECURITY.md`](SECURITY.md) for security problems,
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for how we treat each other, and [`CHANGELOG.md`](CHANGELOG.md)
for what each release changes.

## Licence

AGPL-3.0. See `LICENSE`.
