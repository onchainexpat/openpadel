#!/usr/bin/env bash
# One server from a fresh Ubuntu 24.04: a firewall, Postgres 17, Node 24, Caddy for HTTPS, Kumi as a
# service and nightly backups. Run once as root (safe to run again); then ship the code with ship.sh.
set -euo pipefail
: "${KUMI_HOST:?set KUMI_HOST to the host for the members app; staff use staff.KUMI_HOST}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confold upgrade
apt-get install -yq ufw curl gnupg jq xz-utils ca-certificates unattended-upgrades

# Only SSH and the web in.
ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable

# Postgres 17 from the PostgreSQL project's own repository (Ubuntu ships 16).
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list
# Caddy, for HTTPS certificates that renew themselves (its apt list names the signing key's path).
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -q
apt-get install -yq postgresql-17 caddy

# Node 24: the newest release at least two weeks old (house rule 9), checked against nodejs.org's sums.
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  cutoff=$(date -u -d '14 days ago' +%F)
  v=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r --arg c "$cutoff" '[.[] | select(.version | startswith("v24.")) | select(.date <= $c)][0].version')
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt" | grep " node-$v-linux-x64.tar.xz\$" | sha256sum -c -
  tar -xJf "node-$v-linux-x64.tar.xz" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
  rm "node-$v-linux-x64.tar.xz"
fi
node --version

# Point-in-time backups (apps/server/src/pitr.ts): Postgres hands each finished piece of its write-ahead log to
# pgBackRest, at least once a minute while the club is busy, from the PostgreSQL project's own repository (the same
# one Postgres comes from). archive_mode is read only when Postgres starts, so it's set here, never by an update;
# pgBackRest's own settings are written once the code is here (the system files below, and every update), and until
# then each piece is let go, as before. KUMI_PITR=0 leaves it all off.
if [ "${KUMI_PITR:-1}" != 0 ]; then
  apt-get install -yq pgbackrest
  install -d -m 750 -o postgres -g postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest
  install -d -m 755 /usr/local/lib/kumi /etc/pgbackrest
  # pgBackRest's checks (and its backups) want "pgbackrest" in archive_command, so the wrapper's name has it.
  cat > /usr/local/lib/kumi/pgbackrest-archive-push <<'SH'
#!/bin/sh
# Postgres's archive_command (server-setup.sh): each finished piece of the write-ahead log goes to pgBackRest once
# it's set up (/etc/pgbackrest/pgbackrest.conf); until then it's let go, as without point-in-time backups.
[ -f /etc/pgbackrest/pgbackrest.conf ] || exit 0
exec pgbackrest --stanza=kumi archive-push "$1"
SH
  chmod 755 /usr/local/lib/kumi/pgbackrest-archive-push
  pitr_pg=/etc/postgresql/17/main/conf.d/kumi-pitr.conf
  pitr_want=$(printf '%s\n' "# Kumi's point-in-time backups (deploy/server-setup.sh)" "archive_mode = on" "archive_command = '/usr/local/lib/kumi/pgbackrest-archive-push %p'" "archive_timeout = 60")
  if [ "$(cat "$pitr_pg" 2>/dev/null)" != "$pitr_want" ]; then
    # archive_mode needs Postgres to start again; once it's on, a new archive_command only needs a reload.
    if grep -q '^archive_mode = on$' "$pitr_pg" 2>/dev/null; then pitr_apply=reload; else pitr_apply=restart; fi
    printf '%s\n' "$pitr_want" > "$pitr_pg"
    systemctl "$pitr_apply" postgresql
  fi
  rm -f /usr/local/lib/kumi/archive-wal   # its name before (pgBackRest refused it)
fi

# The kumi user runs the server and owns its database (it signs in to Postgres as itself, over the local socket).
# Its home is /var/lib/kumi; the code in /opt/kumi is root's, which kumi reads but can't change.
id kumi >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/kumi --shell /usr/sbin/nologin kumi
install -d -m 700 -o kumi -g kumi /var/lib/kumi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'kumi'" | grep -q 1 || sudo -u postgres createuser kumi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'kumi'" | grep -q 1 || sudo -u postgres createdb -O kumi kumi

install -d -m 750 -o root -g kumi /etc/kumi
if [ ! -f /etc/kumi/kumi.env ]; then
  cat > /etc/kumi/kumi.env <<ENV
NODE_ENV=production
KUMI_PRACTICE=1
PORT=8790
DATABASE_URL=postgresql://kumi@/kumi?host=/var/run/postgresql
KUMI_PUBLIC_URL=https://staff.$KUMI_HOST
KUMI_MEMBER_URL=https://$KUMI_HOST
KUMI_CLUB_FILE=/etc/kumi/club.yaml
# The server's key for the secrets it keeps (sealed.ts), and the key offsite backups are sealed with. Never
# printed. Keep a copy of KUMI_BACKUP_KEY away from this server (a password manager): without it, the offsite
# copies can't be opened, and it's lost with the server.
KUMI_SECRET_KEY=$(head -c 32 /dev/urandom | base64)
KUMI_BACKUP_KEY=$(head -c 32 /dev/urandom | base64)
# Offsite backups (docs/setup/accounts/offsite-backups.md):
# KUMI_OFFSITE_ENDPOINT=  KUMI_OFFSITE_BUCKET=  KUMI_OFFSITE_ACCESS_KEY_ID=  KUMI_OFFSITE_SECRET_ACCESS_KEY=  KUMI_OFFSITE_REGION=auto
# KUMI_RESEND_API_KEY=  KUMI_MAIL_FROM=  KUMI_MAIL_TEST_TO=
# KUMI_TWILIO_ACCOUNT_SID=  KUMI_TWILIO_AUTH_TOKEN=  KUMI_TWILIO_MESSAGING_SERVICE_SID=  KUMI_SMS_TEST_TO=
# Ask the club (docs/setup/accounts/ask-the-club.md): KUMI_TYPESAFE_API_KEY=  KUMI_ANTHROPIC_API_KEY=
# KUMI_STRIPE_SECRET_KEY=  KUMI_STRIPE_PUBLISHABLE_KEY=  KUMI_STRIPE_WEBHOOK_SECRET=  KUMI_STRIPE_CONNECT=
# KUMI_PLAYTOMIC_CLIENT_ID=  KUMI_PLAYTOMIC_SECRET=  KUMI_PLAYTOMIC_TENANT_ID=
ENV
  chown root:kumi /etc/kumi/kumi.env; chmod 640 /etc/kumi/kumi.env
fi

cat > /etc/systemd/system/kumi.service <<'UNIT'
[Unit]
Description=Kumi
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=kumi
WorkingDirectory=/opt/kumi/app
EnvironmentFile=/etc/kumi/kumi.env
ExecStart=/usr/local/bin/node apps/server/src/main.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT


# The API answers on these paths; everything else is one of the two apps.
api='/auth/* /me /me/* /my/* /club /actions /actions/* /runs /runs/* /changes /changes/* /staff/* /oauth/* /.well-known/* /mcp /mcp/* /health /health/* /open-programs /payments/* /webhooks/* /manifest/* /availability /booking-options /quote /bookings/* /membership-plans /open-matches /matches/* /public /public/* /calendar/* /unsubscribe/*'
# The apps' own security headers (the API sets its own): scripts only from here and Stripe (its card
# form), never framed by another site, and HTTPS remembered for a year.
csp="default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data: https://*.stripe.com; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
# --- caddy sites (the same in server-setup.sh and release.sh) ---
# One of Kumi's sites: $1 its address, $2 the app (member or manager), $3 where the server listens (127.0.0.1:PORT,
# or unix/ and KUMI_SOCKET's path) and $4 the link to the running release. The API's paths ($api) go to the server;
# everything else is the app, with the apps' security headers ($csp).
site() {
  cat <<SITE
$1 {
	encode zstd gzip
	@api path $api
	handle @api {
		reverse_proxy $3
	}
	handle {
		header {
			Content-Security-Policy "$csp"
			Strict-Transport-Security "max-age=31536000"
			X-Content-Type-Options nosniff
			X-Frame-Options DENY
			Referrer-Policy strict-origin-when-cross-origin
			Permissions-Policy "camera=(), microphone=(), geolocation=()"
		}
		root * $4/apps/$2/dist
		try_files {path} /index.html
		file_server
	}
}
SITE
}
# Caddy's whole config: the members' site at $1 and the staff's at $2, the server at $3, the running release at $4.
kumi_sites() {
  echo "# Kumi's sites. Each update writes this file again from its own release (deploy/release.sh), unless it has"
  echo "# been changed by hand: then it's left as it is, and paths a new release answers on need adding here."
  site "$1" member "$3" "$4"
  site "$2" manager "$3" "$4"
}
# --- end caddy sites ---
# Where the server listens, as its settings say (listen.ts): its port on this machine, or its unix socket.
port=$(sed -n 's/^PORT=//p' /etc/kumi/kumi.env | tail -1); sock=$(sed -n 's/^KUMI_SOCKET=//p' /etc/kumi/kumi.env | tail -1)
if [ -n "$sock" ]; then upstream="unix/$sock"; else upstream="127.0.0.1:${port:-8790}"; fi
kumi_sites "$KUMI_HOST" "staff.$KUMI_HOST" "$upstream" /opt/kumi/app > /etc/caddy/Caddyfile
# Caddy serves the built apps from /opt/kumi, which everyone can read. It isn't in the kumi group, so it can't read
# the settings file (a server set up before 0.1.0 had it there: take it out).
if id -nG caddy | tr ' ' '\n' | grep -qx kumi; then gpasswd -d caddy kumi >/dev/null; systemctl restart caddy; fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

# Releases are kept side by side (release.sh); /opt/kumi/app links to the running one. All of it is root's.
install -d -m 755 -o root -g root /opt/kumi /opt/kumi/releases
# --- system files (the same in server-setup.sh and release.sh) ---
cat > /usr/local/bin/kumi <<'SH'
#!/bin/sh
# The kumi command, as the kumi user with the server's settings. Updating, going back and restoring stop and
# start the server, so those run as root (sudo kumi ...).
root() { [ "$(id -u)" = 0 ] || { echo "kumi $1 needs root: sudo kumi $1 ..." >&2; exit 1; }; }
case "${1:-}" in
  update)
    root update; shift; f="${1:?usage: kumi update <release.tar>}"; t=$(mktemp -d)
    tar -xOf "$f" deploy/release.sh > "$t/release.sh" || { echo "kumi: $f isn't a Kumi release" >&2; exit 1; }
    bash "$t/release.sh" update "$@"; rc=$?; rm -rf "$t"; exit $rc;;
  rollback|releases)
    # Root's own copy of release.sh, from the last update's release file: never one the kumi user could change.
    root "$1"; [ "$1" = releases ] && set -- status
    [ -f /usr/local/lib/kumi/release.sh ] || { echo "kumi: no release installed yet (ship one with deploy/ship.sh)" >&2; exit 1; }
    exec bash /usr/local/lib/kumi/release.sh "$@";;
  restore)
    root restore; extract=""
    case " $* " in *" --to"*)
      # A minute, not a file (pitr.ts): the database as it was then, from the point-in-time archive, as the postgres
      # user (whose archive it is), into a file; then that file is restored the usual safe way, below.
      shift; f=/var/lib/postgresql/kumi-pitr-$(date -u +%Y%m%dT%H%M%SZ).dump
      (cd /opt/kumi/app && runuser -u postgres -- env DATABASE_URL='postgresql://postgres@/kumi?host=/var/run/postgresql' /usr/local/bin/node apps/server/src/cli.ts pitr extract --out="$f" "$@") || { rm -f "$f"; exit 2; }
      extract=/var/backups/kumi/$(basename "$f"); install -m 600 -o kumi -g kumi "$f" "$extract"; rm -f "$f"
      set -- restore "$extract" --yes;;
    esac
    systemctl stop kumi
    cd /opt/kumi/app && sudo -u kumi KUMI_CALLER_DIR="$OLDPWD" sh -c 'set -a; . /etc/kumi/kumi.env; set +a; exec /usr/local/bin/node apps/server/src/cli.ts "$@"' kumi "$@"
    # 4: the restore failed and the database may be empty: the server stays stopped (starting would set up an
    # empty club). Any other outcome left the database whole (restored, put back, or never touched).
    rc=$?; if [ "$rc" = 4 ]; then echo "kumi: the server stays stopped; see above" >&2; else systemctl start kumi; fi
    # The copy taken from the archive has done its job (or wasn't used): gone, unless the database may be empty, when
    # it's one of the ways back.
    if [ -n "$extract" ]; then if [ "$rc" = 4 ]; then echo "kumi: the database as it was at that minute is in $extract" >&2; else rm -f "$extract"; fi; fi
    exit $rc;;
  pitr)
    # The archive is the postgres user's: its jobs run as that user (kumi pitr status and conf don't need to).
    case "${2:-}" in tick|test|extract)
      root pitr; cd /opt/kumi/app && exec runuser -u postgres -- env DATABASE_URL='postgresql://postgres@/kumi?host=/var/run/postgresql' /usr/local/bin/node apps/server/src/cli.ts "$@";;
    esac;;
esac
cd /opt/kumi/app || exit 1
exec sudo -u kumi KUMI_CALLER_DIR="$OLDPWD" sh -c 'set -a; . /etc/kumi/kumi.env; set +a; exec /usr/local/bin/node apps/server/src/cli.ts "$@"' kumi "$@"
SH
chmod 755 /usr/local/bin/kumi
# Nightly backup at 3:17 on the club's clock (off the hour): the dump and its manifest, kept 14 days, and the
# offsite copy if set up. The timer ticks hourly and `--scheduled` runs it only when it's due, so the time follows
# the club's time zone, whatever the server's clock is, and a server that was off at 3:17 catches up.
install -d -m 750 -o kumi -g kumi /var/backups/kumi
cat > /etc/systemd/system/kumi-backup.service <<'UNIT'
[Unit]
Description=Kumi database backup (and its offsite copy)
After=postgresql.service
[Service]
Type=oneshot
User=kumi
WorkingDirectory=/opt/kumi/app
EnvironmentFile=/etc/kumi/kumi.env
ExecStart=/usr/local/bin/node apps/server/src/cli.ts backup --scheduled
UNIT
cat > /etc/systemd/system/kumi-backup.timer <<'UNIT'
[Unit]
Description=Kumi database backup, nightly at 3:17 club time (checked hourly)
[Timer]
OnCalendar=*-*-* *:17:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
# Once a month, the 1st at 4:17 on the club's clock: restore the newest backup into a scratch database and check it.
cat > /etc/systemd/system/kumi-restore-test.service <<'UNIT'
[Unit]
Description=Kumi restore test
After=postgresql.service
[Service]
Type=oneshot
User=kumi
WorkingDirectory=/opt/kumi/app
EnvironmentFile=/etc/kumi/kumi.env
ExecStart=/usr/local/bin/node apps/server/src/cli.ts restore-test --scheduled
UNIT
cat > /etc/systemd/system/kumi-restore-test.timer <<'UNIT'
[Unit]
Description=Kumi restore test, monthly on the 1st at 4:17 club time (checked hourly)
[Timer]
OnCalendar=*-*-* *:47:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'kumi_restore_test'" | grep -q 1 || sudo -u postgres createdb -O kumi kumi_restore_test
systemctl daemon-reload
systemctl enable kumi-backup.timer kumi-restore-test.timer
systemctl restart kumi-backup.timer kumi-restore-test.timer   # a changed schedule takes effect now
# Point-in-time backups (pitr.ts), once Postgres archives its log (server-setup.sh turns that on): the base backup
# when it's due, checked hourly (3:37 on the club's clock), and the monthly test (the 1st at 5:17), as the postgres
# user, whose archive it is.
cat > /etc/systemd/system/kumi-pitr.service <<'UNIT'
[Unit]
Description=Kumi point-in-time archive: the nightly base backup, when it's due
After=postgresql.service
ConditionPathExists=/etc/pgbackrest/pgbackrest.conf
[Service]
Type=oneshot
User=postgres
WorkingDirectory=/opt/kumi/app
Environment=DATABASE_URL=postgresql://postgres@/kumi?host=/var/run/postgresql
ExecStart=/usr/local/bin/node apps/server/src/cli.ts pitr tick
UNIT
cat > /etc/systemd/system/kumi-pitr.timer <<'UNIT'
[Unit]
Description=Kumi point-in-time archive, nightly base backup at 3:37 club time (checked hourly)
[Timer]
OnCalendar=*-*-* *:37:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/kumi-pitr-test.service <<'UNIT'
[Unit]
Description=Kumi point-in-time test: a recent minute restored in scratch and checked
After=postgresql.service
ConditionPathExists=/etc/pgbackrest/pgbackrest.conf
[Service]
Type=oneshot
User=postgres
WorkingDirectory=/opt/kumi/app
Environment=DATABASE_URL=postgresql://postgres@/kumi?host=/var/run/postgresql
ExecStart=/usr/local/bin/node apps/server/src/cli.ts pitr test --scheduled
UNIT
cat > /etc/systemd/system/kumi-pitr-test.timer <<'UNIT'
[Unit]
Description=Kumi point-in-time test, monthly on the 1st at 5:17 club time (checked hourly)
[Timer]
OnCalendar=*-*-* *:52:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable kumi-pitr.timer kumi-pitr-test.timer
systemctl restart kumi-pitr.timer kumi-pitr-test.timer
# pgBackRest's settings from this server's (where offsite copies go, the backup key), written again by every update.
if [ -f /etc/postgresql/17/main/conf.d/kumi-pitr.conf ] && [ -f /opt/kumi/app/apps/server/src/pitr_cli.ts ]; then
  t=$(mktemp)
  # The offsite archive has a folder per Postgres cluster (its system id): a server set up again after losing the old
  # one archives beside the old one's, which stays there to go back into (kumi restore --to ... --archive=<id>).
  sid=$(runuser -u postgres -- psql -XAtc 'SELECT system_identifier FROM pg_control_system()' 2>/dev/null || true)
  if (cd /opt/kumi/app && sudo -u kumi KUMI_PITR_SYSTEM_ID="$sid" sh -c 'set -a; . /etc/kumi/kumi.env; set +a; exec /usr/local/bin/node apps/server/src/cli.ts pitr conf') > "$t"; then
    install -d -m 755 /etc/pgbackrest
    install -m 640 -o root -g postgres "$t" /etc/pgbackrest/pgbackrest.conf
    runuser -u postgres -- pgbackrest --stanza=kumi --log-level-console=warn stanza-create || echo "kumi: the point-in-time archive isn't ready (above); kumi doctor says what's wrong"
    systemctl start --no-block kumi-pitr.service || true   # the first base backup, if there's none yet
  fi
  rm -f "$t"
fi
# --- end system files ---
systemctl enable kumi
echo "set up. Ship the code: deploy/ship.sh root@<this server>"
