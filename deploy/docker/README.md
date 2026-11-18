# Running openPadel with Docker

The other way to run openPadel on one server, for clubs that already use Docker. It runs the same thing
as [`deploy/server-setup.sh`](../server-setup.sh): Postgres 17, the server, Caddy with HTTPS and the
security headers, a nightly backup, and point-in-time backups to go back to any minute. Any machine with
Docker and Docker Compose and 2 GB of memory will do. The DNS records are the same as in
[the server guide](../../docs/setup/accounts/server.md).

```bash
git clone https://github.com/onchainexpat/openpadel && cd openpadel
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -1)"   # the newest release, not main
cp deploy/docker/env.example .env       # fill in KUMI_HOST and KUMI_DB_PASSWORD (openssl rand -hex 24)
chmod 600 .env                          # it will hold every key the club has: only you read it
mkdir -p config backups
cp club.example.yaml config/club.yaml   # describe the club (docs/setup/README.md, step 4)
git rev-parse --short HEAD > REVISION     # which commit this is, for /health and openpadel doctor
docker compose up -d --build
docker compose exec kumi openpadel setup plan
docker compose exec kumi openpadel setup apply
docker compose exec kumi openpadel doctor
```

- **Settings and keys** go in `.env` (never committed). After changing it:
  `docker compose up -d` (the server restarts with the new settings).
- **The openpadel command** runs inside the server: `docker compose exec kumi openpadel <command>`. Files it
  reads, like `club.yaml` or a member list to import, go in `./config`, which the server sees as
  `/etc/kumi`: `docker compose exec kumi openpadel import members /etc/kumi/members.csv`.
- **Sign-in codes**, until email is set up: `docker compose logs kumi | grep '\[mail'`.
- **Logs:** `docker compose logs -f kumi`.

## The database

The server connects as `kumi_app`, which owns the club's database and nothing more. `kumi` is the database's
superuser (the Postgres image makes it); it isn't used by the server, and its port isn't published, so reach it
only from inside: `docker compose exec db psql -U openpadel`. The pitr service (below) asks Postgres for its base
backups as `kumi`, over Postgres's own socket and in the `postgres` database only. A setup from before 0.1.0
connected as `kumi`; `update.sh` moves its database to `kumi_app` once, keeping a copy
(`backups/kumi-<time>-before-app-role.dump`).

The database lives in the `db` volume and its point-in-time archive in `pitr`: `docker compose down -v` deletes
both, with every member's data. `docker compose down` (without `-v`) keeps them.

## Keys

`.env` needs two keys, each 32 random bytes (`head -c 32 /dev/urandom | base64`): `KUMI_SECRET_KEY` seals
the secrets openPadel keeps in its database (the server won't start without it), and `KUMI_BACKUP_KEY` seals the
offsite copies. Keep a copy of both away from this machine, in a password manager. `update.sh` makes
`KUMI_SECRET_KEY` for a setup from before it existed.

## Backups
Every night at 3:17 on the club's clock (its time zone from setup, whatever the machine's or the containers'
clock says) the `backup` service runs `openpadel backup`: the database and a manifest of every table's rows go to `./backups/kumi-DATE.dump` and `.json` (named by the club's date and time, such as `kumi-2026-11-30T0317.dump`, so a backup run by hand never replaces the night's), kept 14 days, and, once offsite
backups are set up in `.env` ([docs/setup/accounts/offsite-backups.md](../../docs/setup/accounts/offsite-backups.md)),
a sealed copy goes to the club's own storage. On the 1st of each month at 4:17 it also runs `openpadel restore-test`,
which restores the newest backup into a scratch database and checks every table against its manifest. The
owner and managers hear once if any of it starts failing, and once more when it works again. The files hold every member's details, so only
root can read them.

```bash
docker compose exec backup openpadel backup          # tonight's backup now
docker compose exec backup openpadel offsite         # what's kept offsite
docker compose exec backup openpadel restore-test    # the monthly check, now
```

To restore one (everything since that backup is lost):
```bash
docker compose stop kumi
docker compose exec backup openpadel restore /var/backups/kumi/kumi-DATE.dump --yes   # or offsite:latest
docker compose start kumi && docker compose exec kumi openpadel doctor
```
The restore checks the file first and keeps a copy of the database as it was (`kumi-<time>-before-restore.dump`
in `./backups`); if it fails, that copy goes back in. If its message says the database couldn't be put back,
don't start `kumi`: restore the copy it names first.

## Going back to a minute

The nightly backup can only take the club back to 3:17 last night. The `pitr` service can take it back to
**any minute**: a mistake at 14:06 is undone by going back to 14:05. Postgres hands each finished piece of its log
to pgBackRest, at least once a minute while the club is busy, and the service takes a base backup every night at
3:37 on the club's clock (a full one weekly) and each time it starts. Two copies, as on a one-server install
([docs/setup/accounts/offsite-backups.md](../../docs/setup/accounts/offsite-backups.md#going-back-to-a-minute-point-in-time-backups)):
- **on this machine** (the `pitr` volume), any minute of the last 14 days: the quick one, for mistakes;
- **offsite**, once offsite backups are set up in `.env`, in the same bucket as the nightly copies
  (`kumi/pitr/<the cluster's id>/`), any minute of the last 30 days, sealed with a key made from
  `KUMI_BACKUP_KEY`. pgBackRest deletes its own old pieces, so with `KUMI_OFFSITE_PRUNE=0` (a key that can't
  delete) the offsite copy stays off and only this machine's runs; `openpadel doctor` says so.

```bash
docker compose exec pitr openpadel pitr status      # how far back it reaches, and whether it keeps up
docker compose stop kumi
docker compose exec pitr openpadel restore --to="2026-11-03 14:05" --yes   # the club's clock; everything since is lost
docker compose start kumi && docker compose exec kumi openpadel doctor
```
It recovers the archive into a scratch copy of its own (the live database isn't touched), stops at that minute,
takes the club's database from it, and restores that the usual way: a copy of the database as it is now is kept
first, in the service's own volume (`docker compose exec pitr ls /var/lib/kumi-pitr`). Messages the club had sent
since that minute aren't sent again, notices it had handled are held for `openpadel held`, and card charges and refunds
ask Stripe first, exactly as on a one-server install. `--repo=2` takes the offsite copy instead of this machine's.
If its message says the database couldn't be put back, don't start `kumi`: restore the copy it names first
(`docker compose exec pitr openpadel restore /var/lib/kumi-pitr/<file> --yes`).

Once a month (the 1st, 5:17 club time) a random minute of the last week is restored into scratch and checked: the
change made a minute before it is there, nothing from a minute after it is. `openpadel doctor` shows the result, and
`docker compose exec pitr openpadel pitr test` runs it now.

The service runs as the Postgres image's own `postgres` user, with the database's folder mounted read-only and
Postgres's socket, so pgBackRest can read the files and ask Postgres for its backups. The club's database itself it
opens as `kumi_app`, like the server, and a scratch copy's as whoever owns it there (never a superuser). The
server's container sees none of it: not the socket, the archive or pgBackRest's settings (which hold the offsite
key). `KUMI_PITR=0` in `.env`, then `docker compose up -d`, turns it off: Postgres lets its log go, as before.

**After losing the machine:** set it up again with the old `KUMI_BACKUP_KEY` and the offsite settings, restore
`offsite:latest` (above), and then, to go to a later minute than that night's backup, take it from the old
machine's archive, which is offsite in its own folder (`kumi/pitr/<id>/`; look in the bucket for the id):
`docker compose exec pitr openpadel restore --to="2026-11-03 14:05" --archive=<id> --yes`, with `kumi` stopped.
Everything that was waiting to go out is held then, since this machine can't know what the old one sent:
`openpadel held` lists it.

## Restoring a club's export

A club's export (the owner's "Download everything", or `docker compose exec backup openpadel export`, which
asks for a passphrase and writes the file to `./backups`) restores the same way, onto this openPadel or a newer
one: copy it into `./backups`, stop `kumi`, then
`docker compose exec backup openpadel restore /var/backups/kumi/kumi-export-<time>.kumi --yes` and type its
passphrase when asked.

## Updating
Read the release's notes in [`CHANGELOG.md`](../../CHANGELOG.md) first, then:
```bash
deploy/docker/update.sh vX.Y.Z          # a release tag, or a branch
```
It builds the new release's images beside the running ones (tagged by commit), takes a snapshot of the
database (`./backups/update-<old>-to-<new>-<time>.dump`), switches, and checks the server answers as the new
release. If it doesn't, the old images and the snapshot go back. A branch name means the branch's newest
commit. Postgres keeps running through an update unless its own image changed (its tag names the Postgres and
pgBackRest in it). To go back later (everything since the update is lost):
```bash
deploy/docker/update.sh rollback --yes
```

A checkout from before `update.sh` existed (no `deploy/docker/update.sh` in it) runs the release's own copy:
```bash
git fetch && bash <(git show origin/main:deploy/docker/update.sh) main
```
