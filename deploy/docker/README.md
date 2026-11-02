# Running Kumi with Docker

The other way to run Kumi on one server, for clubs that already use Docker. It runs the same thing
as [`deploy/server-setup.sh`](../server-setup.sh): Postgres 17, the server, Caddy with HTTPS and the
security headers, and a nightly backup. Any machine with Docker and Docker Compose and 2 GB of memory
will do. The DNS records are the same as in [the server guide](../../docs/setup/accounts/server.md).

```bash
git clone https://github.com/<your-org>/kumi && cd kumi && git checkout v0.1.0   # the release, not main
cp deploy/docker/env.example .env       # fill in KUMI_HOST and KUMI_DB_PASSWORD (openssl rand -hex 24)
mkdir -p config backups
cp club.example.yaml config/club.yaml   # describe the club (docs/setup/README.md, step 4)
git rev-parse --short HEAD > REVISION     # which commit this is, for /health and kumi doctor
docker compose up -d --build
docker compose exec kumi kumi setup plan
docker compose exec kumi kumi setup apply
docker compose exec kumi kumi doctor
```

- **Settings and keys** go in `.env` (never committed). After changing it:
  `docker compose up -d` (the server restarts with the new settings).
- **The kumi command** runs inside the server: `docker compose exec kumi kumi <command>`. Files it
  reads, like `club.yaml` or a member list to import, go in `./config`, which the server sees as
  `/etc/kumi`: `docker compose exec kumi kumi import members /etc/kumi/members.csv`.
- **Sign-in codes**, until email is set up: `docker compose logs kumi | grep '\[mail'`.
- **Logs:** `docker compose logs -f kumi`.

## Keys

`.env` needs two keys, each 32 random bytes (`head -c 32 /dev/urandom | base64`): `KUMI_SECRET_KEY` seals
the secrets Kumi keeps in its database (the server won't start without it), and `KUMI_BACKUP_KEY` seals the
offsite copies. Keep a copy of both away from this machine, in a password manager. `update.sh` makes
`KUMI_SECRET_KEY` for a setup from before it existed.

## Backups
Every night at 3:17 on the club's clock (its time zone from setup, whatever the machine's or the containers'
clock says) the `backup` service runs `kumi backup`: the database and a manifest of every table's rows go to `./backups/kumi-DATE.dump` and `.json` (named by the club's date and time, such as `kumi-2026-11-30T0317.dump`, so a backup run by hand never replaces the night's), kept 14 days, and, once offsite
backups are set up in `.env` ([docs/setup/accounts/offsite-backups.md](../../docs/setup/accounts/offsite-backups.md)),
a sealed copy goes to the club's own storage. On the 1st of each month at 4:17 it also runs `kumi restore-test`,
which restores the newest backup into a scratch database and checks every table against its manifest. The
owner and managers hear once if any of it starts failing, and once more when it works again. The files hold every member's details, so only
root can read them.

```bash
docker compose exec backup kumi backup          # tonight's backup now
docker compose exec backup kumi offsite         # what's kept offsite
docker compose exec backup kumi restore-test    # the monthly check, now
```

To restore one (everything since that backup is lost):
```bash
docker compose stop kumi
docker compose exec backup kumi restore /var/backups/kumi/kumi-DATE.dump --yes   # or offsite:latest
docker compose start kumi && docker compose exec kumi kumi doctor
```
The restore checks the file first and keeps a copy of the database as it was (`kumi-<time>-before-restore.dump`
in `./backups`); if it fails, that copy goes back in. If its message says the database couldn't be put back,
don't start `kumi`: restore the copy it names first.

## Updating
Read the release's notes in [`CHANGELOG.md`](../../CHANGELOG.md) first, then:
```bash
deploy/docker/update.sh v0.2.0          # a release tag, or a branch
```
It builds the new release's images beside the running ones (tagged by commit), takes a snapshot of the
database (`./backups/update-<old>-to-<new>-<time>.dump`), switches, and checks the server answers as the new
release. If it doesn't, the old images and the snapshot go back. A branch name means the branch's newest
commit. To go back later (everything since the update is lost):
```bash
deploy/docker/update.sh rollback --yes
```

A checkout from before `update.sh` existed (no `deploy/docker/update.sh` in it) runs the release's own copy:
```bash
git fetch && bash <(git show origin/main:deploy/docker/update.sh) main
```
