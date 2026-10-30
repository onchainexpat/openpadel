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

# The kumi user owns the app and its database (it signs in to Postgres as itself, over the local socket).
id kumi >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/kumi --shell /usr/sbin/nologin kumi
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
KUMI_CLUB_FILE=/etc/kumi/club.yaml
# KUMI_RESEND_API_KEY=  KUMI_MAIL_FROM=  KUMI_MAIL_TEST_TO=
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

# The kumi command (kumi setup, kumi doctor) runs as the kumi user with the server's settings.
cat > /usr/local/bin/kumi <<'SH'
#!/bin/sh
cd /opt/kumi/app || exit 1
exec sudo -u kumi KUMI_CALLER_DIR="$OLDPWD" sh -c 'set -a; . /etc/kumi/kumi.env; set +a; exec /usr/local/bin/node apps/server/src/cli.ts "$@"' kumi "$@"
SH
chmod 755 /usr/local/bin/kumi

# The API answers on these paths; everything else is one of the two apps.
api='/auth/* /me /me/* /my/* /club /actions/* /runs /runs/* /changes /changes/* /staff/* /oauth/* /.well-known/* /mcp /mcp/* /health /open-programs /payments/* /webhooks/* /manifest/*'
# The apps' own security headers (the API sets its own): scripts only from here and Stripe (its card
# form), never framed by another site, and HTTPS remembered for a year.
csp="default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data: https://*.stripe.com; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
site() {
  cat <<SITE
$1 {
	encode zstd gzip
	@api path $api
	handle @api {
		reverse_proxy 127.0.0.1:8790
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
		root * /opt/kumi/app/apps/$2/dist
		try_files {path} /index.html
		file_server
	}
}
SITE
}
{ site "$KUMI_HOST" member; site "staff.$KUMI_HOST" manager; } > /etc/caddy/Caddyfile
# Caddy serves the built apps from the kumi user's (private) home, so it reads as the kumi group.
usermod -aG kumi caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

# Nightly backup at 3:17 (off the hour), kept 14 days.
install -d -m 750 -o kumi -g kumi /var/backups/kumi
cat > /etc/systemd/system/kumi-backup.service <<'UNIT'
[Unit]
Description=Kumi database backup
[Service]
Type=oneshot
User=kumi
ExecStart=/bin/sh -c 'pg_dump -Fc -d kumi -f /var/backups/kumi/kumi-$(date +%%F).dump && find /var/backups/kumi -name "kumi-*.dump" -mtime +14 -delete'
UNIT
cat > /etc/systemd/system/kumi-backup.timer <<'UNIT'
[Unit]
Description=Kumi database backup, nightly
[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now kumi-backup.timer
systemctl enable kumi
echo "set up. Ship the code: deploy/ship.sh root@<this server>"
