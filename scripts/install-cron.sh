#!/bin/sh
# Installs the nightly backup (02:15) in the current user's crontab. Safe to re-run. Run it from the repo directory on the server.
# Usage: sh scripts/install-cron.sh            install
#        sh scripts/install-cron.sh --print    only show the line
set -eu
DIR="$(pwd)"
LINE="15 2 * * * cd $DIR && sh scripts/backup.sh >> $DIR/backups/backup.log 2>&1"
[ "${1:-}" = "--print" ] && { echo "$LINE"; exit 0; }
mkdir -p "$DIR/backups"
( crontab -l 2>/dev/null | grep -vF "scripts/backup.sh" || true; echo "$LINE" ) | crontab -
echo "installed:"; crontab -l | grep -F "scripts/backup.sh"
