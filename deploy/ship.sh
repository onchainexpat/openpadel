#!/usr/bin/env bash
# Ship the committed code (HEAD) to a server set up with server-setup.sh. The release's own deploy/release.sh
# installs it beside the running one, snapshots the database, switches over and checks it; if the new release
# doesn't come up, it puts the old release and the database back. Migrations run when the server starts.
set -euo pipefail
target="${1:?usage: deploy/ship.sh root@server [ssh options...]}"; shift
cd "$(git rev-parse --show-toplevel)"
rev=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain -- apps packages migrations deploy package.json package-lock.json)" ] || echo "note: uncommitted changes are not shipped, only $rev"
git archive --format=tar HEAD | ssh "$@" "$target" "set -e
  t=\$(mktemp -d); trap 'rm -rf \$t' EXIT
  cat > \$t/kumi-$rev.tar
  tar -xOf \$t/kumi-$rev.tar deploy/release.sh > \$t/release.sh
  bash \$t/release.sh update \$t/kumi-$rev.tar $rev"
