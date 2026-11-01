# Settings

Every setting Kumi reads. On a server set up with `deploy/server-setup.sh` they live in
`/etc/kumi/kumi.env` (then `systemctl restart kumi`); with Docker, in `.env` next to `compose.yaml`
(then `docker compose up -d`). Keys and secrets go only there: never in `club.yaml`, a commit or a chat.
`kumi doctor` checks the ones that matter.

## The server

| Setting | What it does | Default |
|---|---|---|
| `DATABASE_URL` | The Postgres database. | `postgres://postgres@127.0.0.1:55432/kumi` (development) |
| `PORT` | The port the API listens on (Caddy sends traffic to it). | `8790` |
| `NODE_ENV` | `production` on a real server: secure cookies, live Stripe keys allowed, no development routes. | not set |
| `KUMI_PUBLIC_URL` | The staff app's address, such as `https://staff.app.yourclub.com`. Used for passkeys, agent sign-in and Stripe's return pages. | `http://127.0.0.1:8790` |
| `KUMI_PRACTICE` | `1` keeps a production server in practice: real email only to `KUMI_MAIL_TEST_TO`. Remove it to go live. | off |
| `KUMI_BOT_CHECK` | `0` turns bot protection off on a practice machine (for scripts that sign in over the API). Production refuses to start with it off. | on |
| `KUMI_PUSH_CONTACT` | Who push services can contact about this server's notifications: a `mailto:` address or an `https://` page. The keys that sign pushes are made by the server itself, the first time someone turns notifications on, and kept in the database. | `KUMI_PUBLIC_URL` when it's `https`, otherwise `mailto:owner@localhost` |

## Email (Resend)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_RESEND_API_KEY` | Sends email through Resend. Without it, email and sign-in codes only go to the server's log. | not set |
| `KUMI_MAIL_FROM` | The sender, on the club's verified domain: `"Your Club <hello@mail.yourclub.com>"`. Needed with the key. | not set |
| `KUMI_MAIL_REPLY_TO` | Where replies to Kumi's emails go. | not set |
| `KUMI_MAIL_TEST_TO` | Comma-separated addresses that get real email in practice mode. | none |

## Card payments (Stripe)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_STRIPE_SECRET_KEY` | The Stripe secret key (`sk_test_...` until going live). Without it, a stand-in takes no money. A live key is refused unless `NODE_ENV=production`. | not set |
| `KUMI_STRIPE_PUBLISHABLE_KEY` | The matching publishable key, for the card form. | not set |
| `KUMI_STRIPE_WEBHOOK_SECRET` | Checks Stripe's webhook (`/webhooks/stripe`). Payments still settle without it, within a minute. | not set |
| `KUMI_STRIPE_CONNECT` | `1` for the hosted service: the key is the platform's, and each club connects its own account. Self-hosted clubs leave it off. | off |

## Playtomic (only for a club that also uses it)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_PLAYTOMIC_CLIENT_ID`, `KUMI_PLAYTOMIC_SECRET`, `KUMI_PLAYTOMIC_TENANT_ID` | Third Party API credentials; with all three, Kumi copies the club's bookings in, read-only. | not set |
| `KUMI_MIRROR_EVERY_MINUTES` | How often it reads. | `10` |
| `KUMI_MIRROR_DAYS_AHEAD` | How far ahead it reads. | `30` |

## The kumi command

| Setting | What it does | Default |
|---|---|---|
| `KUMI_CLUB_FILE` | The `club.yaml` that `kumi setup` reads when no file is named. | `club.yaml`; `/etc/kumi/club.yaml` on a server |
| `KUMI_BACKUP_DIR` | Where `kumi doctor` looks for backups. | `/var/backups/kumi` |
| `KUMI_LANG` | The command's language (`en` or `es`); `--lang=` overrides it. | from `LANG` |
| `KUMI_CALLER_DIR` | Set by the server's `kumi` wrapper so relative paths work; not set by hand. | |

## Docker only (`.env`)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_HOST` | The members' app's host; staff use `staff.` in front of it. | required |
| `KUMI_DB_PASSWORD` | The database password (`openssl rand -hex 24`). | required |
| `KUMI_HTTP_PORT`, `KUMI_HTTPS_PORT` | The ports Caddy is reached on. | `80`, `443` |

## Development and tests only

| Setting | What it does |
|---|---|
| `KUMI_CLUB_NAME`, `KUMI_TIME_ZONE`, `KUMI_OWNER_EMAIL`, `KUMI_OWNER_NAME` | The demo club `apps/server/src/seed.ts` makes. |
| `KUMI_TEST_ADMIN_URL` | The Postgres the tests make their throwaway databases in. Default `postgres://postgres@127.0.0.1:55432/postgres`. |
