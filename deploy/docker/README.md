# Running Kumi with Docker

The other way to run Kumi on one server, for clubs that already use Docker. It runs the same thing
as [`deploy/server-setup.sh`](../server-setup.sh): Postgres 17, the server, Caddy with HTTPS and the
security headers, and a nightly backup. Any machine with Docker and Docker Compose and 2 GB of memory
will do. The DNS records are the same as in [the server guide](../../docs/setup/accounts/server.md).

```bash
git clone <this repository> kumi && cd kumi
cp deploy/docker/env.example .env       # fill in KUMI_HOST and KUMI_DB_PASSWORD (openssl rand -hex 24)
mkdir -p config backups
cp club.example.yaml config/club.yaml   # describe the club (docs/setup/README.md, step 4)
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

## Backups
Every night at 3:17 UTC the database is saved to `./backups/kumi-DATE.dump` and kept 14 days. Copy
them off the machine too. To restore one:
```bash
docker compose stop kumi
docker compose exec backup pg_restore --clean --if-exists --no-owner -h db -U kumi -d kumi /backups/kumi-DATE.dump
docker compose start kumi && docker compose exec kumi kumi doctor
```

## Updating
Read the release's notes in [`CHANGELOG.md`](../../CHANGELOG.md) first, then:
```bash
docker compose exec backup sh -c 'pg_dump -Fc -h db -U kumi -d kumi -f /backups/before-update.dump'
git pull && docker compose up -d --build
docker compose exec kumi kumi doctor
```
Database changes apply when the server starts. If something's wrong, go back to the previous
release (`git checkout v0.x.y && docker compose up -d --build`) and restore `before-update.dump`.
