#!/usr/bin/env bash
# Updating Kumi in Docker: build the new release's images beside the running ones (tagged by commit), take a
# snapshot of the database, switch, and check the server answers as the new release. If it doesn't, the old
# images and the snapshot go back. Run from the checkout, next to compose.yaml and .env.
#
#   deploy/docker/update.sh <git ref>        a release tag (v0.2.0) or a branch
#   deploy/docker/update.sh rollback --yes   the previous release, and the database as it was just before
#                                            the last update (everything since is lost: hence --yes)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ -f .env ] || { echo "kumi: no .env here (copy deploy/docker/env.example)" >&2; exit 1; }
STATE=.kumi-release
say() { echo "kumi: $*"; }
die() { echo "kumi: $*" >&2; exit 1; }
setenv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }

# The server's key for the secrets it keeps: a setup from before there was one gets one now (never printed).
made_key=
grep -q '^KUMI_SECRET_KEY=.' .env || { setenv KUMI_SECRET_KEY "$(head -c 32 /dev/urandom | base64)"; made_key=1; say "made this server's secret key (KUMI_SECRET_KEY in .env)"; }

check() {
  local want=$1 i=0
  while [ "$i" -lt 90 ]; do
    if docker compose exec -T kumi node -e "fetch('http://127.0.0.1:8790/health').then(r=>r.json()).then(j=>process.exit(j.ok&&('$want'==='any'||j.revision==='$want')?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}
restore() {
  docker compose stop kumi backup
  docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U kumi -d kumi -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  docker compose exec -T db pg_restore --no-owner --no-acl --exit-on-error -U kumi -d kumi < "$1"
}
up_as() { setenv KUMI_TAG "$1"; KUMI_TAG=$1 docker compose up -d; }

if [ "${1:-}" = rollback ]; then
  [ "${2:-}" = "--yes" ] || die "going back puts the previous release back AND the database as it was just before the last update.
Everything since then (bookings, payments, sign-ups, changes) is lost. To go ahead: deploy/docker/update.sh rollback --yes"
  prev=$(sed -n 's/^previous=//p' "$STATE" 2>/dev/null); snap=$(sed -n 's/^snapshot=//p' "$STATE" 2>/dev/null)
  [ -n "$prev" ] && [ -f "$snap" ] || die "there's no previous release and snapshot kept to go back to"
  git checkout -q "$prev"; echo "$prev" > REVISION
  restore "$snap"
  up_as "$prev"
  check "$prev" || die "$prev didn't come up: docker compose logs kumi"
  printf 'current=%s\nprevious=\nsnapshot=\n' "$prev" > "$STATE"
  say "back on $prev"; exit 0
fi

ref=${1:?usage: deploy/docker/update.sh <git ref> | rollback --yes}
old=$(git rev-parse --short HEAD)
git fetch -q --tags
# A branch means its newest commit: the fetched one, not the local copy made when the club cloned.
if git rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null; then git checkout -q "origin/$ref"; else git checkout -q "$ref"; fi
new=$(git rev-parse --short HEAD)
if [ "$new" = "$old" ]; then
  # A setup from before the server's key existed: the running server needs it now, or it won't start.
  if [ -n "$made_key" ]; then docker compose up -d; check any || die "the server didn't come back up with its new key: docker compose logs kumi"; fi
  say "already on $new"; exit 0
fi
# The release names itself in /health.
echo "$new" > REVISION

# The running images, kept under the old commit's tag so going back doesn't need a rebuild.
cur=$(sed -n 's/^KUMI_TAG=//p' .env); cur=${cur:-local}
for i in kumi-server kumi-web; do if docker image inspect "$i:$cur" >/dev/null 2>&1; then docker tag "$i:$cur" "$i:$old"; fi; done
say "building $new beside $old"
KUMI_TAG=$new docker compose build || { echo "$old" > REVISION; git checkout -q "$old"; die "building $new failed; nothing changed, still on $old"; }

mkdir -p backups
snap="backups/update-$old-to-$new-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Only this user can read the snapshot: it holds every member's details.
(umask 077; docker compose exec -T db pg_dump -Fc --no-owner --no-acl -U kumi -d kumi > "$snap") || { git checkout -q "$old"; die "couldn't snapshot the database; nothing changed"; }
say "database snapshot: $snap"
kept=$(cat "$STATE" 2>/dev/null || true)
printf 'current=%s\nprevious=%s\nsnapshot=%s\n' "$new" "$old" "$snap" > "$STATE"

up_as "$new"
if check "$new"; then
  ls -1t backups/update-*.dump 2>/dev/null | tail -n +4 | xargs -r rm -f
  say "now running $new (was $old). If something's wrong: deploy/docker/update.sh rollback --yes"
  exit 0
fi
say "$new didn't come up; putting $old back"
git checkout -q "$old"; echo "$old" > REVISION
restore "$snap"
up_as "$old"
# What rollback undoes is the last update that worked, as before this one was tried.
if [ -n "$kept" ]; then printf '%s\n' "$kept" > "$STATE"; else printf 'current=%s\nprevious=\nsnapshot=\n' "$old" > "$STATE"; fi
check "$old" && die "update to $new failed; back on $old with the database as it was before (snapshot $snap)"
die "update to $new failed, and $old didn't come back up either: docker compose logs kumi"
