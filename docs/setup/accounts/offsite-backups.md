# Offsite backups: Cloudflare R2 or Backblaze B2

**What it's for:** a copy of every night's backup somewhere other than the club's server. The server
keeps 14 days of backups on its own disk, which don't survive losing the server. With this set up, each
night's backup also goes to storage the club owns, sealed with the club's backup key, and openPadel keeps 30
daily copies and 12 monthly ones there. Once a month openPadel restores the newest one into a scratch database
and checks every table, so the club knows the backups really work.
**Who does what:** the owner creates the storage account, the bucket and its key, and types the key
into the server. The agent sets up the rest and checks it. The agent never sees the keys.
**Time and cost:** 20 minutes. A club's nightly backup is a few MB, so 30 daily and 12 monthly copies fit
easily in the free allowance both offer (about 10 GB in 2026; check their pricing pages). R2 charges
nothing to download; B2 charges a little past a free daily allowance. Either is fine.
**`openpadel doctor` checks:** `offsite`, `restore_test`, `backups`.

## Before either: the backup key

Offsite copies are sealed with `KUMI_BACKUP_KEY`, a key of its own, not the server's. `server-setup.sh`
makes one in `/etc/kumi/kumi.env`; a server set up before it needs one made (the agent runs this; it
prints nothing):

```bash
grep -q '^KUMI_BACKUP_KEY=.' /etc/kumi/kumi.env || echo "KUMI_BACKUP_KEY=$(head -c 32 /dev/urandom | base64)" >> /etc/kumi/kumi.env
```

**Owner: keep a copy of it away from the server**, in a password manager. Without it, the offsite
copies can't be opened, and the copy on the server is lost with the server. Look at it yourself, in your
own terminal, never through the chat:

```bash
sudo grep -E '^KUMI_(BACKUP|SECRET)_KEY=' /etc/kumi/kumi.env
```

Keep `KUMI_SECRET_KEY` there too. It seals the few secrets inside the database (the vault, staff
authenticators, the push key). A restore without it brings back everything else, and those few need
setting up again.

Keep the five `KUMI_OFFSITE_*` settings there too, once you've made them below (R2 and B2 show the
secret only once). Without them you'd make a new key for the bucket before you can restore.

## Cloudflare R2

1. **Owner: turn R2 on** in the Cloudflare dashboard (R2 Object Storage). Cloudflare asks for a payment
   method even for the free allowance.
2. **Owner: create a bucket**, for example `yourclub-kumi-backups`. Location: automatic. Leave public
   access off.
3. **Owner: create a key for that bucket only:** R2, then Manage API tokens, then Create API token.
   Permissions: **Object Read & Write**. Apply to: **that bucket only**. Cloudflare shows the
   **Access Key ID**, the **Secret Access Key** (once) and the endpoint,
   `https://<account id>.r2.cloudflarestorage.com`.
4. **Owner: add them to the server's settings**, typed in, never through the chat:
   ```bash
   sudo nano /etc/kumi/kumi.env
   ```
   ```
   KUMI_OFFSITE_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   KUMI_OFFSITE_BUCKET=yourclub-kumi-backups
   KUMI_OFFSITE_ACCESS_KEY_ID=...
   KUMI_OFFSITE_SECRET_ACCESS_KEY=...
   KUMI_OFFSITE_REGION=auto
   ```
5. **Agent: check it** (below).

## Backblaze B2

1. **Owner: create a B2 account** at backblaze.com (B2 Cloud Storage).
2. **Owner: create a bucket**, for example `yourclub-kumi-backups`: **private**, Object Lock **off**
   (openPadel deletes copies past 30 days and 12 months; a lock would stop it). Note the bucket's endpoint,
   such as `s3.us-west-004.backblazeb2.com`.
3. **Owner: set the bucket's lifecycle to "Keep only the last version of the file".** B2 otherwise keeps
   every deleted copy as a hidden old version, still stored and billed.
4. **Owner: create a key for that bucket only:** Application Keys, then Add a New Application Key.
   Allow access to: **that bucket**. Type: **Read and Write**. B2 shows the **keyID** and the
   **applicationKey** (once).
5. **Owner: add them to the server's settings**, typed in, never through the chat:
   ```
   KUMI_OFFSITE_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   KUMI_OFFSITE_BUCKET=yourclub-kumi-backups
   KUMI_OFFSITE_ACCESS_KEY_ID=<keyID>
   KUMI_OFFSITE_SECRET_ACCESS_KEY=<applicationKey>
   KUMI_OFFSITE_REGION=us-west-004
   ```
6. **Agent: check it** (below).

## Agent: check it

```bash
sudo systemctl restart kumi        # not needed for the backup itself, but keeps everything on the same settings
openpadel backup                        # tonight's backup now, and its offsite copy
openpadel offsite                       # what's there: daily/kumi-<date>T<time>.dump.enc and .json.enc, monthly/kumi-<month>...
openpadel restore-test                  # restore the newest offsite copy into a scratch database and check it
openpadel doctor                        # offsite and restore_test should be ok
```

With Docker: `docker compose up -d` after editing `.env`, then the same commands as
`docker compose exec backup kumi ...`.

If `openpadel backup` says `HTTP 403 SignatureDoesNotMatch` or `AccessDenied`, the key or its bucket is
wrong; `NoSuchBucket`, the bucket name or the endpoint. The error is said once to the owner and managers
by email too, and again only after it has worked in between.

## Optional: so a stolen server can't delete the offsite copies

By default openPadel deletes copies past 30 days (and monthly ones past 12 months) itself, so the key on the
server can delete. Someone who takes over the server could then delete the offsite copies too. To stop
that, let the storage expire old copies on its own schedule, protect them from deletion, and tell openPadel
not to delete anything:

```
KUMI_OFFSITE_PRUNE=0
```

openPadel never overwrites an offsite copy (every night's has its own name, and a month's copy is written once),
so none of this gets in its way.

**Cloudflare R2.** In the bucket's **Settings**:
1. **Object Lifecycle Rules**, Add rule: prefix `kumi/daily/`, delete objects after **31 days**. A second
   rule: prefix `kumi/monthly/`, delete after **366 days**.
2. **Bucket lock rules**, Add rule: prefix `kumi/daily/`, retain for **30 days**; a second: prefix
   `kumi/monthly/`, retain for **365 days**. Until then nothing can delete or overwrite a copy, a stolen key
   included. R2's key types don't include one that can write but not delete (openPadel needs **Object Read &
   Write**), so on R2 the bucket lock is what protects the copies.

**Backblaze B2.**
1. In the bucket's **Lifecycle Settings**, instead of "Keep only the last version", use custom rules:
   prefix `kumi/daily/`, hide files **31 days** after uploading and delete them **7 days** after hiding; a
   second rule for `kumi/monthly/` with **366** and **7**.
2. Make the server's key without the right to delete. The web page's key types don't offer that, so the
   owner uses B2's command-line tool:
   ```bash
   b2 key create --bucket yourclub-kumi-backups kumi-server listBuckets,listFiles,readFiles,writeFiles
   ```
   and puts that key in `/etc/kumi/kumi.env` in place of the old one.
3. For more protection, turn on the bucket's Object Lock with a default retention of 30 days.

`openpadel doctor` says which way the server works.

## Going back to a minute (point-in-time backups)

The nightly backup can only take the club back to 3:17 last night. Point-in-time backups can take it back to
**any minute**: a mistake at 14:06 is undone by going back to 14:05. The target: **lose at most about a minute**
of the club's changes, and **be back within an hour** (the monthly test measures how long a restore takes, and
`openpadel doctor` shows it; a small club's takes seconds).

How it works: Postgres writes every change to its log first, and pgBackRest (the PostgreSQL community's backup
tool, from the same repository as Postgres) copies each finished piece of that log away at least once a minute
while the club is busy, and takes a base backup every night at 3:37 club time (a full one weekly). Two copies:
- **on the server** (`/var/lib/pgbackrest`), any minute of the last 14 days: the quick one, for mistakes;
- **offsite**, in the same bucket as the nightly copies (`kumi/pitr/<the cluster's id>/`), any minute of the
  last 30 days, sealed with a key made from `KUMI_BACKUP_KEY`, so the key in the password manager opens it too.
  pgBackRest deletes its own old pieces, so with `KUMI_OFFSITE_PRUNE=0` (a key that can't delete) the offsite
  copy stays off and only the server's runs; `openpadel doctor` says so.

`server-setup.sh` turns it on (it starts Postgres again once, to archive); the next update (or the first ship)
sets pgBackRest up and takes the first base backup. On a server set up before this, run `server-setup.sh` again
once. `KUMI_PITR=0`, in the environment of `server-setup.sh` and in `/etc/kumi/kumi.env`, leaves it off.

**With Docker**, the `pitr` service does all of this beside Postgres, with the same two copies, the same test and the
same checks; going back is `docker compose exec pitr openpadel restore --to=... --yes` with `kumi` stopped
([deploy/docker/README.md](../../../deploy/docker/README.md#going-back-to-a-minute)).

To go back:
```bash
openpadel pitr status                                   # how far back it reaches, and whether it's keeping up
sudo openpadel restore --to="2026-11-03 14:05" --yes    # the club's clock; everything since is lost
```
It recovers the archive into a scratch copy of its own (the live database isn't touched), stops at that minute,
takes the club's database from it, and restores that the usual way: a copy of the database as it is now is made
first. Messages the club had already sent since that minute aren't sent again (notices it had handled are held:
`openpadel held` lists them, and `openpadel held send --yes` or `openpadel held drop --yes` decides), and card charges and
refunds ask Stripe first, so none is made twice. A reminder or notice the jobs make again, because the record that
it was said is newer than that minute, doesn't go twice either: for a week, an email, text or push with exactly
the words, link and person of one sent before the restore is marked as sent then, instead of going again.
What was taken away on request since that minute stays away too: an account deleted is deleted again (the same
way, at once), a chat message taken back or hidden by the club stays so, an authenticator removed or replaced stays
removed, a sign-in, passkey, phone's push, calendar link, assistant or recovery code ended or used stays ended, and a
no to texts, email and club news given since is kept (a yes only for the number or address it was given for), a
sign-in address, phone number, family card or phone's notifications taken away stays away, club credit paid out or
spent stays gone (nobody's credit is more than was really left), and a gift card redeemed or voided stays so. The same goes for an
update's snapshot going back, and for an export put back on the server the club ran on before.

`openpadel restore` lists each account it deletes again, with who had deleted it. Someone who deleted their own account
is always deleted again. One the club had deleted can be kept: run the restore with `--keep=<id>` (several, comma
separated) or `--keep-staff-deleted` for all of them. An account deleted again has its bookings, places and weekly
court cancelled by the club's rules first (cards refunded, money paid at the desk left there for the staff, who hear
once); the club's last owner keeps the owner role until another owner is added, and the restore says so.

If the database being replaced can't be read (the old server is gone, or it's another club's), the restore can't
know what was taken away after the copy: it says so, and deletes again the accounts listed in the newest backup on
this server (every nightly backup's manifest lists the accounts deleted by then). Anything taken away after that
backup is back, and has to be done again by hand. A rollback to a release from before 0.3.0 can't queue deleted
accounts: it lists them, by id and name, in `deleted-again-by-hand-<time>.txt` in the backups folder (readable by
root only), to delete again in the staff app.

Once a month (the 1st, 5:17 club time) a random minute of the last week is restored into scratch and checked: the
change made a minute before it is there, nothing from a minute after it is. `openpadel doctor` shows the result, and
`sudo openpadel pitr test` runs it now.

These jobs run as the postgres user, whose archive it is, but they never open the club's database as Postgres's
superuser: they sign in as the `kumi` role (which owns it), and in the scratch copy as whoever owns it there (never
a superuser), with only Postgres's own catalog on the search path. A superuser session in a database the `kumi`
role owns would run whatever that role had left in it (a trigger, a function) with the superuser's rights.
`server-setup.sh` and every update let the postgres user sign in as `kumi`, to the `kumi` database only, through
openPadel's own `pg_hba` and `pg_ident` files (`kumi_hba.conf`, `kumi_ident.conf` beside Postgres's, which include
them; Postgres 16 or later). The dump taken from the scratch copy is made under umask 077, in a folder only the
postgres user can open.

## Restoring after losing the server

1. Set up a new server with `server-setup.sh` and ship the code (see [server.md](server.md)).
2. **Owner:** replace the new server's `KUMI_BACKUP_KEY` line with the one from the password manager,
   and add the five `KUMI_OFFSITE_*` settings, in `/etc/kumi/kumi.env`. If you kept the old `KUMI_SECRET_KEY`, add it as
   `KUMI_SECRET_KEY_PREVIOUS` (the new server made its own `KUMI_SECRET_KEY`).
3. `sudo openpadel restore offsite:latest --yes` (it stops the server, restores, and starts it again), then
   `openpadel rotate-key` and `openpadel doctor`.
4. To go to a later minute than last night's backup: the old server's point-in-time archive is offsite, in its
   own folder `kumi/pitr/<id>/` (look in the bucket for the id). Once the new server is set up and running,
   `sudo openpadel restore --to="2026-11-03 14:05" --archive=<id> --yes`. Everything that was waiting to go out is held
   then, since this server can't know what the old one sent: `openpadel held` lists it.
