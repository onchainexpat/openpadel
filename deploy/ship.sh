#!/usr/bin/env bash
# Ship the committed code (HEAD) to a server set up with server-setup.sh: install, build both apps,
# switch over and restart. Migrations run when the server starts.
set -euo pipefail
target="${1:?usage: deploy/ship.sh root@server [ssh options...]}"; shift
cd "$(git rev-parse --show-toplevel)"
rev=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain -- apps packages migrations package.json package-lock.json)" ] || echo "note: uncommitted changes are not shipped, only $rev"
git archive --format=tar HEAD | ssh "$@" "$target" "set -e
  rm -rf /opt/kumi/app.new && install -d -o kumi -g kumi /opt/kumi/app.new
  tar -x -C /opt/kumi/app.new && echo $rev > /opt/kumi/app.new/REVISION && chown -R kumi:kumi /opt/kumi/app.new
  cd /opt/kumi/app.new
  sudo -u kumi HOME=/opt/kumi npm ci --no-audit --no-fund --loglevel=error
  sudo -u kumi HOME=/opt/kumi npm run build -w @kumi/member -w @kumi/manager --silent
  rm -rf /opt/kumi/app.old; [ -d /opt/kumi/app ] && mv /opt/kumi/app /opt/kumi/app.old; mv /opt/kumi/app.new /opt/kumi/app
  systemctl restart kumi; sleep 3; systemctl is-active kumi
  curl -fsS http://127.0.0.1:8790/health && echo ' shipped $rev'"
