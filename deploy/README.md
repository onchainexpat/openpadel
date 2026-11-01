# Running Kumi on one server

For a club running Kumi itself, and for Kumi's own trial server. One small Ubuntu 24.04 server (2 GB of
memory is plenty for a club) runs Postgres 17, the API, both apps and HTTPS.

```bash
# once, on the new server, as root: KUMI_HOST is the members' app; staff use staff.<KUMI_HOST>
KUMI_HOST=app.yourclub.com bash server-setup.sh
# from a checkout, each time you update:
deploy/ship.sh root@your.server.ip
```

- **HTTPS** comes from Caddy and Let's Encrypt, for `KUMI_HOST` and `staff.KUMI_HOST`. Point both at the
  server in DNS first. Without a domain yet, `<ip-with-dashes>.sslip.io` works for a trial.
- **Settings** live in `/etc/kumi/kumi.env` (Stripe, Resend, offsite backups): edit, then
  `systemctl restart kumi`. Never commit them. Every setting is in [docs/settings.md](../docs/settings.md).
- **Practice mode** (`KUMI_PRACTICE=1`, the default here) sends real email only to `KUMI_MAIL_TEST_TO`.
  Remove it when the club switches over.
- **Logs:** `journalctl -u kumi -f`. Until email is set up, sign-in codes are in that log.

## Keys

`server-setup.sh` makes two keys in `/etc/kumi/kumi.env` and never prints them:

- `KUMI_SECRET_KEY` seals the secrets Kumi keeps in its database (staff authenticators, the push signing
  key, the owner's vault) with AES-256-GCM. The server won't start in production without it. A server set up
  before it existed gets one on its next update, and its secrets are sealed as it starts.
- `KUMI_BACKUP_KEY` seals the offsite copies of the backups. It's separate on purpose: the owner keeps a copy
  of it (and of `KUMI_SECRET_KEY`) away from the server, in a password manager, so the backups still open
  after losing the server.

To change `KUMI_SECRET_KEY`: put the old one in `KUMI_SECRET_KEY_PREVIOUS`, a new one in `KUMI_SECRET_KEY`,
restart, run `kumi rotate-key` (it says how many it moved), then remove the old one.

## Updating, and going back

`deploy/ship.sh` sends the committed code to the server, where the release's own `deploy/release.sh`:

1. installs and builds it beside the running release, in `/opt/kumi/releases/<commit>` (members notice
   nothing yet);
2. takes a snapshot of the database, `/var/backups/kumi/update-<old>-to-<new>-<time>.dump`;
3. switches `/opt/kumi/app` to the new release and restarts (database changes apply as it starts);
4. checks it answers as the new release (`/health` names its commit), that `/club` answers, and that both
   apps are built.

If any of that fails, it puts the old release back and restores the snapshot, and says so. The last 3
releases and the last 3 update snapshots are kept.

```bash
sudo kumi releases          # which release runs, which is kept, and the snapshot
sudo kumi rollback          # explains what going back loses
sudo kumi rollback --yes    # the previous release, and the database as it was just before the last update
sudo kumi update kumi-v0.2.0.tar   # from a release file instead of ship.sh (git archive --format=tar v0.2.0 > kumi-v0.2.0.tar)
```

Going back loses everything since the update (bookings, payments, sign-ups), which is why it asks for
`--yes`. A server set up before releases were kept side by side moves its running code into
`/opt/kumi/releases` on its first update.

## Backups

- **Every night at 3:17** (`kumi-backup.timer`): `kumi backup` dumps the database with a manifest of every
  table's rows, both from one snapshot, to `/var/backups/kumi/kumi-<date>.dump` and `.json`, kept 14 days.
- **Offsite**, once it's set up ([docs/setup/accounts/offsite-backups.md](../docs/setup/accounts/offsite-backups.md)):
  the same night's dump goes to the club's own S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3,
  DigitalOcean Spaces), sealed with `KUMI_BACKUP_KEY`. 30 daily and 12 monthly copies are kept. One upload
  is at most 512 MB, far above a club's database (a few MB).
- **Once a month** (`kumi-restore-test.timer`, the 1st at 4:17): `kumi restore-test` restores the newest
  backup (offsite if set up) into the `kumi_restore_test` database, checks every table and row against
  its manifest, and empties it again.
- If the backup, its offsite copy or the restore test starts failing, the owner and managers are told
  once, by email and in the staff app's alerts; again only after it has worked in between.

```bash
kumi backup                                 # tonight's backup now
kumi offsite                                # what's kept offsite
kumi restore-test                           # the monthly check, now
sudo kumi restore /var/backups/kumi/kumi-2026-11-30.dump --yes   # replace the database with a backup
sudo kumi restore offsite:latest --yes      # or the newest offsite copy
```

`kumi restore` stops the server, empties the database, restores, and starts it again. It asks for `--yes`
because everything since that backup is lost.

## Health

- `/health` is cheap and open: `{"ok":true,"version":"0.1.0","revision":"<commit>"}`.
- `/health/deep` answers only on the server itself (`curl -s 127.0.0.1:8790/health/deep`) or for a
  signed-in owner or manager: the database, how far behind the outbox is, the last backup, its offsite copy
  and restore test, and disk space. It answers 503 when something needs a look, and names it in `problems`.
- `kumi doctor` checks all of that too, with the next step for anything that isn't fine.
