# Settings

Every setting openPadel reads. Settings are named `OPENPADEL_` (openPadel was called Kumi until November 2026), and
each one's old `KUMI_` name is still read, so a server set up before needs nothing: when both are set, the `OPENPADEL_`
one is used, and `openpadel doctor` says so. `sudo openpadel settings rename` moves a settings file to the new names,
keeping a dated copy beside it and printing names only (with Docker, `deploy/docker/update.sh rename-settings`; after
it, an older release's `compose.yaml` wouldn't find its settings, so only once there's no going back to before 0.9.0).
The paths (`/etc/kumi`, `/var/lib/kumi`), the `kumi` service and command, and the database keep their names.
On a server set up with `deploy/server-setup.sh` the settings live in
`/etc/kumi/kumi.env` (then `systemctl restart kumi`); with Docker, in `.env` next to `compose.yaml`
(then `docker compose up -d`). Keys and secrets go only there: never in `club.yaml`, a commit or a chat.
`openpadel doctor` checks the ones that matter.

What the club decides for itself isn't here: its name, languages, sign-up, public page, and the links to its own
terms and privacy policy for members (`docs/templates`) are in the staff app's Settings, or `club:` in club.yaml for
`openpadel setup` (`club.example.yaml`).

## The server

| Setting | What it does | Default |
|---|---|---|
| `DATABASE_URL` | The Postgres database. | `postgres://postgres@127.0.0.1:55432/kumi` (development) |
| `PORT` | The port the API listens on (Caddy sends traffic to it). | `8790` |
| `OPENPADEL_HOSTED` | `1` when Kumi's hosted service runs the install (kumi-hosted sets it on every club): staff read "Kumi" for the product's name instead of "openPadel", and the members' profile, the public page and the staff app's Settings show "Runs on Kumi". Members never read a product name otherwise. A club running openPadel itself leaves it off. The public page is kept up to 5 minutes, so after a change it can show the old footer for that long. | off |
| `OPENPADEL_LISTEN_ADDRESS` | The address it listens on. Only this machine can reach the default; Docker sets `0.0.0.0`, since Caddy is another container. | `127.0.0.1` |
| `OPENPADEL_SOCKET` | A unix socket to listen on instead of a port, such as `/run/kumi-kestrel/http.sock`, for a server several clubs share: no other club's process can reach a socket in a folder only this club and Caddy can open, and a request on it is believed to come through Caddy. The socket is made mode `0660`, so give its folder Caddy's group (and the setgid bit, so the socket gets that group too). Updates and Caddy's config follow it. | not set |
| `NODE_ENV` | `production` on a real server: secure cookies, live Stripe keys allowed, no development routes. | not set |
| `OPENPADEL_PUBLIC_URL` | The staff app's address, such as `https://staff.app.yourclub.com`. Used for passkeys, agent sign-in and Stripe's return pages. | `http://127.0.0.1:8790` |
| `OPENPADEL_MEMBER_URL` | The members' app's address, such as `https://app.yourclub.com`. Links members are sent use it: a club news email's unsubscribe link, and the public page's own address for search engines. | `OPENPADEL_PUBLIC_URL` without its `staff.`, or `OPENPADEL_PUBLIC_URL` itself when it has none |
| `OPENPADEL_PRACTICE` | `1` keeps a production server in practice: real email only to `OPENPADEL_MAIL_TEST_TO`, real texts only to `OPENPADEL_SMS_TEST_TO`. Remove it to go live. | off |
| `OPENPADEL_TRUST_PROXY` | `1` believes the proxy's `X-Forwarded-For` from any address, so sign-in limits and the bot check count each visitor, not the proxy. Only for a server whose port is reachable through the proxy alone: Docker sets it, since Caddy is another container. Caddy on the same machine is always believed, so a machine shared with other clubs uses `OPENPADEL_SOCKET` instead. | off |
| `OPENPADEL_LEGACY_SESSION_COOKIE` | `0` stops reading the sign-in cookie's old name (`kumi_session`) over HTTPS, so only `__Host-kumi_session` signs anyone in. For a host whose clubs share a domain and never had the old name (another club's server could set it); a club updating its own server leaves it on for a release, so nobody is signed out. | on |
| `OPENPADEL_BOT_CHECK` | `0` turns bot protection off on a practice machine (for scripts that sign in over the API). Production refuses to start with it off. | on |
| `OPENPADEL_PUSH_CONTACT` | Who push services can contact about this server's notifications: a `mailto:` address or an `https://` page. The keys that sign pushes are made by the server itself, the first time someone turns notifications on, and kept in the database. | `OPENPADEL_PUBLIC_URL` when it's `https`, otherwise `mailto:owner@localhost` |

## Email (Resend)

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_RESEND_API_KEY` | Sends email through Resend. Without it, email and sign-in codes only go to the server's log. | not set |
| `OPENPADEL_MAIL_FROM` | The sender, on the club's verified domain: `"Your Club <hello@mail.yourclub.com>"`. Needed with the key. | not set |
| `OPENPADEL_MAIL_REPLY_TO` | Where replies to openPadel's emails go. | not set |
| `OPENPADEL_MAIL_TEST_TO` | Comma-separated addresses that get real email in practice mode. | none |
| `OPENPADEL_RESEND_WEBHOOK_SECRET` | The signing secret of the club's Resend webhook (`whsec_...`): Resend's reports of bounces and spam complaints reach `/webhooks/resend`, and those addresses get no more email. Without it, the webhook isn't there. | not set |

## Texts (Twilio, optional)

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_TWILIO_ACCOUNT_SID`, `OPENPADEL_TWILIO_AUTH_TOKEN` | The club's own Twilio account (`docs/setup/accounts/twilio.md`). With them, members can choose texts in the app. The token also checks what Twilio posts to `/webhooks/twilio/sms` and `/webhooks/twilio/status`. | not set |
| `OPENPADEL_TWILIO_MESSAGING_SERVICE_SID` | Who texts are from: the Messaging Service with the club's registered number (`MG...`). Not needed after `openpadel texting` registers one: texts go from it once Twilio approves. | the one `openpadel texting` registered, once approved |
| `OPENPADEL_TWILIO_FROM` | Or one number instead (`+15035550123`). | not set |
| `OPENPADEL_SMS_TEST_TO` | Comma-separated numbers that get real texts in practice mode (`+15035550123`). | none |

Texts count toward the club's one monthly cap, below.

## Ask the club (a decision model, optional)

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_TYPESAFE_API_KEY` | TypeSafe's Jev answers a member's new question from the club's facts, word for word, or hands it to the staff (`docs/setup/accounts/ask-the-club.md`). | not set |
| `OPENPADEL_ANTHROPIC_API_KEY` | Claude Haiku makes the same decision: when Jev fails or is slow, or on its own without a TypeSafe key. It also writes the drafts staff can ask for of the club's own words in its other language, and turns on Ask openPadel, the hosted assistant (Claude Sonnet for staff, Claude Haiku for members: [accounts/ask-openpadel.md](setup/accounts/ask-openpadel.md)). | not set |

With neither, every question goes to the staff. The club can switch answering off in Settings either way.

## What outside services cost (the monthly meter)

AI, texts and email are counted in the club's month, in dollars, against one cap the owner sets in the staff
app (Usage: $50 a month to start, and an amount allowed over it in a busy month, none to start). The cap is
the club's setting, not the server's. What each thing costs is the server's:

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_PRICES` | Prices in cents, comma-separated, for any that differ from list prices: `text_segment` (a text segment with the carrier fee), `email` (one email), and per million tokens `jev_input`, `jev_output`, `haiku_input`, `haiku_output`, `sonnet_input`, `sonnet_output` (Ask openPadel for staff). Like `text_segment=0.83,email=0`. A hosted service sets its own; a club on its own keys can set what its providers charge it. | `text_segment=1.26,email=0.09,jev_input=4.2,jev_output=0,haiku_input=10,haiku_output=50,sonnet_input=200,sonnet_output=1000` |

A price counts from when it's set: what's already counted keeps the price it had. `openpadel usage --json` gives a
month's lines by kind (calls, tokens, segments, emails and cents to four places).

## Card payments (Stripe)

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_STRIPE_SECRET_KEY` | The Stripe secret key (`sk_test_...` until going live). Without it, a stand-in takes no money. A live key is refused unless `NODE_ENV=production`. | not set |
| `OPENPADEL_STRIPE_PUBLISHABLE_KEY` | The matching publishable key, for the card form. | not set |
| `OPENPADEL_STRIPE_WEBHOOK_SECRET` | Checks Stripe's webhook (`/webhooks/stripe`). Payments still settle without it, within a minute. | not set |
| `OPENPADEL_STRIPE_CONNECT` | `1` for the hosted service: the key is the platform's, and each club connects its own account. Self-hosted clubs leave it off. | off |

## Playtomic (only for a club that also uses it)

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_PLAYTOMIC_CLIENT_ID`, `OPENPADEL_PLAYTOMIC_SECRET`, `OPENPADEL_PLAYTOMIC_TENANT_ID` | Third Party API credentials; with all three, openPadel copies the club's bookings in, read-only. | not set |
| `OPENPADEL_MIRROR_EVERY_MINUTES` | How often it reads. | `10` |
| `OPENPADEL_MIRROR_DAYS_AHEAD` | How far ahead it reads every time (the near window). | `30` |
| `OPENPADEL_MIRROR_FAR_EVERY_HOURS` | How often each 30 days further ahead is read again, out to as far as members can book or openPadel has anything on a linked court (a year at most). One 30-day part is read after each near read. `0` reads only the near window. | `6` |
| `OPENPADEL_MIRROR_PAGE_SECONDS` | The wait between two pages of bookings, for every read. Playtomic's docs and its help pages give different limits, so it's careful. | `60` |

## Keys the server keeps

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_SECRET_KEY` | 32 random bytes (`head -c 32 /dev/urandom \| base64`) that seal the secrets openPadel keeps in the database: authenticator secrets, the push signing key, the vault. Made by `server-setup.sh` (and by the first update on an older server), never printed. Production won't start without it. | not set: secrets kept unsealed, development only |
| `OPENPADEL_SECRET_KEY_PREVIOUS` | The key before, while changing it: values sealed under it still open, and `openpadel rotate-key` (or the next start) moves them to the new one. Remove it after. | not set |
| `OPENPADEL_BACKUP_KEY` | 32 random bytes that seal the offsite copies. A key of its own, not the server's, so the backups still open after losing the server: keep a copy away from it (a password manager). | not set; `server-setup.sh` makes one |

## Backups

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_BACKUP_DIR` | Where the nightly dumps and their manifests go (kept 14 days), and where `openpadel doctor` looks. | `/var/backups/kumi` |
| `OPENPADEL_OFFSITE_ENDPOINT` | The S3-compatible storage's address: `https://<account>.r2.cloudflarestorage.com` (R2), `https://s3.<region>.backblazeb2.com` (B2), `https://<region>.digitaloceanspaces.com`, or AWS's. With the next three, every night's backup also goes offsite, sealed. See [accounts/offsite-backups.md](setup/accounts/offsite-backups.md). | not set: no offsite copy |
| `OPENPADEL_OFFSITE_BUCKET` | The bucket. | |
| `OPENPADEL_OFFSITE_ACCESS_KEY_ID`, `OPENPADEL_OFFSITE_SECRET_ACCESS_KEY` | A key for that bucket only, allowed to read, write and list, and to delete unless `OPENPADEL_OFFSITE_PRUNE=0`. | |
| `OPENPADEL_OFFSITE_PRUNE` | `0`: openPadel never deletes offsite copies; the storage's own lifecycle rules expire them, and its key needs no right to delete (so a stolen server can't wipe them). See [accounts/offsite-backups.md](setup/accounts/offsite-backups.md). | openPadel keeps 30 days and 12 months itself |
| `OPENPADEL_PITR` | `0`: no point-in-time backups on this server (`server-setup.sh` and updates leave Postgres and pgBackRest alone; in Docker the pitr service takes pgBackRest's settings away, so Postgres lets its log go). See [accounts/offsite-backups.md](setup/accounts/offsite-backups.md#going-back-to-a-minute-point-in-time-backups). | on |
| `OPENPADEL_PITR_HOST` | `1` on a server that many clubs share, where the host runs the point-in-time archive for all of them: `openpadel doctor` says so instead of checking it. | |
| `OPENPADEL_OFFSITE_REGION` | The region the storage signs for: `auto` for R2, the bucket's region elsewhere (`us-west-004`, `us-east-1`). | `auto` |
| `OPENPADEL_OFFSITE_PREFIX` | The folder in the bucket. | `kumi/` |
| `OPENPADEL_OFFSITE_PATH_STYLE` | `0` for addresses like `bucket.endpoint` instead of `endpoint/bucket`. | path style |
| `OPENPADEL_RESTORE_TEST_DATABASE_URL` | The scratch database the monthly restore test fills and empties. | the live server's `kumi_restore_test` |
| `OPENPADEL_PG_BIN` | Where Postgres 17's programs are: `pg_dump` and `pg_restore`, and for point-in-time backups `pg_ctl` and `psql`. | `/usr/lib/postgresql/17/bin`, else the `PATH` |

## The openpadel command

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_CLUB_FILE` | The `club.yaml` that `openpadel setup` reads when no file is named. | `club.yaml`; `/etc/kumi/club.yaml` on a server |
| `OPENPADEL_LANG` | The command's language (`en` or `es`); `--lang=` overrides it. | from `LANG` |
| `OPENPADEL_CALLER_DIR` | Set by the server's `openpadel` wrapper so relative paths work; not set by hand. | |

## Docker only (`.env`)

| Setting | What it does | Default |
|---|---|---|
| `OPENPADEL_HOST` | The members' app's host; staff use `staff.` in front of it. | required |
| `OPENPADEL_DB_PASSWORD` | The database password (`openssl rand -hex 24`). | required |
| `OPENPADEL_TAG` | Which built release the containers run; `deploy/docker/update.sh` sets it. | `local` |
| `OPENPADEL_HTTP_PORT`, `OPENPADEL_HTTPS_PORT` | The ports Caddy is reached on. | `80`, `443` |

The images set the rest themselves: the pitr image's `OPENPADEL_PITR_INLINE`, `OPENPADEL_PITR_PG_PATH`, `OPENPADEL_PITR_SCRATCH`,
`OPENPADEL_PG_BIN` and `OPENPADEL_BACKUP_DIR`, and compose.yaml's `OPENPADEL_PITR_PG_USER` (Postgres's superuser there, `kumi`).
They aren't set by hand.

## Development and tests only

| Setting | What it does |
|---|---|
| `OPENPADEL_CLUB_NAME`, `OPENPADEL_TIME_ZONE`, `OPENPADEL_OWNER_EMAIL`, `OPENPADEL_OWNER_NAME` | The demo club `apps/server/src/seed.ts` makes. |
| `KUMI_TEST_ADMIN_URL` | The Postgres the tests make their throwaway databases in. Default `postgres://postgres@127.0.0.1:55432/postgres`. |
