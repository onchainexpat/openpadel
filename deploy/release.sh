#!/usr/bin/env bash
# Installing a Kumi release on a one-server install (server-setup.sh), and going back. Run as root; ship.sh and
# `kumi update` run it from the NEW release, so this script always comes with the code it installs.
#
#   release.sh update <release.tar> [revision]   install it beside the running release, snapshot the database,
#                                                switch, check, and give Caddy the release's config (the paths
#                                                it answers on); if it doesn't come up, put everything back
#   release.sh rollback --yes                    the previous release, its Caddy config, and the database as it
#                                                was before the last update (everything since is lost: hence --yes)
#   release.sh status                            which release runs, which is kept, and the snapshots
#
# Releases live in $ROOT/releases/<revision>; $ROOT/app is a link to the running one. The last 3 releases and
# the last 3 update snapshots are kept. Everything under $ROOT is root's: the kumi user builds a release (as
# itself, so nothing an npm package runs gets root), then the release becomes root's before it's used, so the
# server and Caddy read it and nothing running as kumi can change what root runs later. Every path and command can be swapped by the environment (the tests
# run it against a scratch folder with stand-ins for systemctl, curl and the Postgres tools).
#
# All of it is one block, read in full before any of it runs, and it ends in exit: bash reads a script as it goes, and
# an update installs this file as root's copy, the one `sudo kumi rollback` runs.
{
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
# Caddy's config, rewritten from each release (its API paths and the apps' policy) unless it was changed by hand.
CADDYFILE=${KUMI_CADDYFILE:-/etc/caddy/Caddyfile}
CADDY=${KUMI_CADDY:-caddy}
CADDY_RELOAD=${KUMI_CADDY_RELOAD:-systemctl reload caddy}
CADDY_RESTART=${KUMI_CADDY_RESTART:-systemctl restart caddy}
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

# A request to the server itself: on its port on this machine, or on its unix socket (KUMI_SOCKET).
ask() {
  local path=$1; shift
  if [ -n "${KUMI_SOCKET:-}" ]; then curl --unix-socket "$KUMI_SOCKET" "$@" "http://localhost$path"; else curl "$@" "http://127.0.0.1:$PORT$path"; fi
}

# Up and answering, as the release we expect: /health names its revision, and /club answers.
check() {
  local want=$1 i=0 body
  while [ "$i" -lt "$CHECK_SECONDS" ]; do
    if body=$(ask /health -fsS --max-time 5 2>/dev/null) && echo "$body" | grep -q "\"revision\":\"$want\""; then
      local code; code=$(ask /club -sS --max-time 5 -o /dev/null -w '%{http_code}' 2>/dev/null || echo 000)
      [ "$code" -ge 200 ] && [ "$code" -lt 500 ] || { say "/club answers $code"; return 1; }
      [ -f "$ROOT/app/apps/member/dist/index.html" ] && [ -f "$ROOT/app/apps/manager/dist/index.html" ] || { say "the apps aren't built"; return 1; }
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  say "the server didn't answer as $want within ${CHECK_SECONDS}s"
  return 1
}

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
  echo "# Caddy's admin API listens on a socket only the caddy user reaches (systemctl reload caddy uses it), never on"
  echo "# 127.0.0.1:2019, where anything on this server (a local plugin) could rewrite the sites."
  printf '{\n\tadmin unix//var/lib/caddy/admin.sock\n}\n'
  site "$1" member "$3" "$4"
  site "$2" manager "$3" "$4"
}
# --- end caddy sites ---
host_of() { local h=${1#*://}; printf '%s' "${h%%/*}"; }
# Caddy's config for release $1: the API's paths and the apps' policy from that release's own server-setup.sh, the
# addresses from the settings file, and where the server listens. Fails if any of them is missing, or odd: the
# release was built by the kumi user, so what it says goes into root's Caddyfile only if it's paths (letters, digits
# and / * . _ -) and a policy with nothing that could end Caddy's quoted string or open a block of its own.
caddy_for() {
  local f="$ROOT/releases/$1/deploy/server-setup.sh" api csp member staff upstream
  [ -f "$f" ] || return 1
  api=$(sed -n "s/^api='\(.*\)'\$/\1/p" "$f" | head -1); csp=$(sed -n 's/^csp="\(.*\)"$/\1/p' "$f" | head -1)
  member=$(host_of "${KUMI_MEMBER_URL:-}"); staff=$(host_of "${KUMI_PUBLIC_URL:-}")
  [ -n "$api" ] && [ -n "$csp" ] && [ -n "$member" ] && [ -n "$staff" ] || return 1
  if ! printf '%s\n' "$api" | LC_ALL=C grep -Eqx '[A-Za-z0-9/*._-]+( [A-Za-z0-9/*._-]+)*' \
    || ! printf '%s\n' "$csp" | LC_ALL=C grep -Eqx "[ -~]+" || printf '%s\n' "$csp" | grep -q '["\\{}]'; then
    echo "kumi: release $1's api= or csp= line (deploy/server-setup.sh) has what Caddy's config can't safely take" >&2
    return 1
  fi
  if [ -n "${KUMI_SOCKET:-}" ]; then upstream="unix/$KUMI_SOCKET"; else upstream="127.0.0.1:$PORT"; fi
  kumi_sites "$member" "$staff" "$upstream" "$ROOT/app"
}
# Whether Caddy's config is the one Kumi wrote for release $1, unchanged since (comments aside). Only then is it
# written again: a config changed by hand is left alone.
caddy_ours() {
  local want
  [ -f "$CADDYFILE" ] && want=$(caddy_for "$1") || return 1
  local have; have=$(grep -v '^#' "$CADDYFILE"); want=$(printf '%s\n' "$want" | grep -v '^#')
  # Or as releases before plugins wrote it: without the block that moves Caddy's admin API to its socket (3 lines).
  [ "$have" = "$want" ] || [ "$have" = "$(printf '%s\n' "$want" | sed '1,3d')" ]
}
# Release $1's config, written beside Caddy's and checked by Caddy itself; prints its path. Nothing is switched yet.
caddy_next() {
  local next="$CADDYFILE.kumi-$1" out
  caddy_for "$1" > "$next" || { rm -f "$next"; return 1; }
  if ! out=$($CADDY validate --config "$next" --adapter caddyfile 2>&1); then
    rm -f "$next"; echo "$out" | tail -2 >&2; return 1
  fi
  echo "$next"
}
# Puts a checked config in place, and Caddy takes it without dropping connections. If Caddy won't, the old config
# goes back and this fails.
caddy_use() {
  local next=$1
  [ -n "$next" ] || return 0
  if cmp -s "$next" "$CADDYFILE"; then rm -f "$next"; return 0; fi
  cp -p "$CADDYFILE" "$CADDYFILE.kumi-before"
  chmod 644 "$next"; mv -f "$next" "$CADDYFILE"
  # A reload asks Caddy's admin API where the new config says it is: the first time it moves to its socket, the running
  # Caddy is still on 127.0.0.1:2019, so it's restarted instead (the config was checked above).
  if $CADDY_RELOAD || $CADDY_RESTART; then rm -f "$CADDYFILE.kumi-before"; say "Caddy now has this release's config"; return 0; fi
  mv -f "$CADDYFILE.kumi-before" "$CADDYFILE"; $CADDY_RELOAD || $CADDY_RESTART || true
  say "Caddy didn't take the new config, so it has its old one back"
  return 1
}

# The dump is made, named and given its mode by the kumi user (whose folder it is), never by root in that folder.
snapshot() {
  local file=$1
  mkdir -p "$BACKUPS"
  $AS sh -c 'umask 077; "$0" -Fc --no-owner --no-acl -d "$2" -f "$1.part" && mv -f "$1.part" "$1"' "$(tool pg_dump)" "$file" "$DATABASE_URL"
}
# Putting a snapshot back (a failed update, or kumi rollback). The database had sent things since the snapshot was
# taken, which the snapshot still has waiting: read before it's replaced and carried over after (after_restore.ts
# does the same for kumi restore), so nothing goes twice. A message that had gone keeps that answer; a notice it
# had handled is held for `kumi held send|drop`, since its messages may have gone (refunds aren't held: a refund
# asks Stripe first). An email, text or push it had sent that the snapshot has no row for at all (made since) is kept
# as a fingerprint for a week, so a job that makes it again doesn't send it twice (Kumi's repeats.ts, from migration 069).
# The usage meter keeps what was spent since the snapshot (each club month and kind the larger count), and an 80% or
# cap message said since stays said, as after kumi restore.
psql_kumi() { $AS "$(tool psql)" -X -q -v ON_ERROR_STOP=1 -d "$DATABASE_URL" "$@"; }
restore() {
  local file=$1 sent done fps use alerts gone
  sent=$(mktemp); done=$(mktemp); fps=$(mktemp); use=$(mktemp); alerts=$(mktemp); gone=$(mktemp -d)
  psql_kumi -c "COPY (SELECT id, status, sent_at, failure FROM outbound_message WHERE status IN ('sent', 'failed', 'dropped') AND created_at >= now() - interval '400 days') TO STDOUT" > "$sent" 2>/dev/null || : > "$sent"
  psql_kumi -c "COPY (SELECT id FROM event_outbox WHERE delivered_at IS NOT NULL AND created_at >= now() - interval '400 days') TO STDOUT" > "$done" 2>/dev/null || : > "$done"
  psql_kumi -c "COPY (SELECT id, encode(sha256(convert_to(concat_ws(chr(31), person_id::text, kind, channel, subject, body, coalesce(link, ''), to_jsonb(outbound_message)->>'chat_message_id'), 'UTF8')), 'hex'), sent_at FROM outbound_message WHERE status = 'sent' AND channel <> 'inbox' AND sent_at IS NOT NULL AND created_at >= now() - interval '400 days') TO STDOUT" > "$fps" 2>/dev/null || : > "$fps"
  psql_kumi -c "COPY (SELECT month, kind, count, input_tokens, output_tokens, segments, cents, updated_at FROM usage_month) TO STDOUT" > "$use" 2>/dev/null || : > "$use"
  psql_kumi -c "COPY (SELECT month, near_cap, reached_cap, paused_limit FROM usage_alert) TO STDOUT" > "$alerts" 2>/dev/null || : > "$alerts"
  read_gone "$gone"
  psql_kumi -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' || { rm -rf "$sent" "$done" "$fps" "$use" "$alerts" "$gone"; return 1; }
  $AS "$(tool pg_restore)" --no-owner --no-acl --exit-on-error -d "$DATABASE_URL" "$file" || { rm -rf "$sent" "$done" "$fps" "$use" "$alerts" "$gone"; return 1; }
  carry_over "$sent" "$done" "$fps" || say "what had been sent since the snapshot couldn't be carried over (above): see kumi held before starting it"
  carry_meter "$use" "$alerts" || say "the usage meter couldn't be carried over (above): this month's count may be short (kumi usage)"
  carry_gone "$gone" || say "what had been taken away on request since the snapshot (deleted accounts, words taken back, sign-ins ended) couldn't all be taken away again (above)"
  rm -rf "$sent" "$done" "$fps" "$use" "$alerts" "$gone"
}
carry_over() {
  if [ -s "$1" ]; then
    psql_kumi -c "CREATE TEMP TABLE kumi_sent (id uuid, status text, sent_at timestamptz, failure text)" -c "COPY kumi_sent FROM STDIN" \
      -c "UPDATE outbound_message m SET status = s.status, sent_at = s.sent_at, failure = s.failure FROM kumi_sent s WHERE m.id = s.id AND m.status = 'waiting'" < "$1" || return 1
  fi
  # Held only where the snapshot's Kumi can hold (from migration 068); a snapshot from before that has no hold.
  if [ -s "$2" ] && psql_kumi -Atc "SELECT 1 FROM information_schema.columns WHERE table_name = 'event_outbox' AND column_name = 'held_at'" | grep -q 1; then
    psql_kumi -c "CREATE TEMP TABLE kumi_done (id bigint)" -c "COPY kumi_done FROM STDIN" \
      -c "UPDATE event_outbox e SET held_at = now() FROM kumi_done d WHERE e.id = d.id AND e.delivered_at IS NULL AND e.held_at IS NULL AND e.topic NOT IN ('refund.requested', 'payment.call_off', 'payment_found.refund')" < "$2" || return 1
  fi
  # Fingerprints only where the snapshot's Kumi looks for them (from migration 069).
  if [ -s "${3:-}" ] && psql_kumi -Atc "SELECT 1 FROM information_schema.tables WHERE table_name = 'sent_before_restore'" | grep -q 1; then
    psql_kumi -c "CREATE TEMP TABLE kumi_fp (id uuid, fp text, sent_at timestamptz)" -c "COPY kumi_fp FROM STDIN" \
      -c "INSERT INTO sent_before_restore (fp, message_id, sent_at, restored_at, until) SELECT f.fp, f.id, f.sent_at, now(), now() + interval '7 days' FROM kumi_fp f WHERE NOT EXISTS (SELECT 1 FROM outbound_message m WHERE m.id = f.id)" < "$3" || return 1
  fi
}
carry_meter() {
  # Only where the snapshot's Kumi has the meter (from migration 064).
  psql_kumi -Atc "SELECT 1 FROM information_schema.tables WHERE table_name = 'usage_month'" | grep -q 1 || return 0
  if [ -s "$1" ]; then
    psql_kumi -c "CREATE TEMP TABLE kumi_use (month date, kind text, count int, input_tokens bigint, output_tokens bigint, segments int, cents numeric, updated_at timestamptz)" -c "COPY kumi_use FROM STDIN" \
      -c "INSERT INTO usage_month AS u (month, kind, count, input_tokens, output_tokens, segments, cents, updated_at) SELECT month, kind, count, input_tokens, output_tokens, segments, cents, updated_at FROM kumi_use WHERE kind IN ('ai_decisions', 'ai_drafts', 'texts', 'email') ON CONFLICT (month, kind) DO UPDATE SET count = greatest(u.count, excluded.count), input_tokens = greatest(u.input_tokens, excluded.input_tokens), output_tokens = greatest(u.output_tokens, excluded.output_tokens), segments = greatest(u.segments, excluded.segments), cents = greatest(u.cents, excluded.cents), updated_at = greatest(u.updated_at, excluded.updated_at)" < "$1" || return 1
  fi
  if [ -s "$2" ]; then
    psql_kumi -c "CREATE TEMP TABLE kumi_alert (month date, near_cap int, reached_cap int, paused_limit int)" -c "COPY kumi_alert FROM STDIN" \
      -c "INSERT INTO usage_alert AS a (month, near_cap, reached_cap, paused_limit) SELECT month, near_cap, reached_cap, paused_limit FROM kumi_alert ON CONFLICT (month) DO UPDATE SET near_cap = coalesce(a.near_cap, excluded.near_cap), reached_cap = coalesce(a.reached_cap, excluded.reached_cap), paused_limit = coalesce(a.paused_limit, excluded.paused_limit)" < "$2" || return 1
  fi
}

# What the database had taken away on request since the snapshot comes back with it unless it's carried too: an
# account deleted, a chat message taken back or hidden, an authenticator removed or replaced, a yes or no to messages,
# and sign-ins, passkeys, phones' push, calendar links, assistants and recovery codes ended or used (REVOKED). The
# same SQL as Kumi's after_restore.ts (GONE; deploy.test checks they match), each only where the snapshot's Kumi has
# that table or column. Deleted accounts are queued (from migration 082) and deleted again as the server starts; a
# snapshot from before that is told instead.
REVOKED="web_session token_hash revoked_at
passkey credential_id revoked_at
push_subscription id revoked_at
calendar_feed id revoked_at
oauth_grant id revoked_at
oauth_token token_hash revoked_at
oauth_token token_hash used_at
recovery_code id used_at"
has_table() { psql_kumi -Atc "SELECT 1 FROM information_schema.tables WHERE table_name = '$1'" | grep -q 1; }
has_column() { psql_kumi -Atc "SELECT 1 FROM information_schema.columns WHERE table_name = '$1' AND column_name = '$2'" | grep -q 1; }
read_gone() {
  local g=$1 t k c
  # A database from before the queue (082) can't answer the people read: its deletions alone.
  psql_kumi -c "COPY (SELECT p.id, p.redacted_at, coalesce(p.erased_by_kind, (SELECT CASE WHEN r.actor_person_id = p.id THEN 'self' WHEN r.actor_person_id IS NOT NULL THEN 'staff' END FROM action_run r WHERE r.action = 'privacy.erase' AND r.status = 'applied' AND r.input->>'person_id' = p.id::text ORDER BY r.applied_at DESC LIMIT 1)) AS deleted_by FROM person p WHERE p.redacted_at IS NOT NULL UNION ALL SELECT q.person_id, q.redacted_at, q.deleted_by FROM erase_after_restore q) TO STDOUT" > "$g/people" 2>/dev/null || psql_kumi -c "COPY (SELECT p.id, p.redacted_at, NULL::text AS deleted_by FROM person p WHERE p.redacted_at IS NOT NULL) TO STDOUT" > "$g/people" 2>/dev/null || : > "$g/people"
  psql_kumi -c "COPY (SELECT id, removed_at, hidden_at, hidden_by, body = '' AS blank FROM chat_message WHERE removed_at IS NOT NULL OR hidden_at IS NOT NULL) TO STDOUT" > "$g/chat" 2>/dev/null || : > "$g/chat"
  psql_kumi -c "COPY (SELECT person_id, secret, confirmed_at::text AS confirmed_at, last_step, removed_at::text AS removed_at FROM staff_factor) TO STDOUT" > "$g/factors" 2>/dev/null || : > "$g/factors"
  psql_kumi -c "COPY (SELECT p.id AS person_id, a.id, a.kind, a.value, a.verified_at::text AS verified_at FROM person p LEFT JOIN auth_identity a ON a.person_id = p.id WHERE p.redacted_at IS NULL) TO STDOUT" > "$g/idents" 2>/dev/null || : > "$g/idents"
  psql_kumi -c "COPY (SELECT p.id AS person_id, a.id, a.kind, a.value, a.verified_at::text AS verified_at FROM person p LEFT JOIN auth_identity a ON a.person_id = p.id WHERE p.redacted_at IS NULL) TO STDOUT" > "$g/idents_back" 2>/dev/null || : > "$g/idents_back"
  psql_kumi -c "COPY (SELECT id, email, phone, own_login FROM person WHERE redacted_at IS NULL) TO STDOUT" > "$g/contact" 2>/dev/null || : > "$g/contact"
  psql_kumi -c "COPY (SELECT c.id, c.person_id, c.channel, c.purpose, c.granted, c.source, c.form_version, c.evidence, c.at, (SELECT CASE c.channel WHEN 'sms' THEN p.phone WHEN 'email' THEN p.email END FROM person p WHERE p.id = c.person_id) AS addr FROM channel_consent c) TO STDOUT" > "$g/consents" 2>/dev/null || : > "$g/consents"
  psql_kumi -c "COPY (SELECT id, removed_at FROM family_card WHERE status = 'removed') TO STDOUT" > "$g/cards" 2>/dev/null || : > "$g/cards"
  psql_kumi -c "COPY (SELECT endpoint, person_id, revoked_at FROM push_subscription) TO STDOUT" > "$g/push" 2>/dev/null || : > "$g/push"
  psql_kumi -c "COPY (SELECT id, status, redeemed_by, redeemed_at::text AS redeemed_at, voided_at::text AS voided_at FROM gift_card WHERE status IN ('redeemed', 'void')) TO STDOUT" > "$g/gifts" 2>/dev/null || : > "$g/gifts"
  psql_kumi -c "COPY (SELECT id, person_id, amount_cents, method, note, at::text AS at FROM credit_payout) TO STDOUT" > "$g/payouts" 2>/dev/null || : > "$g/payouts"
  psql_kumi -c "COPY (SELECT id, status, refunded_at::text AS refunded_at, uses_left FROM pass) TO STDOUT" > "$g/passes" 2>/dev/null || : > "$g/passes"
  psql_kumi -c "COPY (SELECT id, returned_at::text AS returned_at FROM pass_use WHERE returned_at IS NOT NULL) TO STDOUT" > "$g/pass_returns" 2>/dev/null || : > "$g/pass_returns"
  psql_kumi -c "COPY (SELECT id FROM promo_code WHERE NOT active) TO STDOUT" > "$g/promos_off" 2>/dev/null || : > "$g/promos_off"
  psql_kumi -c "COPY (SELECT u.promo_code_id, u.person_id, count(*) AS n FROM promo_use u JOIN payment p ON p.id = u.payment_id WHERE p.status <> 'failed' GROUP BY u.promo_code_id, u.person_id) TO STDOUT" > "$g/promo_uses" 2>/dev/null || : > "$g/promo_uses"
  while read -r t k c; do
    psql_kumi -c "COPY (SELECT $k::text, $c FROM $t WHERE $c IS NOT NULL) TO STDOUT" > "$g/rev.$t.$c" 2>/dev/null || : > "$g/rev.$t.$c"
  done <<< "$REVOKED"
}
carry_gone() {
  local g=$1 t k c n failed=0 list
  if [ -s "$g/people" ]; then
    if has_column erase_after_restore deleted_by; then
      psql_kumi -c "CREATE TEMP TABLE kumi_gone (id uuid, redacted_at timestamptz, deleted_by text)" -c "COPY kumi_gone FROM STDIN" \
        -c "INSERT INTO erase_after_restore (person_id, redacted_at, deleted_by) SELECT g.id, g.redacted_at, g.deleted_by FROM kumi_gone g JOIN person p ON p.id = g.id WHERE p.redacted_at IS NULL ON CONFLICT (person_id) DO NOTHING" < "$g/people" || failed=1
    else
      # A snapshot from before the queue: who came back, kept for the staff (0640, the kumi group) and said, to delete again by hand.
      list="$BACKUPS/deleted-again-by-hand-$(date -u +%Y%m%dT%H%M%SZ).txt"
      (umask 027; psql_kumi -At -F ' ' -c "CREATE TEMP TABLE kumi_gone (id uuid, redacted_at timestamptz, deleted_by text)" -c "COPY kumi_gone FROM STDIN" \
        -c "SELECT g.id, p.display_name, g.deleted_by FROM kumi_gone g JOIN person p ON p.id = g.id WHERE p.redacted_at IS NULL" < "$g/people" | tr -d '\000-\010\013-\037\177' > "$list") || failed=1
      chgrp kumi "$list" 2>/dev/null || :
      n=$(grep -c . "$list" 2>/dev/null || echo 0)
      if [ "${n:-0}" -gt 0 ] 2>/dev/null; then
        say "$n account(s) deleted since the snapshot are back in it, and this release can't delete them again by itself: delete them again in the staff app (Customers). They are (id, name, who deleted it), also in $list:"
        while read -r line; do say "  $line"; done < "$list"
      else rm -f "$list"; fi
    fi
  fi
  if [ -s "$g/chat" ] && has_table chat_message; then
    psql_kumi -c "CREATE TEMP TABLE kumi_chat_gone (id uuid, removed_at timestamptz, hidden_at timestamptz, hidden_by uuid, blank boolean)" -c "COPY kumi_chat_gone FROM STDIN" \
      -c "UPDATE chat_message m SET removed_at = coalesce(m.removed_at, g.removed_at), hidden_at = coalesce(m.hidden_at, g.hidden_at), hidden_by = coalesce(m.hidden_by, (SELECT p.id FROM person p WHERE p.id = g.hidden_by)), body = CASE WHEN g.blank THEN '' ELSE m.body END, version = m.version + 1 FROM kumi_chat_gone g WHERE m.id = g.id AND ((g.removed_at IS NOT NULL AND m.removed_at IS NULL) OR (g.hidden_at IS NOT NULL AND m.hidden_at IS NULL) OR (g.blank AND m.body <> ''))" < "$g/chat" || failed=1
  fi
  if [ -s "$g/factors" ] && has_table staff_factor; then
    psql_kumi -c "CREATE TEMP TABLE kumi_factor (person_id uuid, secret text, confirmed_at timestamptz, last_step bigint, removed_at timestamptz)" -c "COPY kumi_factor FROM STDIN" \
      -c "INSERT INTO staff_factor AS f (person_id, secret, confirmed_at, last_step, removed_at) SELECT g.person_id, g.secret, g.confirmed_at, g.last_step, g.removed_at FROM kumi_factor g JOIN person p ON p.id = g.person_id WHERE p.redacted_at IS NULL ON CONFLICT (person_id) DO UPDATE SET secret = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.secret ELSE f.secret END, confirmed_at = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.confirmed_at ELSE f.confirmed_at END, removed_at = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.removed_at ELSE f.removed_at END, last_step = CASE WHEN greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) THEN excluded.last_step ELSE greatest(f.last_step, excluded.last_step) END, version = f.version + 1 WHERE greatest(excluded.confirmed_at, coalesce(excluded.removed_at, '-infinity')) > greatest(f.confirmed_at, coalesce(f.removed_at, '-infinity')) OR (excluded.confirmed_at = f.confirmed_at AND excluded.last_step > f.last_step)" < "$g/factors" || failed=1
  fi
  if [ -s "$g/idents" ] && has_table auth_identity; then
    psql_kumi -c "CREATE TEMP TABLE kumi_ident (person_id uuid, id uuid, kind text, value text, verified_at timestamptz)" -c "COPY kumi_ident FROM STDIN" \
      -c "DELETE FROM auth_identity a WHERE EXISTS (SELECT 1 FROM kumi_ident k WHERE k.person_id = a.person_id) AND NOT EXISTS (SELECT 1 FROM kumi_ident k WHERE k.id = a.id OR (k.person_id = a.person_id AND k.kind = a.kind AND k.value = a.value))" < "$g/idents" || failed=1
  fi
  if [ -s "$g/idents_back" ] && has_table auth_identity; then
    psql_kumi -c "CREATE TEMP TABLE kumi_ident_back (person_id uuid, id uuid, kind text, value text, verified_at timestamptz)" -c "COPY kumi_ident_back FROM STDIN" \
      -c "INSERT INTO auth_identity (id, person_id, kind, value, verified_at) SELECT k.id, k.person_id, k.kind, k.value, k.verified_at FROM kumi_ident_back k JOIN person p ON p.id = k.person_id AND p.redacted_at IS NULL WHERE k.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth_identity x WHERE x.person_id = k.person_id AND x.kind = k.kind) ON CONFLICT DO NOTHING" < "$g/idents_back" || failed=1
  fi
  if [ -s "$g/contact" ] && has_table person; then
    psql_kumi -c "CREATE TEMP TABLE kumi_contact (id uuid, email text, phone text, own_login boolean)" -c "COPY kumi_contact FROM STDIN" \
      -c "UPDATE person x SET email = CASE WHEN g.email IS NULL OR NOT EXISTS (SELECT 1 FROM person o WHERE o.id <> x.id AND lower(o.email) = lower(g.email)) THEN g.email ELSE x.email END, phone = CASE WHEN g.phone IS NULL OR NOT EXISTS (SELECT 1 FROM person o WHERE o.id <> x.id AND o.phone = g.phone) THEN g.phone ELSE x.phone END, own_login = x.own_login AND g.own_login, version = x.version + 1 FROM kumi_contact g WHERE x.id = g.id AND x.redacted_at IS NULL AND (x.email IS DISTINCT FROM g.email OR x.phone IS DISTINCT FROM g.phone OR (x.own_login AND NOT g.own_login))" < "$g/contact" || failed=1
  fi
  if [ -s "$g/consents" ] && has_table channel_consent; then
    psql_kumi -c "CREATE TEMP TABLE kumi_consent (id uuid, person_id uuid, channel text, purpose text, granted boolean, source text, form_version text, evidence jsonb, at timestamptz, addr text)" -c "COPY kumi_consent FROM STDIN" \
      -c "INSERT INTO channel_consent (id, person_id, channel, purpose, granted, source, form_version, evidence, at) SELECT c.id, c.person_id, c.channel, c.purpose, c.granted, c.source, c.form_version, c.evidence, c.at FROM kumi_consent c JOIN person p ON p.id = c.person_id WHERE NOT EXISTS (SELECT 1 FROM channel_consent x WHERE x.id = c.id) AND (NOT c.granted OR c.addr IS NOT DISTINCT FROM CASE c.channel WHEN 'sms' THEN p.phone WHEN 'email' THEN p.email END)" < "$g/consents" || failed=1
  fi
  if [ -s "$g/cards" ] && has_table family_card; then
    psql_kumi -c "CREATE TEMP TABLE kumi_card (id uuid, removed_at timestamptz)" -c "COPY kumi_card FROM STDIN" \
      -c "UPDATE family_card x SET status = 'removed', removed_at = coalesce(x.removed_at, g.removed_at), saved_customer = NULL, saved_method = NULL, version = x.version + 1 FROM kumi_card g WHERE x.id = g.id AND x.status <> 'removed'" < "$g/cards" || failed=1
  fi
  if [ -s "$g/push" ] && has_table push_subscription; then
    psql_kumi -c "CREATE TEMP TABLE kumi_push (endpoint text, person_id uuid, revoked_at timestamptz)" -c "COPY kumi_push FROM STDIN" \
      -c "UPDATE push_subscription x SET revoked_at = now() WHERE x.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM kumi_push g WHERE g.endpoint = x.endpoint AND g.person_id = x.person_id AND g.revoked_at IS NULL)" < "$g/push" || failed=1
  fi
  if [ -s "$g/gifts" ] && has_table gift_card; then
    psql_kumi -c "CREATE TEMP TABLE kumi_gift (id uuid, status text, redeemed_by uuid, redeemed_at timestamptz, voided_at timestamptz)" -c "COPY kumi_gift FROM STDIN" \
      -c "WITH done AS (UPDATE gift_card x SET status = g.status, redeemed_by = (SELECT p.id FROM person p WHERE p.id = g.redeemed_by), redeemed_at = g.redeemed_at, voided_at = g.voided_at, version = x.version + 1 FROM kumi_gift g WHERE x.id = g.id AND x.status NOT IN ('redeemed', 'void') AND (g.status = 'void' OR EXISTS (SELECT 1 FROM person p WHERE p.id = g.redeemed_by)) RETURNING x.id, x.status, x.redeemed_by, x.amount_cents), moves AS (SELECT gen_random_uuid() AS txn_id, d.* FROM done d WHERE d.status = 'redeemed' AND d.redeemed_by IS NOT NULL), run AS (INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at) SELECT gen_random_uuid(), 'restore.carry', 1, 'restore', '{}', jsonb_build_object('title', jsonb_build_object('en', 'Carried over after a restore', 'es', 'Traído tras una restauración')), 'applied', 'none', '{}', now(), now() WHERE EXISTS (SELECT 1 FROM moves) RETURNING id), acct AS (INSERT INTO ledger_account (id, kind, person_id) SELECT gen_random_uuid(), 'member_credit', m.redeemed_by FROM moves m ON CONFLICT DO NOTHING RETURNING id, person_id), txn AS (INSERT INTO ledger_txn (id, kind, action_run_id, memo) SELECT m.txn_id, 'gift_card_redeemed', (SELECT id FROM run), 'gift card redeemed before a restore, carried over' FROM moves m RETURNING id), ent AS (INSERT INTO ledger_entry (txn_id, account_id, amount_cents) SELECT m.txn_id, (SELECT a.id FROM ledger_account a WHERE a.kind = 'gift_cards' AND a.person_id IS NULL AND a.revenue_type IS NULL), m.amount_cents FROM moves m UNION ALL SELECT m.txn_id, coalesce((SELECT c.id FROM acct c WHERE c.person_id = m.redeemed_by), (SELECT a.id FROM ledger_account a WHERE a.kind = 'member_credit' AND a.person_id = m.redeemed_by)), -m.amount_cents FROM moves m RETURNING 1) SELECT count(*) AS n FROM done" < "$g/gifts" || failed=1
  fi
  if [ -s "$g/payouts" ] && has_table credit_payout; then
    psql_kumi -c "CREATE TEMP TABLE kumi_payout (id uuid, person_id uuid, amount_cents int, method text, note text, at timestamptz)" -c "COPY kumi_payout FROM STDIN" \
      -c "WITH todo AS (SELECT t.* FROM (SELECT g.*, sum(g.amount_cents) OVER (PARTITION BY g.person_id ORDER BY g.at, g.id) AS upto FROM kumi_payout g JOIN person p ON p.id = g.person_id WHERE NOT EXISTS (SELECT 1 FROM credit_payout x WHERE x.id = g.id)) t WHERE t.upto <= coalesce((SELECT b.cents FROM member_credit_balance b WHERE b.person_id = t.person_id), 0)), run AS (INSERT INTO action_run (id, action, action_version, via, input, plan, status, undo_kind, read_versions, plan_expires_at, applied_at) SELECT gen_random_uuid(), 'restore.carry', 1, 'restore', '{}', jsonb_build_object('title', jsonb_build_object('en', 'Carried over after a restore', 'es', 'Traído tras una restauración')), 'applied', 'none', '{}', now(), now() WHERE EXISTS (SELECT 1 FROM todo) RETURNING id), acc AS (INSERT INTO ledger_account (id, kind) SELECT gen_random_uuid(), k FROM (VALUES ('cash_drawer'), ('provider_clearing')) v(k) WHERE EXISTS (SELECT 1 FROM todo) ON CONFLICT DO NOTHING RETURNING id, kind), ins AS (INSERT INTO credit_payout (id, person_id, amount_cents, method, note, action_run_id, at) SELECT t.id, t.person_id, t.amount_cents, t.method, t.note, (SELECT id FROM run), t.at FROM todo t RETURNING id, person_id, amount_cents, method), moves AS (SELECT gen_random_uuid() AS txn_id, i.* FROM ins i), txn AS (INSERT INTO ledger_txn (id, kind, action_run_id, memo) SELECT m.txn_id, 'credit_payout', (SELECT id FROM run), 'club credit paid out before a restore, carried over' FROM moves m RETURNING id), ent AS (INSERT INTO ledger_entry (txn_id, account_id, amount_cents) SELECT m.txn_id, (SELECT a.id FROM ledger_account a WHERE a.kind = 'member_credit' AND a.person_id = m.person_id), m.amount_cents FROM moves m UNION ALL SELECT m.txn_id, coalesce((SELECT c.id FROM acc c WHERE c.kind = CASE m.method WHEN 'cash' THEN 'cash_drawer' ELSE 'provider_clearing' END), (SELECT a.id FROM ledger_account a WHERE a.kind = CASE m.method WHEN 'cash' THEN 'cash_drawer' ELSE 'provider_clearing' END AND a.person_id IS NULL AND a.revenue_type IS NULL)), -m.amount_cents FROM moves m RETURNING 1) SELECT count(*) AS n FROM ins" < "$g/payouts" || failed=1
  fi
  if [ -s "$g/passes" ] && has_table pass; then
    psql_kumi -c "CREATE TEMP TABLE kumi_pass (id uuid, status text, refunded_at timestamptz, uses_left int)" -c "COPY kumi_pass FROM STDIN" \
      -c "UPDATE pass x SET status = CASE WHEN g.status = 'refunded' THEN 'refunded' ELSE x.status END, refunded_at = coalesce(x.refunded_at, g.refunded_at), uses_left = CASE WHEN g.status = 'refunded' THEN 0 ELSE least(g.uses_left, x.uses) END, version = x.version + 1 FROM kumi_pass g WHERE x.id = g.id AND x.status <> 'pending' AND (x.uses_left <> CASE WHEN g.status = 'refunded' THEN 0 ELSE least(g.uses_left, x.uses) END OR (g.status = 'refunded' AND x.status <> 'refunded'))" < "$g/passes" || failed=1
  fi
  if [ -s "$g/pass_returns" ] && has_table pass_use; then
    psql_kumi -c "CREATE TEMP TABLE kumi_pass_ret (id uuid, returned_at timestamptz)" -c "COPY kumi_pass_ret FROM STDIN" \
      -c "UPDATE pass_use x SET returned_at = g.returned_at FROM kumi_pass_ret g WHERE x.id = g.id AND x.returned_at IS NULL" < "$g/pass_returns" || failed=1
  fi
  if [ -s "$g/promos_off" ] && has_table promo_code; then
    psql_kumi -c "CREATE TEMP TABLE kumi_promo_off (id uuid)" -c "COPY kumi_promo_off FROM STDIN" \
      -c "UPDATE promo_code x SET active = false, version = x.version + 1 FROM kumi_promo_off g WHERE x.id = g.id AND x.active" < "$g/promos_off" || failed=1
  fi
  if [ -s "$g/promo_uses" ] && has_table promo_use_before_restore; then
    psql_kumi -c "CREATE TEMP TABLE kumi_promo_use (promo_code_id uuid, person_id uuid, n int)" -c "COPY kumi_promo_use FROM STDIN" \
      -c "INSERT INTO promo_use_before_restore AS b (promo_code_id, person_id, n) SELECT g.promo_code_id, g.person_id, g.n - (SELECT count(*) FROM promo_use u JOIN payment p ON p.id = u.payment_id WHERE u.promo_code_id = g.promo_code_id AND u.person_id = g.person_id AND p.status <> 'failed') FROM kumi_promo_use g JOIN promo_code c ON c.id = g.promo_code_id JOIN person pe ON pe.id = g.person_id WHERE g.n > (SELECT count(*) FROM promo_use u JOIN payment p ON p.id = u.payment_id WHERE u.promo_code_id = g.promo_code_id AND u.person_id = g.person_id AND p.status <> 'failed') ON CONFLICT (promo_code_id, person_id) DO UPDATE SET n = greatest(b.n, excluded.n)" < "$g/promo_uses" || failed=1
  fi
  while read -r t k c; do
    [ -s "$g/rev.$t.$c" ] && has_column "$t" "$c" || continue
    psql_kumi -c "CREATE TEMP TABLE kumi_rev (k text, at timestamptz)" -c "COPY kumi_rev FROM STDIN" \
      -c "UPDATE $t x SET $c = r.at FROM kumi_rev r WHERE x.$k::text = r.k AND x.$c IS NULL" < "$g/rev.$t.$c" || failed=1
  done <<< "$REVOKED"
  # Card payments and refunds the provider has from after the snapshot: looked up when the server starts (payments_after_restore.ts).
  if has_table restore_check; then psql_kumi -c "INSERT INTO restore_check (since) SELECT coalesce((SELECT max(created_at) FROM payment), now() - interval '400 days')" || failed=1; fi
  # Every part is tried; any that failed is said by the caller.
  return $failed
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
# The kumi command: written beside it and moved into place, so a running one (sudo kumi update runs this) keeps
# reading its own text.
cat > /usr/local/bin/kumi.new <<'SH'
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
      # The file is the club's whole database: in a folder only the postgres user can open (kumi pitr makes it 600 too).
      shift; install -d -m 700 -o postgres -g postgres /var/lib/postgresql/kumi-pitr; f=/var/lib/postgresql/kumi-pitr/kumi-pitr-$(date -u +%Y%m%dT%H%M%SZ).dump
      (cd /opt/kumi/app && runuser -u postgres -- env DATABASE_URL='postgresql://kumi@/kumi?host=/var/run/postgresql' /usr/local/bin/node apps/server/src/cli.ts pitr extract --out="$f" "$@") || { rm -f "$f"; exit 2; }
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
    # The archive is the postgres user's: its jobs run as that user (kumi pitr status and conf don't need to). In the
    # club's database they're the kumi role, never Postgres's superuser (the ident map below lets them be).
    case "${2:-}" in tick|test|extract)
      root pitr; cd /opt/kumi/app && exec runuser -u postgres -- env DATABASE_URL='postgresql://kumi@/kumi?host=/var/run/postgresql' /usr/local/bin/node apps/server/src/cli.ts "$@";;
    esac;;
esac
cd /opt/kumi/app || exit 1
exec sudo -u kumi KUMI_CALLER_DIR="$OLDPWD" sh -c 'set -a; . /etc/kumi/kumi.env; set +a; exec /usr/local/bin/node apps/server/src/cli.ts "$@"' kumi "$@"
SH
chmod 755 /usr/local/bin/kumi.new && mv -f /usr/local/bin/kumi.new /usr/local/bin/kumi
# openpadel: the same command under the software's name; kumi keeps working for whatever already uses it.
ln -sfn /usr/local/bin/kumi /usr/local/bin/openpadel
# Nightly backup at 3:17 on the club's clock (off the hour): the dump and its manifest, kept 14 days, and the
# offsite copy if set up. The backup and the restore test run the club's code as the kumi user, so they get the
# server's sandbox: they write only in the backups folder, with a /tmp of their own. The timer ticks hourly and `--scheduled` runs it only when it's due, so the time follows
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
ReadWritePaths=/var/backups/kumi
ExecStart=/usr/local/bin/node apps/server/src/cli.ts backup --scheduled
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
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
ReadWritePaths=/var/backups/kumi
ExecStart=/usr/local/bin/node apps/server/src/cli.ts restore-test --scheduled
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
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
# user, whose archive it is. They read and write the club's database as the kumi role, never as Postgres's superuser:
# a superuser session in a database the kumi role owns would run whatever it left there (a trigger, a function) with
# the superuser's rights. Postgres lets the postgres user sign in as kumi, to the kumi database only (Kumi's own
# pg_hba and pg_ident files, which Postgres's own include; Postgres 16 and later read include lines). The files are
# written beside Postgres's with install, which replaces a link rather than following it.
pg_etc=/etc/postgresql/17/main
if [ -f "$pg_etc/pg_hba.conf" ] && [ -f "$pg_etc/pg_ident.conf" ]; then
  t=$(mktemp)
  printf '%s\n' "# Kumi (deploy/server-setup.sh): the postgres user's point-in-time jobs sign in to the kumi database as kumi." "local kumi kumi peer map=kumi" > "$t"
  install -m 640 -o postgres -g postgres "$t" "$pg_etc/kumi_hba.conf"
  printf '%s\n' "# Kumi (deploy/server-setup.sh): kumi as itself, and the postgres user as kumi (pg_hba.conf allows it only for the kumi database)." "kumi kumi kumi" "kumi postgres kumi" > "$t"
  install -m 640 -o postgres -g postgres "$t" "$pg_etc/kumi_ident.conf"
  rm -f "$t"
  # First in pg_hba.conf (its first matching line wins); anywhere in pg_ident.conf. sed -i replaces the file, never a link's target.
  grep -qx 'include_if_exists kumi_hba.conf' "$pg_etc/pg_hba.conf" || sed -i '1i include_if_exists kumi_hba.conf' "$pg_etc/pg_hba.conf"
  if ! grep -qx 'include_if_exists kumi_ident.conf' "$pg_etc/pg_ident.conf"; then
    if [ -s "$pg_etc/pg_ident.conf" ]; then sed -i '1i include_if_exists kumi_ident.conf' "$pg_etc/pg_ident.conf"
    else t=$(mktemp); echo 'include_if_exists kumi_ident.conf' > "$t"; install -m 640 -o postgres -g postgres "$t" "$pg_etc/pg_ident.conf"; rm -f "$t"; fi
  fi
  systemctl reload postgresql
  runuser -u postgres -- psql -XAtc 'SELECT 1' 'postgresql://kumi@/kumi?host=/var/run/postgresql' >/dev/null 2>&1 \
    || echo "kumi: the postgres user can't sign in to the kumi database as kumi (pg_hba.conf, pg_ident.conf), so the point-in-time jobs will fail; kumi doctor says so"
fi
cat > /etc/systemd/system/kumi-pitr.service <<'UNIT'
[Unit]
Description=Kumi point-in-time archive: the nightly base backup, when it's due
After=postgresql.service
ConditionPathExists=/etc/pgbackrest/pgbackrest.conf
[Service]
Type=oneshot
User=postgres
WorkingDirectory=/opt/kumi/app
Environment=DATABASE_URL=postgresql://kumi@/kumi?host=/var/run/postgresql
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
Environment=DATABASE_URL=postgresql://kumi@/kumi?host=/var/run/postgresql
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
    # stanza-create takes the archive's lock, so it's refused ([050]) while Postgres is sending a piece of its log
    # through archive-push: wait a moment and try again, and say the archive isn't ready only if it still isn't.
    n=0
    while :; do
      if out=$(runuser -u postgres -- pgbackrest --stanza=kumi --log-level-console=warn stanza-create 2>&1); then [ -z "$out" ] || printf '%s\n' "$out"; break; fi
      n=$((n + 1))
      case "$out" in *"[050]"*) if [ "$n" -lt 6 ]; then sleep 5; continue; fi ;; esac
      printf '%s\n' "$out"; echo "kumi: the point-in-time archive isn't ready (above); kumi doctor says what's wrong"; break
    done
    systemctl start --no-block kumi-pitr.service || true   # the first base backup, if there's none yet
  fi
  rm -f "$t"
fi
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
  # Built: now root's, read-only to everyone else, nothing setuid, before anything uses it (chown -R doesn't follow
  # links in it).
  [ -z "$AS" ] || { chown -R root:root "$dir.new"; chmod -R u+rwX,go+rX,go-w,ug-s "$dir.new"; }
  rm -rf "$dir"; mv "$dir.new" "$dir"

  # 2. Caddy's config from the new release (the paths it answers on), checked before anything switches. A config
  #    changed by hand is left as it is.
  local caddy=""
  if caddy_ours "$old" || caddy_ours "$new"; then
    caddy=$(caddy_next "$new") || die "Caddy refused $new's config (above); nothing changed, still on $old"
  elif [ -f "$CADDYFILE" ]; then
    say "Caddy's config ($CADDYFILE) was changed by hand, so it's left as it is: paths $new answers on that aren't there need adding (or run server-setup.sh again)"
  fi

  # 3. A snapshot of the database as it is now, named for the update.
  local snap; snap="$BACKUPS/update-$old-to-$new-$(date -u +%Y%m%dT%H%M%SZ).dump"
  snapshot "$snap" || { [ -z "$caddy" ] || rm -f "$caddy"; die "couldn't take a snapshot of the database; nothing changed, still on $old"; }
  say "database snapshot: $snap"

  # 4. Switch and start: database changes apply as the server starts. 5. Check it answers as the new release, then
  #    Caddy takes the new config.
  state_set "$new" "$old" "$snap"
  switch_to "$new"
  if $RESTART && check "$new" && caddy_use "$caddy"; then
    install_system_files
    tidy
    say "now running $new (was $old). If something's wrong: sudo kumi rollback --yes"
    return 0
  fi

  # It didn't come up: the old release, and the database from the snapshot (the new one may have changed it).
  [ -z "$caddy" ] || rm -f "$caddy"
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
  # Caddy back on the previous release's config (its paths), if the one there is still Kumi's.
  if caddy_ours "$cur"; then
    local caddy; caddy=$(caddy_next "$prev") && caddy_use "$caddy" || say "Caddy keeps the config $cur had (see above)"
  fi
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
exit
}
