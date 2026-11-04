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
| `KUMI_LISTEN_ADDRESS` | The address it listens on. Only this machine can reach the default; Docker sets `0.0.0.0`, since Caddy is another container. | `127.0.0.1` |
| `KUMI_SOCKET` | A unix socket to listen on instead of a port, such as `/run/kumi-kestrel/http.sock`, for a server several clubs share: no other club's process can reach a socket in a folder only this club and Caddy can open, and a request on it is believed to come through Caddy. The socket is made mode `0660`, so give its folder Caddy's group (and the setgid bit, so the socket gets that group too). Updates and Caddy's config follow it. | not set |
| `NODE_ENV` | `production` on a real server: secure cookies, live Stripe keys allowed, no development routes. | not set |
| `KUMI_PUBLIC_URL` | The staff app's address, such as `https://staff.app.yourclub.com`. Used for passkeys, agent sign-in and Stripe's return pages. | `http://127.0.0.1:8790` |
| `KUMI_MEMBER_URL` | The members' app's address, such as `https://app.yourclub.com`. Links members are sent use it: a club news email's unsubscribe link, and the public page's own address for search engines. | `KUMI_PUBLIC_URL` without its `staff.`, or `KUMI_PUBLIC_URL` itself when it has none |
| `KUMI_PRACTICE` | `1` keeps a production server in practice: real email only to `KUMI_MAIL_TEST_TO`, real texts only to `KUMI_SMS_TEST_TO`. Remove it to go live. | off |
| `KUMI_TRUST_PROXY` | `1` believes the proxy's `X-Forwarded-For` from any address, so sign-in limits and the bot check count each visitor, not the proxy. Only for a server whose port is reachable through the proxy alone: Docker sets it, since Caddy is another container. Caddy on the same machine is always believed, so a machine shared with other clubs uses `KUMI_SOCKET` instead. | off |
| `KUMI_BOT_CHECK` | `0` turns bot protection off on a practice machine (for scripts that sign in over the API). Production refuses to start with it off. | on |
| `KUMI_PUSH_CONTACT` | Who push services can contact about this server's notifications: a `mailto:` address or an `https://` page. The keys that sign pushes are made by the server itself, the first time someone turns notifications on, and kept in the database. | `KUMI_PUBLIC_URL` when it's `https`, otherwise `mailto:owner@localhost` |

## Email (Resend)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_RESEND_API_KEY` | Sends email through Resend. Without it, email and sign-in codes only go to the server's log. | not set |
| `KUMI_MAIL_FROM` | The sender, on the club's verified domain: `"Your Club <hello@mail.yourclub.com>"`. Needed with the key. | not set |
| `KUMI_MAIL_REPLY_TO` | Where replies to Kumi's emails go. | not set |
| `KUMI_MAIL_TEST_TO` | Comma-separated addresses that get real email in practice mode. | none |
| `KUMI_RESEND_WEBHOOK_SECRET` | The signing secret of the club's Resend webhook (`whsec_...`): Resend's reports of bounces and spam complaints reach `/webhooks/resend`, and those addresses get no more email. Without it, the webhook isn't there. | not set |

## Texts (Twilio, optional)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_TWILIO_ACCOUNT_SID`, `KUMI_TWILIO_AUTH_TOKEN` | The club's own Twilio account (`docs/setup/accounts/twilio.md`). With them, members can choose texts in the app. The token also checks what Twilio posts to `/webhooks/twilio/sms` and `/webhooks/twilio/status`. | not set |
| `KUMI_TWILIO_MESSAGING_SERVICE_SID` | Who texts are from: the Messaging Service with the club's registered number (`MG...`). Not needed after `kumi texting` registers one: texts go from it once Twilio approves. | the one `kumi texting` registered, once approved |
| `KUMI_TWILIO_FROM` | Or one number instead (`+15035550123`). | not set |
| `KUMI_SMS_TEST_TO` | Comma-separated numbers that get real texts in practice mode (`+15035550123`). | none |

Texts count toward the club's one monthly cap, below.

## Ask the club (a decision model, optional)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_TYPESAFE_API_KEY` | TypeSafe's Jev answers a member's new question from the club's facts, word for word, or hands it to the staff (`docs/setup/accounts/ask-the-club.md`). | not set |
| `KUMI_ANTHROPIC_API_KEY` | Claude Haiku makes the same decision: when Jev fails or is slow, or on its own without a TypeSafe key. It also writes the drafts staff can ask for of the club's own words in its other language. | not set |

With neither, every question goes to the staff. The club can switch answering off in Settings either way.

## What outside services cost (the monthly meter)

AI, texts and email are counted in the club's month, in dollars, against one cap the owner sets in the staff
app (Usage: $50 a month to start, and an amount allowed over it in a busy month, none to start). The cap is
the club's setting, not the server's. What each thing costs is the server's:

| Setting | What it does | Default |
|---|---|---|
| `KUMI_PRICES` | Prices in cents, comma-separated, for any that differ from list prices: `text_segment` (a text segment with the carrier fee), `email` (one email), and per million tokens `jev_input`, `jev_output`, `haiku_input`, `haiku_output`. Like `text_segment=0.83,email=0`. A hosted service sets its own; a club on its own keys can set what its providers charge it. | `text_segment=1.26,email=0.09,jev_input=4.2,jev_output=0,haiku_input=10,haiku_output=50` |

A price counts from when it's set: what's already counted keeps the price it had. `kumi usage --json` gives a
month's lines by kind (calls, tokens, segments, emails and cents to four places).

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

## Keys the server keeps

| Setting | What it does | Default |
|---|---|---|
| `KUMI_SECRET_KEY` | 32 random bytes (`head -c 32 /dev/urandom \| base64`) that seal the secrets Kumi keeps in the database: authenticator secrets, the push signing key, the vault. Made by `server-setup.sh` (and by the first update on an older server), never printed. Production won't start without it. | not set: secrets kept unsealed, development only |
| `KUMI_SECRET_KEY_PREVIOUS` | The key before, while changing it: values sealed under it still open, and `kumi rotate-key` (or the next start) moves them to the new one. Remove it after. | not set |
| `KUMI_BACKUP_KEY` | 32 random bytes that seal the offsite copies. A key of its own, not the server's, so the backups still open after losing the server: keep a copy away from it (a password manager). | not set; `server-setup.sh` makes one |

## Backups

| Setting | What it does | Default |
|---|---|---|
| `KUMI_BACKUP_DIR` | Where the nightly dumps and their manifests go (kept 14 days), and where `kumi doctor` looks. | `/var/backups/kumi` |
| `KUMI_OFFSITE_ENDPOINT` | The S3-compatible storage's address: `https://<account>.r2.cloudflarestorage.com` (R2), `https://s3.<region>.backblazeb2.com` (B2), `https://<region>.digitaloceanspaces.com`, or AWS's. With the next three, every night's backup also goes offsite, sealed. See [accounts/offsite-backups.md](setup/accounts/offsite-backups.md). | not set: no offsite copy |
| `KUMI_OFFSITE_BUCKET` | The bucket. | |
| `KUMI_OFFSITE_ACCESS_KEY_ID`, `KUMI_OFFSITE_SECRET_ACCESS_KEY` | A key for that bucket only, allowed to read, write and list, and to delete unless `KUMI_OFFSITE_PRUNE=0`. | |
| `KUMI_OFFSITE_PRUNE` | `0`: Kumi never deletes offsite copies; the storage's own lifecycle rules expire them, and its key needs no right to delete (so a stolen server can't wipe them). See [accounts/offsite-backups.md](setup/accounts/offsite-backups.md). | Kumi keeps 30 days and 12 months itself |
| `KUMI_PITR` | `0`: no point-in-time backups on this server (`server-setup.sh` and updates leave Postgres and pgBackRest alone; in Docker the pitr service takes pgBackRest's settings away, so Postgres lets its log go). See [accounts/offsite-backups.md](setup/accounts/offsite-backups.md#going-back-to-a-minute-point-in-time-backups). | on |
| `KUMI_PITR_HOST` | `1` on a server that many clubs share, where the host runs the point-in-time archive for all of them: `kumi doctor` says so instead of checking it. | |
| `KUMI_OFFSITE_REGION` | The region the storage signs for: `auto` for R2, the bucket's region elsewhere (`us-west-004`, `us-east-1`). | `auto` |
| `KUMI_OFFSITE_PREFIX` | The folder in the bucket. | `kumi/` |
| `KUMI_OFFSITE_PATH_STYLE` | `0` for addresses like `bucket.endpoint` instead of `endpoint/bucket`. | path style |
| `KUMI_RESTORE_TEST_DATABASE_URL` | The scratch database the monthly restore test fills and empties. | the live server's `kumi_restore_test` |
| `KUMI_PG_BIN` | Where Postgres 17's programs are: `pg_dump` and `pg_restore`, and for point-in-time backups `pg_ctl` and `psql`. | `/usr/lib/postgresql/17/bin`, else the `PATH` |

## The kumi command

| Setting | What it does | Default |
|---|---|---|
| `KUMI_CLUB_FILE` | The `club.yaml` that `kumi setup` reads when no file is named. | `club.yaml`; `/etc/kumi/club.yaml` on a server |
| `KUMI_LANG` | The command's language (`en` or `es`); `--lang=` overrides it. | from `LANG` |
| `KUMI_CALLER_DIR` | Set by the server's `kumi` wrapper so relative paths work; not set by hand. | |

## Docker only (`.env`)

| Setting | What it does | Default |
|---|---|---|
| `KUMI_HOST` | The members' app's host; staff use `staff.` in front of it. | required |
| `KUMI_DB_PASSWORD` | The database password (`openssl rand -hex 24`). | required |
| `KUMI_TAG` | Which built release the containers run; `deploy/docker/update.sh` sets it. | `local` |
| `KUMI_HTTP_PORT`, `KUMI_HTTPS_PORT` | The ports Caddy is reached on. | `80`, `443` |

The images set the rest themselves: the pitr image's `KUMI_PITR_INLINE`, `KUMI_PITR_PG_PATH`, `KUMI_PITR_SCRATCH`,
`KUMI_PG_BIN` and `KUMI_BACKUP_DIR`, and compose.yaml's `KUMI_PITR_PG_USER` (Postgres's superuser there, `kumi`).
They aren't set by hand.

## Development and tests only

| Setting | What it does |
|---|---|
| `KUMI_CLUB_NAME`, `KUMI_TIME_ZONE`, `KUMI_OWNER_EMAIL`, `KUMI_OWNER_NAME` | The demo club `apps/server/src/seed.ts` makes. |
| `KUMI_TEST_ADMIN_URL` | The Postgres the tests make their throwaway databases in. Default `postgres://postgres@127.0.0.1:55432/postgres`. |
