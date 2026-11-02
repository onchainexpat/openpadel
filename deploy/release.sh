#!/usr/bin/env bash
# Installing a Kumi release on a one-server install (server-setup.sh), and going back. Run as root; ship.sh and
# `kumi update` run it from the NEW release, so this script always comes with the code it installs.
#
#   release.sh update <release.tar> [revision]   install it beside the running release, snapshot the database,
#                                                switch, check; if it doesn't come up, put everything back
#   release.sh rollback --yes                    the previous release, and the database as it was before the
#                                                last update (everything since is lost: hence --yes)
#   release.sh status                            which release runs, which is kept, and the snapshots
#
# Releases live in $ROOT/releases/<revision>; $ROOT/app is a link to the running one. The last 3 releases and
# the last 3 update snapshots are kept. Everything under $ROOT is root's: the kumi user builds a release (as
# itself, so nothing an npm package runs gets root), then the release becomes root's before it's used, so the
# server and Caddy read it and nothing running as kumi can change what root runs later. Every path and command can be swapped by the environment (the tests
# run it against a scratch folder with stand-ins for systemctl, curl and the Postgres tools).
set -euo pipefail

ROOT=${KUMI_ROOT:-/opt/kumi}
ENV_FILE=${KUMI_ENV_FILE:-/etc/kumi/kumi.env}
BACKUPS=${KUMI_BACKUP_DIR:-/var/backups/kumi}
PG_BIN=${KUMI_PG_BIN:-/usr/lib/postgresql/17/bin}
KEEP=${KUMI_KEEP:-3}
CHECK_SECONDS=${KUMI_CHECK_SECONDS:-90}
RESTART=${KUMI_RESTART:-systemctl restart kumi}
STOP=${KUMI_STOP:-systemctl stop kumi}
INSTALL=${KUMI_INSTALL:-npm ci --no-audit --no-fund --loglevel=error}
BUILD=${KUMI_BUILD:-npm run build -w @kumi/member -w @kumi/manager --silent}
SYSTEM_FILES=${KUMI_SYSTEM_FILES:-1}
KUMI_HOME=${KUMI_HOME_DIR:-/var/lib/kumi}   # the kumi user's own folder (npm's cache), outside the code
# Commands that touch the app or the database run as the kumi user; the tests set KUMI_AS= to run them as themselves.
AS=${KUMI_AS-sudo -u kumi HOME=$KUMI_HOME}
STATE=$ROOT/releases/STATE

say() { echo "kumi: $*"; }
die() { echo "kumi: $*" >&2; exit 1; }
tool() { if [ -x "$PG_BIN/$1" ]; then echo "$PG_BIN/$1"; else echo "$1"; fi; }

[ -f "$ENV_FILE" ] || die "no settings at $ENV_FILE"
# The server's own key for the secrets it keeps (sealed.ts): a server set up before there was one gets one now,
# never printed. Production won't start without it.
if ! grep -q '^KUMI_SECRET_KEY=.' "$ENV_FILE"; then
  echo "KUMI_SECRET_KEY=$(head -c 32 /dev/urandom | base64)" >> "$ENV_FILE"
  echo "kumi: made this server's secret key (KUMI_SECRET_KEY in $ENV_FILE)"
fi
set -a; . "$ENV_FILE"; set +a
PORT=${PORT:-8790}
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL isn't set in $ENV_FILE"

state_get() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | head -1 || true; }
state_set() {
  mkdir -p "$ROOT/releases"
  local t; t=$(mktemp "$ROOT/releases/.STATE.XXXXXX")
  printf 'current=%s\nprevious=%s\nsnapshot=%s\n' "$1" "$2" "$3" > "$t" && chmod 644 "$t" && mv -f "$t" "$STATE"
}
current_rev() { if [ -L "$ROOT/app" ]; then basename "$(readlink "$ROOT/app")"; elif [ -d "$ROOT/app" ]; then cat "$ROOT/app/REVISION" 2>/dev/null || echo legacy; else echo none; fi; }

# Servers set up before releases were kept side by side run from a plain folder: move it into releases/.
adopt_layout() {
  mkdir -p "$ROOT/releases"
  if [ -d "$ROOT/app" ] && [ ! -L "$ROOT/app" ]; then
    local rev; rev=$(cat "$ROOT/app/REVISION" 2>/dev/null || echo legacy)
    rm -rf "$ROOT/releases/$rev"
    mv "$ROOT/app" "$ROOT/releases/$rev"
    ln -s "releases/$rev" "$ROOT/app"
    say "the running release ($rev) now lives in $ROOT/releases/$rev"
  fi
  rm -rf "$ROOT/app.old" "$ROOT/app.new"
}

# Servers set up before 0.1.0 had /opt/kumi as the kumi user's home and its releases owned by kumi, so code running
# as kumi could change what `sudo kumi ...` later ran as root; and Caddy read the apps as the kumi group, which
# also let it read the settings file. Make it all root's (readable by everyone: it's open-source code), give kumi
# a home of its own, and take Caddy out of the kumi group. Safe to run every time.
harden_layout() {
  [ -n "$AS" ] || return 0   # the tests run as themselves
  install -d -m 700 -o kumi -g kumi "$KUMI_HOME"
  install -d -m 755 -o root -g root "$ROOT" "$ROOT/releases"
  find "$ROOT/releases" -mindepth 1 -maxdepth 1 ! -user root -exec chown -R root:root {} + -exec chmod -R u+rwX,go+rX,go-w {} +
  [ -e "$STATE" ] && chown root:root "$STATE" && chmod 644 "$STATE"
  # What kumi kept in its old home (npm's cache, shell files) goes; only the releases and the app link stay.
  find "$ROOT" -mindepth 1 -maxdepth 1 ! -name releases ! -name app -exec rm -rf {} +
  if id caddy >/dev/null 2>&1 && id -nG caddy | tr ' ' '\n' | grep -qx kumi; then
    gpasswd -d caddy kumi >/dev/null && { systemctl restart caddy || true; }
    say "Caddy no longer reads as the kumi group (the apps are readable by everyone; the settings file isn't)"
  fi
}
switch_to() { ln -sfn "releases/$1" "$ROOT/app.next" && mv -Tf "$ROOT/app.next" "$ROOT/app"; }

# Up and answering, as the release we expect: /health names its revision, and /club answers.
check() {
  local want=$1 i=0 body
  while [ "$i" -lt "$CHECK_SECONDS" ]; do
    if body=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null) && echo "$body" | grep -q "\"revision\":\"$want\""; then
      local code; code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/club" 2>/dev/null || echo 000)
      [ "$code" -ge 200 ] && [ "$code" -lt 500 ] || { say "/club answers $code"; return 1; }
      [ -f "$ROOT/app/apps/member/dist/index.html" ] && [ -f "$ROOT/app/apps/manager/dist/index.html" ] || { say "the apps aren't built"; return 1; }
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  say "the server didn't answer as $want within ${CHECK_SECONDS}s"
  return 1
}

# The dump is made, named and given its mode by the kumi user (whose folder it is), never by root in that folder.
snapshot() {
  local file=$1
  mkdir -p "$BACKUPS"
  $AS sh -c 'umask 077; "$0" -Fc --no-owner --no-acl -d "$2" -f "$1.part" && mv -f "$1.part" "$1"' "$(tool pg_dump)" "$file" "$DATABASE_URL"
}
restore() {
  local file=$1
  $AS "$(tool psql)" -q -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  $AS "$(tool pg_restore)" --no-owner --no-acl --exit-on-error -d "$DATABASE_URL" "$file"
}

# Keep the running release, the one before it and one more; and the newest update snapshots.
tidy() {
  local cur prev n=0
  cur=$(current_rev); prev=$(state_get previous)
  for d in $(ls -1t "$ROOT/releases" 2>/dev/null); do
    [ -d "$ROOT/releases/$d" ] || continue
    case "$d" in *.new) rm -rf "${ROOT:?}/releases/$d"; continue;; esac
    if [ "$d" = "$cur" ] || [ "$d" = "$prev" ]; then n=$((n + 1)); continue; fi
    if [ "$n" -lt "$KEEP" ]; then n=$((n + 1)); else rm -rf "${ROOT:?}/releases/$d"; fi
  done
  # Newest first, names kept whole (a name with spaces is one file), deleted by kumi in kumi's own folder.
  $AS find "$BACKUPS" -maxdepth 1 -type f -name 'update-*.dump' -printf '%T@ %p\0' 2>/dev/null \
    | sort -zrn | tail -zn +$((KEEP + 1)) | cut -zd' ' -f2- | $AS xargs -0r rm -f --
}

# The kumi command, the backup and restore-test timers and the scratch database for the restore test, from this
# release (server-setup.sh writes the same; deploy.test checks the two match).
install_system_files() {
  [ "$SYSTEM_FILES" = "1" ] || return 0
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
    root restore; systemctl stop kumi
    cd /opt/kumi/app && sudo -u kumi KUMI_CALLER_DIR="$OLDPWD" sh -c 'set -a; . /etc/kumi/kumi.env; set +a; exec /usr/local/bin/node apps/server/src/cli.ts "$@"' kumi "$@"
    # 4: the restore failed and the database may be empty: the server stays stopped (starting would set up an
    # empty club). Any other outcome left the database whole (restored, put back, or never touched).
    rc=$?; if [ "$rc" = 4 ]; then echo "kumi: the server stays stopped; see above" >&2; else systemctl start kumi; fi; exit $rc;;
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
# --- end system files ---
  # Root's own copy of this script, for `sudo kumi rollback` and `sudo kumi releases`. It comes from the release
  # file (ship.sh and `kumi update` run it from there), never from the built release the kumi user worked in.
  install -D -m 755 -o root -g root "${BASH_SOURCE[0]}" /usr/local/lib/kumi/release.sh
}

update() {
  local tarball=${1:?usage: release.sh update <release.tar> [revision]} new=${2:-}
  [ -f "$tarball" ] || die "no file $tarball"
  # From here on, nowhere in particular: the kumi user's commands can't see into root's temporary folders.
  tarball=$(readlink -f "$tarball"); cd /
  [ -n "$new" ] || new=$(tar -xOf "$tarball" REVISION 2>/dev/null || true)
  [ -n "$new" ] || new=$(sha256sum "$tarball" | cut -c1-12)
  case "$new" in *[!A-Za-z0-9._-]*|"") die "a revision is letters, digits, dots and dashes: $new";; esac
  adopt_layout
  harden_layout
  local old; old=$(current_rev)
  if [ "$old" = "$new" ] && [ "${KUMI_FORCE:-0}" != "1" ]; then say "already running $new"; exit 0; fi

  # 1. Install and build beside the running release: nothing changes for members yet.
  local dir="$ROOT/releases/$new"
  rm -rf "$dir.new"; mkdir -p "$dir.new"
  tar -x -C "$dir.new" -f "$tarball"
  echo "$new" > "$dir.new/REVISION"
  [ -z "$AS" ] || chown -R kumi:kumi "$dir.new"
  say "installing $new beside $old"
  if ! (cd "$dir.new" && $AS $INSTALL && $AS $BUILD); then rm -rf "$dir.new"; die "installing $new failed; nothing changed, still on $old"; fi
  # Built: now root's, read-only to everyone else, before anything uses it (chown -R doesn't follow links in it).
  [ -z "$AS" ] || { chown -R root:root "$dir.new"; chmod -R u+rwX,go+rX,go-w "$dir.new"; }
  rm -rf "$dir"; mv "$dir.new" "$dir"

  # 2. A snapshot of the database as it is now, named for the update.
  local snap; snap="$BACKUPS/update-$old-to-$new-$(date -u +%Y%m%dT%H%M%SZ).dump"
  snapshot "$snap" || die "couldn't take a snapshot of the database; nothing changed, still on $old"
  say "database snapshot: $snap"

  # 3. Switch and start: database changes apply as the server starts. 4. Check it answers as the new release.
  state_set "$new" "$old" "$snap"
  switch_to "$new"
  if $RESTART && check "$new"; then
    install_system_files
    tidy
    say "now running $new (was $old). If something's wrong: sudo kumi rollback --yes"
    return 0
  fi

  # It didn't come up: the old release, and the database from the snapshot (the new one may have changed it).
  say "$new didn't come up; putting $old back"
  [ "$old" != "none" ] && [ -d "$ROOT/releases/$old" ] || die "there's no previous release to go back to"
  switch_to "$old"
  $STOP || true
  restore "$snap" || die "putting the database back from $snap failed: restore it by hand (kumi restore $snap --yes)"
  state_set "$old" "" ""
  if $RESTART && check "$old"; then die "update to $new failed; back on $old with the database as it was before (snapshot $snap)"; fi
  die "update to $new failed, and $old didn't come back up either: check journalctl -u kumi"
}

rollback() {
  cd /
  harden_layout
  [ "${1:-}" = "--yes" ] || die "going back puts the previous release back AND the database as it was just before the last update.
Everything since then (bookings, payments, sign-ups, changes) is lost. To go ahead: kumi rollback --yes"
  local prev snap cur
  prev=$(state_get previous); snap=$(state_get snapshot); cur=$(current_rev)
  [ -n "$prev" ] && [ -d "$ROOT/releases/$prev" ] || die "there's no previous release kept to go back to"
  [ -n "$snap" ] && [ -f "$snap" ] || die "the snapshot from the last update isn't there any more ($snap)"
  say "going back from $cur to $prev, with the database from $snap"
  switch_to "$prev"
  $STOP || true
  restore "$snap" || die "restoring $snap failed; the server is stopped. Restore it by hand: kumi restore $snap --yes"
  state_set "$prev" "" ""
  $RESTART && check "$prev" || die "$prev didn't come up: check journalctl -u kumi"
  say "back on $prev. $cur is still kept in $ROOT/releases."
}

status() {
  echo "running:  $(current_rev)"
  echo "previous: $(state_get previous)"
  echo "snapshot: $(state_get snapshot)"
  echo "releases: $(ls -1t "$ROOT/releases" 2>/dev/null | grep -v '^STATE' | tr '\n' ' ')"
}

case "${1:-}" in
  update) shift; update "$@";;
  rollback) shift; rollback "$@";;
  status) status;;
  *) die "usage: release.sh update <release.tar> [revision] | rollback --yes | status";;
esac
