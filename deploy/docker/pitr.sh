#!/bin/sh
# Docker's pitr service (compose.yaml): point-in-time backups (apps/server/src/pitr.ts) as the Postgres image's own
# postgres user, beside the db service. It writes pgBackRest's settings from .env (the db service's Postgres reads the
# same file to archive its log), makes the archive if there's none yet and takes a base backup, then every hour at :37
# takes the base backups that are due (3:37 on the club's clock) and the monthly test when it's due (the 1st, 5:17).
set -u
conf=/etc/pgbackrest/pgbackrest.conf
say() { echo "kumi pitr: $*"; }
# The offsite archive has a folder per Postgres cluster (its system id), as on a one-server install: a setup made again
# after losing the machine archives beside the old one's, which stays there to go back into.
sid=$(psql -XAtq -h /var/run/postgresql -U "${OPENPADEL_PITR_PG_USER:-${KUMI_PITR_PG_USER:-kumi}}" -d postgres -c 'SELECT system_identifier FROM pg_control_system()') \
  || { say "can't reach Postgres"; exit 1; }
OPENPADEL_PITR_SYSTEM_ID=$sid kumi pitr conf > "$conf.new"; rc=$?
if [ "$rc" = 3 ]; then
  # OPENPADEL_PITR=0: off. Without the settings, Postgres lets each piece of its log go, as before.
  rm -f "$conf.new" "$conf"; say "off (OPENPADEL_PITR=0 in .env)"
  while :; do sleep 86400; done
fi
[ "$rc" = 0 ] || { rm -f "$conf.new"; say "couldn't write pgBackRest's settings"; exit 1; }
chmod 600 "$conf.new"
# Made (or a copy added since, offsite say) before Postgres is told where to send its log, so nothing it sends is refused.
# stanza-create takes the archive's lock, so it's refused ([050]) while Postgres is sending a piece of its log: wait a
# moment and try again, and say the archive isn't ready only if it still isn't.
n=0
while :; do
  if out=$(pgbackrest --config="$conf.new" --stanza=kumi --log-level-console=warn stanza-create 2>&1); then [ -z "$out" ] || printf '%s\n' "$out"; break; fi
  n=$((n + 1))
  case "$out" in *"[050]"*) if [ "$n" -lt 6 ]; then sleep 5; continue; fi ;; esac
  printf '%s\n' "$out"; say "the archive isn't ready (above); kumi doctor says what's wrong"; break
done
mv -f "$conf.new" "$conf"
# A base backup each time the service starts (a full one first, then differential ones): recovery replays the log in
# order, so after a stretch without archiving (an earlier release, OPENPADEL_PITR=0) the minutes since are reachable at once,
# not only after the next night's.
tick=--now
while :; do
  kumi pitr tick $tick; tick=
  kumi pitr test --scheduled
  sleep $(( (2220 - $(date +%s) % 3600 + 3600) % 3600 + 1 ))
done
